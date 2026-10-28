import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Reuse history only from the same repository, workflow and explicitly trusted branches. Never trust
// pull-request artifacts, including same-repository PRs with write permissions.
export function trustedRun(run, current) {
  return (
    run.repository?.full_name === current.repository &&
    run.head_repository?.full_name === current.repository &&
    run.path === current.workflow &&
    (current.branches ?? [current.branch]).includes(run.head_branch) &&
    run.status === 'completed' &&
    ['push', 'schedule', 'workflow_dispatch'].includes(run.event) &&
    /^[a-f0-9]{40}$/.test(run.head_sha ?? '') &&
    String(run.id) !== current.runId
  );
}

export async function findHistory(get, current) {
  let latest;
  for (let page = 1; ; page++) {
    const { workflow_runs: runs } = await get(
      `actions/workflows/${encodeURIComponent(current.workflow.split('/').at(-1))}/runs?status=completed&per_page=100&page=${page}`,
    );
    for (const run of runs) {
      if (!trustedRun(run, current)) continue;
      // A same-named tag or rewritten branch must not introduce unrelated history.
      const comparison = await get(`compare/${run.head_sha}...${current.sha}`);
      if (!['ahead', 'identical'].includes(comparison.status)) continue;
      for (let artifactPage = 1; ; artifactPage++) {
        const { artifacts } = await get(
          `actions/runs/${run.id}/artifacts?per_page=100&page=${artifactPage}`,
        );
        for (const artifact of artifacts) {
          if (
            !artifact.expired &&
            /^midscene-e2e-report-pages-\d+$/.test(artifact.name) &&
            Number.isFinite(Date.parse(artifact.created_at)) &&
            (!latest ||
              Date.parse(artifact.created_at) > Date.parse(latest.created_at))
          ) {
            latest = { ...artifact, runId: run.id };
          }
        }
        if (artifacts.length < 100) break;
      }
    }
    if (runs.length < 100) return latest;
  }
}

async function main() {
  const env = process.env;
  if (!env.GITHUB_REF?.startsWith('refs/heads/'))
    throw new Error('Pages publication requires a branch ref');
  const workflow = env.GITHUB_WORKFLOW_REF?.slice(
    `${env.GITHUB_REPOSITORY}/`.length,
  ).split('@')[0];
  if (!workflow?.startsWith('.github/workflows/'))
    throw new Error('Missing workflow identity');
  const current = {
    repository: env.GITHUB_REPOSITORY,
    workflow,
    branch: env.GITHUB_REF_NAME,
    branches: (env.HISTORY_BRANCHES || env.GITHUB_REF_NAME)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    runId: env.GITHUB_RUN_ID,
    sha: env.GITHUB_SHA,
  };
  const get = async (resource) => {
    const response = await fetch(
      `${env.GITHUB_API_URL}/repos/${current.repository}/${resource}`,
      {
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    if (!response.ok)
      throw new Error(`GitHub history request failed: HTTP ${response.status}`);
    return response.json();
  };
  const latest = await findHistory(get, current);
  if (latest)
    await appendFile(
      env.GITHUB_OUTPUT,
      `name=${latest.name}\nrun_id=${latest.runId}\n`,
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
