import assert from 'node:assert/strict';
import test from 'node:test';
import { findHistory, trustedRun } from './history.mjs';
const current = {
  repository: 'owner/repo',
  workflow: '.github/workflows/e2e.yml',
  branch: 'main',
  runId: '10',
  sha: 'b'.repeat(40),
};
const run = {
  id: 9,
  repository: { full_name: 'owner/repo' },
  head_repository: { full_name: 'owner/repo' },
  path: current.workflow,
  head_branch: 'main',
  status: 'completed',
  event: 'push',
  head_sha: 'a'.repeat(40),
};
test('history excludes PRs, foreign producers, other branches/workflows and the current run', () => {
  assert(trustedRun(run, current));
  for (const patch of [
    { event: 'pull_request' },
    { event: 'pull_request_target' },
    { head_repository: { full_name: 'other/repo' } },
    { repository: { full_name: 'other/repo' } },
    { head_branch: 'feature' },
    { path: '.github/workflows/other.yml' },
    { status: 'in_progress' },
    { id: 10 },
    { head_sha: 'bad' },
  ])
    assert.equal(trustedRun({ ...run, ...patch }, current), false);
});
test('history picks the newest nonexpired snapshot and rejects unrelated ancestry', async () => {
  const get = async (resource) => {
    if (resource.includes('/runs?')) return { workflow_runs: [run] };
    if (resource.startsWith('compare/')) return { status: 'ahead' };
    return {
      artifacts: [
        {
          name: 'midscene-e2e-report-pages-1',
          created_at: '2026-01-01T00:00:00Z',
          expired: false,
        },
        {
          name: 'midscene-e2e-report-pages-2',
          created_at: '2026-01-02T00:00:00Z',
          expired: false,
        },
        {
          name: 'midscene-e2e-report-pages-3',
          created_at: '2026-01-03T00:00:00Z',
          expired: true,
        },
        { name: 'other', created_at: '2026-01-04T00:00:00Z', expired: false },
      ],
    };
  };
  assert.equal(
    (await findHistory(get, current)).name,
    'midscene-e2e-report-pages-2',
  );
  assert.equal(
    await findHistory(
      (r) => (r.startsWith('compare/') ? { status: 'diverged' } : get(r)),
      current,
    ),
    undefined,
  );
});
test('history paginates runs and artifacts', async () => {
  const get = async (resource) => {
    if (resource.includes('/runs?'))
      return {
        workflow_runs: resource.endsWith('page=1')
          ? Array.from({ length: 100 }, () => ({
              ...run,
              event: 'pull_request',
            }))
          : [run],
      };
    if (resource.startsWith('compare/')) return { status: 'identical' };
    return {
      artifacts: resource.endsWith('page=1')
        ? Array.from({ length: 100 }, () => ({ name: 'other' }))
        : [
            {
              name: 'midscene-e2e-report-pages-1',
              created_at: '2026-01-01T00:00:00Z',
              expired: false,
            },
          ],
    };
  };
  assert.equal((await findHistory(get, current)).runId, 9);
});

test('additional history branches require explicit caller trust', () => {
  const feature = { ...run, head_branch: 'feature' };
  assert.equal(trustedRun(feature, current), false);
  assert.equal(
    trustedRun(feature, { ...current, branches: ['main', 'feature'] }),
    true,
  );
});
