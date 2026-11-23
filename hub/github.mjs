// Delivery statistics per project from GitHub, through the `gh` CLI already signed in on the hub's
// machine (no token is handled here): pull requests and contributors over the last 24 hours and
// 7 days, and the four DORA metrics from production deploy runs.
//
// Projects are found on their own: every git checkout in ~/projects whose origin is on GitHub,
// named after its folder (the name Orca gives the repo). ~/.config/agent-trace-hub/repos.json can
// add or override entries: [{ "project": "kyc", "repo": "owner/name", "prodBranch": "main",
// "deployWorkflow": "deploy.yml" }].
//
// How the DORA metrics are read (proxies, stated in the view):
//   deployment frequency   successful runs of the deploy workflow on the production branch
//   lead time for changes  pull request opened → merged (median), for PRs merged in the window
//   change failure rate    failed deploy runs / finished deploy runs
//   time to restore        a failed deploy run → the next successful one (median)
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const WINDOWS = [
  { key: '24h', ms: 86_400_000 },
  { key: '7d', ms: 7 * 86_400_000 },
];
const REFRESH_MS = 5 * 60_000;
const PR_LIMIT = 500;
const RUN_LIMIT = 300;

export function ghRunner({ bin = 'gh', timeoutMs = 60_000 } = {}) {
  return (args) => new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split('\n')[0]));
      else resolve(stdout);
    });
  });
}

