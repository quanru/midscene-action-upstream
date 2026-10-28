import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const cell = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('|', '&#124;')
    .replace(/[\r\n]+/g, ' ');

// Read the same embedded data consumed by the native report UI. Images are
// relative to the published index, not paths in the producer's checkout.
export function renderCloudflareSummary(html, pageUrl, producerResult) {
  const base = new URL(pageUrl.endsWith('/') ? pageUrl : `${pageUrl}/`);
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('Invalid published report URL');
  let run;
  const executions = new Map();
  for (const [, attributes, body] of html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/g,
  )) {
    if (/\btype="midscene_test_run_dump"/.test(attributes)) {
      if (run) throw new Error('Expected one native test run');
      run = JSON.parse(body);
    } else if (/\btype="midscene_web_dump"/.test(attributes)) {
      const reportId = /\bdata-report-id="([^"]+)"/.exec(attributes)?.[1];
      const dump = JSON.parse(body);
      for (const execution of dump.executions ?? [])
        executions.set(`${reportId}:${execution.id}`, execution);
    }
  }
  if (!run?.projects)
    throw new Error('Native test run data is missing from the HTML report');
  const imageFor = (step) => {
    for (const detail of [...(step?.agentDetails ?? [])].reverse()) {
      const execution = executions.get(
        `${detail.reportId}:${detail.executionId}`,
      );
      for (const task of [...(execution?.tasks ?? [])].reverse()) {
        const shots = [...(task.recorder ?? [])]
          .reverse()
          .map((item) => item.screenshot)
          .concat(task.uiContext?.screenshot);
        for (const shot of shots) {
          if (
            shot?.storage === 'file' &&
            /^(?:\.\/)?screenshots\/[A-Za-z0-9._-]+\.(?:png|jpe?g|webp)$/.test(
              shot.path ?? '',
            )
          )
            return new URL(shot.path, base).href;
        }
      }
    }
    return null;
  };
  const rows = [];
  for (const project of run.projects) {
    for (const document of project.documents ?? []) {
      for (const testCase of document.cases ?? []) {
        const attempt = testCase.attempts?.at(-1);
        const steps = [
          ...(attempt?.beforeEach ?? []),
          ...(attempt?.steps ?? []),
          ...(attempt?.afterEach ?? []),
        ];
        const failed = steps.find((step) =>
          ['failed', 'timeout', 'error'].includes(step.status),
        );
        const step =
          failed ??
          [...steps].reverse().find((item) => item.agentDetails?.length);
        const target = new URL(base);
        if (step?.id)
          target.hash = new URLSearchParams({
            'runner-step': step.id,
          }).toString();
        const shot = imageFor(step);
        const image = shot
          ? `<a href="${cell(target.href)}"><img src="${cell(shot)}" alt="${cell(testCase.name)}" width="160"></a>`
          : 'No screenshot captured';
        const passed = testCase.status === 'success';
        const reason = failed?.error?.message;
        rows.push({
          passed,
          text: `| ${cell(project.name)} | ${cell(testCase.name)} | ${image} | ${passed ? '✅ Passed' : `❌ ${cell(testCase.status)}`}${reason ? `: ${cell(reason)}` : ''} | ${attempt ? `${(attempt.durationMs / 1000).toFixed(1)}s` : '—'} | [Open report](${target.href}) |`,
        });
      }
    }
  }
  const passed = rows.filter((row) => row.passed).length;
  const allPassed =
    rows.length > 0 &&
    passed === rows.length &&
    run.status === 'success' &&
    producerResult === 'success';
  const lines = [
    '## Midscene E2E',
    '',
    `**${passed}/${rows.length} passed · ${allPassed ? '✅ Passed' : '⚠️ Needs attention'}**`,
    '',
    `[Open the Midscene Test report ↗](${base.href})`,
    '',
  ];
  for (const [title, selected] of [
    ['Needs attention', rows.filter((row) => !row.passed)],
    ['Passed cases', rows.filter((row) => row.passed)],
  ]) {
    if (selected.length)
      lines.push(
        `### ${title} (${selected.length})`,
        '',
        '| Project | Case | Screenshot | Status / reason | Duration | Report |',
        '|:--|:--|:--|:--|--:|:--|',
        ...selected.map((row) => row.text),
        '',
      );
  }
  return lines.join('\n');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const html = await readFile(process.env.REPORT_FILE, 'utf8');
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    renderCloudflareSummary(
      html,
      process.env.PAGE_URL,
      process.env.PRODUCER_RESULT,
    ),
  );
}
