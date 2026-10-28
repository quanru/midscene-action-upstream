import assert from 'node:assert/strict';
import test from 'node:test';
import { renderCloudflareSummary } from './cloudflare-summary.mjs';
const shot = { storage: 'file', path: './screenshots/selected.jpeg' };
function report(status = 'success', screenshot = shot) {
  const step = {
    id: 'attempt:steps:1',
    status,
    agentDetails: [{ reportId: 'r', executionId: 'e' }],
    error:
      status === 'success'
        ? undefined
        : { message: 'expected <Preview> | missing' },
  };
  const run = {
    status,
    projects: [
      {
        name: 'web',
        documents: [
          {
            cases: [
              {
                name: 'Example',
                status,
                attempts: [{ durationMs: 1234, steps: [step] }],
              },
              { name: 'Not run', status: 'not-run', attempts: [] },
            ],
          },
        ],
      },
    ],
  };
  const dump = {
    executions: [
      { id: 'e', tasks: [{ recorder: [{ screenshot }] }] },
      {
        id: 'unrelated',
        tasks: [
          {
            recorder: [
              {
                screenshot: { storage: 'file', path: 'screenshots/wrong.jpeg' },
              },
            ],
          },
        ],
      },
    ],
  };
  return `<script type="midscene_web_dump" data-report-id="r">${JSON.stringify(dump)}</script><script type="midscene_test_run_dump">${JSON.stringify(run)}</script>`;
}
test('links each case to its native step and publishes only its selected image', () => {
  const md = renderCloudflareSummary(
    report(),
    'https://run.worker.dev',
    'success',
  );
  assert.match(md, /https:\/\/run.worker.dev\/screenshots\/selected.jpeg/);
  assert.match(md, /runner-step=attempt%3Asteps%3A1/);
  assert.match(md, /No screenshot captured/);
  assert.doesNotMatch(md, /wrong.jpeg/);
  assert.match(md, /1\/2 passed/);
});
test('failure reason is escaped and producer failure remains visible', () => {
  const md = renderCloudflareSummary(
    report('failed'),
    'https://run.worker.dev/',
    'failure',
  );
  assert.match(md, /0\/2 passed/);
  assert.match(md, /Needs attention/);
  assert.match(md, /&lt;Preview&gt; &#124; missing/);
  const html =
    '<script type="midscene_test_run_dump">' +
    JSON.stringify({
      status: 'success',
      projects: [
        {
          name: 'web',
          documents: [
            { cases: [{ name: 'ok', status: 'success', attempts: [] }] },
          ],
        },
      ],
    }) +
    '</script>';
  assert.match(
    renderCloudflareSummary(html, 'https://run.worker.dev/', 'failure'),
    /Needs attention/,
  );
});
test('rejects unsafe URLs and never turns an escaping screenshot path into a link', () => {
  for (const url of [
    'javascript:alert(1)',
    'https://user:pass@host/',
    'https://host/?secret=x',
  ])
    assert.throws(() => renderCloudflareSummary(report(), url, 'success'));
  const md = renderCloudflareSummary(
    report('success', { storage: 'file', path: '../secret.png' }),
    'https://run.worker.dev/',
    'success',
  );
  assert.doesNotMatch(md, /secret.png/);
  assert.match(md, /No screenshot captured/);
});
test('missing or duplicate native runs cannot silently produce a passing table', () => {
  assert.throws(() =>
    renderCloudflareSummary(
      '<html></html>',
      'https://run.worker.dev/',
      'success',
    ),
  );
  assert.throws(() =>
    renderCloudflareSummary(
      report() + report(),
      'https://run.worker.dev/',
      'success',
    ),
  );
});