export function slugOf(url) {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

async function originOf(dir) {
  // Reads .git/config directly: no git process, and a worktree's .git file is skipped.
  try {
    const text = await readFile(join(dir, '.git', 'config'), 'utf8');
    const section = /\[remote "origin"\]([^[]*)/.exec(text);
    const url = section && /\burl\s*=\s*(\S+)/.exec(section[1]);
    return url ? url[1] : null;
  } catch {
    return null;
  }
}

export async function discoverProjects({ home }) {
  const out = new Map();
  const root = join(home, 'projects');
  for (const name of await readdir(root).catch(() => [])) {
    const repo = slugOf(await originOf(join(root, name)));
    if (repo) out.set(name, { project: name, repo, prodBranch: 'main', deployWorkflow: null });
  }
  try {
    const extra = JSON.parse(await readFile(join(home, '.config/agent-trace-hub/repos.json'), 'utf8'));
    for (const item of Array.isArray(extra) ? extra : []) {
      if (!item || typeof item.project !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(item.repo ?? '')) continue;
      out.set(item.project, { prodBranch: 'main', deployWorkflow: null, ...out.get(item.project), ...item });
    }
  } catch {
    // no override file
  }
  return [...out.values()];
}

const median = (values) => {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
};
const at = (iso) => (iso ? Date.parse(iso) : null);

// Pure: the statistics of one project for one window, from PRs and deploy runs as gh returns them.
export function summarize({ prs = [], runs = [], now, windowMs }) {
  const from = now - windowMs;
  const inWindow = (time) => time !== null && time >= from && time <= now;
  const opened = prs.filter((pr) => inWindow(at(pr.createdAt)));
  const merged = prs.filter((pr) => inWindow(at(pr.mergedAt)));
  const closed = prs.filter((pr) => !pr.mergedAt && inWindow(at(pr.closedAt)));
  const authors = new Map();
  const author = (pr) => pr.author?.login || 'unknown';
  const row = (login, isBot) => {
    if (!authors.has(login)) authors.set(login, { login, bot: isBot, opened: 0, merged: 0, additions: 0, deletions: 0 });
    return authors.get(login);
  };
  for (const pr of opened) row(author(pr), pr.author?.is_bot === true).opened += 1;
  for (const pr of merged) {
    const item = row(author(pr), pr.author?.is_bot === true);
    item.merged += 1;
    item.additions += pr.additions ?? 0;
    item.deletions += pr.deletions ?? 0;
  }
  const finished = runs
    .filter((run) => run.status === 'completed' && (run.conclusion === 'success' || run.conclusion === 'failure'))
    .map((run) => ({ ok: run.conclusion === 'success', end: at(run.updatedAt) ?? at(run.createdAt) }))
    .filter((run) => run.end !== null)
    .sort((a, b) => a.end - b.end);
  const deploys = finished.filter((run) => inWindow(run.end));
  const failures = deploys.filter((run) => !run.ok);
  const restores = failures.map((failure) => {
    const next = finished.find((run) => run.ok && run.end > failure.end);
    return next ? next.end - failure.end : null;
  });
  const days = windowMs / 86_400_000;
  return {
    prs: {
      opened: opened.length,
      merged: merged.length,
      closed: closed.length,
      open: prs.filter((pr) => pr.state === 'OPEN').length,
      additions: merged.reduce((sum, pr) => sum + (pr.additions ?? 0), 0),
      deletions: merged.reduce((sum, pr) => sum + (pr.deletions ?? 0), 0),
    },
    authors: [...authors.values()].sort((a, b) => b.merged - a.merged || b.opened - a.opened),
    dora: {
      deploys: deploys.length - failures.length,
      deploysPerDay: (deploys.length - failures.length) / days,
      leadTimeMs: median(merged.map((pr) => at(pr.mergedAt) - at(pr.createdAt))),
      changeFailureRate: deploys.length ? failures.length / deploys.length : null,
      failedDeploys: failures.length,
      timeToRestoreMs: median(restores.filter((value) => value !== null)),
      unrestored: restores.filter((value) => value === null).length,
    },
  };
}

// Sums window statistics of several projects (the "all projects" row).
export function combine(list, windowMs) {
  const out = { prs: { opened: 0, merged: 0, closed: 0, open: 0, additions: 0, deletions: 0 }, authors: [], dora: {} };
  const authors = new Map();
  let deploys = 0;
  let failed = 0;
  let unrestored = 0;
  const lead = [];
  const restore = [];
  for (const item of list) {
    for (const key of Object.keys(out.prs)) out.prs[key] += item.prs[key];
    for (const row of item.authors) {
      const sum = authors.get(row.login) ?? { ...row, opened: 0, merged: 0, additions: 0, deletions: 0 };
      for (const key of ['opened', 'merged', 'additions', 'deletions']) sum[key] += row[key];
      authors.set(row.login, sum);
    }
    deploys += item.dora.deploys;
    failed += item.dora.failedDeploys;
    unrestored += item.dora.unrestored;
    if (item.dora.leadTimeMs !== null) lead.push([item.dora.leadTimeMs, item.prs.merged]);
    if (item.dora.timeToRestoreMs !== null) restore.push([item.dora.timeToRestoreMs, item.dora.failedDeploys - item.dora.unrestored]);
  }
  // Medians of medians weighted by count: close enough for a summary row, and labelled as such.
  const weighted = (pairs) => {
    const total = pairs.reduce((sum, [, weight]) => sum + weight, 0);
    return total ? pairs.reduce((sum, [value, weight]) => sum + value * weight, 0) / total : null;
  };
  out.authors = [...authors.values()].sort((a, b) => b.merged - a.merged || b.opened - a.opened);
  out.dora = {
    deploys,
    deploysPerDay: deploys / (windowMs / 86_400_000),
    leadTimeMs: weighted(lead),
    changeFailureRate: deploys + failed ? failed / (deploys + failed) : null,
    failedDeploys: failed,
    timeToRestoreMs: weighted(restore),
    unrestored,
  };
  return out;
}

export function createGithubStats({ home, run = ghRunner(), now = () => Date.now(), log = () => {} } = {}) {
  let projects = [];
  let cache = { at: 0, byProject: new Map(), errors: {} };
  let inflight = null;

  async function deployRunsFor(project) {
    let workflow = project.deployWorkflow;
    let event = null;
    if (!workflow) {
      const list = JSON.parse(await run(['workflow', 'list', '-R', project.repo, '--json', 'name,path,state']));
      const active = list.filter((item) => item.state === 'active' && item.path.startsWith('.github/'));
      const deploy = active.find((item) => /(^|\/)deploy[^/]*\.ya?ml$/i.test(item.path)) ?? active.find((item) => /\bdeploy/i.test(item.name));
      const ci = active.find((item) => /(^|\/)ci\.ya?ml$/i.test(item.path)) ?? active.find((item) => /^ci$/i.test(item.name));
      // No deploy workflow: CI pushes to the production branch are taken as its deploys.
      workflow = deploy ? deploy.path.split('/').pop() : ci ? ci.path.split('/').pop() : null;
      event = deploy ? null : 'push';
    }
    if (!workflow) return { runs: [], source: null };
    const since = new Date(now() - WINDOWS.at(-1).ms - 7 * 86_400_000).toISOString().slice(0, 10);
    const args = ['run', 'list', '-R', project.repo, '-w', workflow, '-b', project.prodBranch || 'main', '--created', `>=${since}`, '--limit', String(RUN_LIMIT), '--json', 'conclusion,status,createdAt,updatedAt,event'];
    if (event) args.push('-e', event);
    return { runs: JSON.parse(await run(args)), source: `${workflow} on ${project.prodBranch || 'main'}${event ? ` (${event})` : ''}` };
  }

  async function fetchProject(project) {
    const since = new Date(now() - WINDOWS.at(-1).ms).toISOString().slice(0, 10);
    const [prs, deploys] = await Promise.all([
      run(['pr', 'list', '-R', project.repo, '--state', 'all', '--search', `updated:>=${since}`, '--limit', String(PR_LIMIT), '--json', 'number,author,createdAt,mergedAt,closedAt,state,additions,deletions,baseRefName']).then(JSON.parse),
      deployRunsFor(project),
    ]);
    return { prs, ...deploys };
  }

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      projects = await discoverProjects({ home });
      const byProject = new Map();
      const errors = {};
      await Promise.all(projects.map(async (project) => {
        try {
          byProject.set(project.project, { ...project, ...(await fetchProject(project)) });
        } catch (error) {
          errors[project.project] = String(error?.message ?? error).slice(0, 200);
          const old = cache.byProject.get(project.project);
          if (old) byProject.set(project.project, old);
        }
      }));
      for (const [name, message] of Object.entries(errors)) log(`github stats for ${name} failed: ${message}`);
      cache = { at: now(), byProject, errors };
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    refresh,
    start() {
      void refresh().catch((error) => log(`github stats failed: ${error.message}`));
      return setInterval(() => void refresh().catch((error) => log(`github stats failed: ${error.message}`)), REFRESH_MS).unref?.();
    },
    // { generatedAt, windows, projects: [{ project, repo, deploySource, windows: { '24h': …, '7d': … } }], total }
    async stats({ project = '' } = {}) {
      if (!cache.at) await refresh();
      const at = now();
      const rows = [...cache.byProject.values()]
        .filter((item) => !project || item.project === project)
        .sort((a, b) => a.project.localeCompare(b.project))
        .map((item) => ({
          project: item.project,
          repo: item.repo,
          deploySource: item.source,
          windows: Object.fromEntries(WINDOWS.map((window) => [window.key, summarize({ prs: item.prs, runs: item.runs, now: at, windowMs: window.ms })])),
        }));
      const total = Object.fromEntries(WINDOWS.map((window) => [window.key, combine(rows.map((row) => row.windows[window.key]), window.ms)]));
      return { generatedAt: at, fetchedAt: cache.at, windows: WINDOWS.map((window) => window.key), projects: rows, total, errors: cache.errors };
    },
  };
}
