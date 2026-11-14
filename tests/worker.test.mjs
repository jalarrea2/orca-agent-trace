import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeProjectDirNames } from '../src/node/transcripts.mjs';
import { start } from '../src/worker.mjs';
import { claude, demoScenario } from './fixtures.mjs';

// A stand-in for the `orca` object a worker gets, backed by the demo scenario.
function fakeOrca(demo, { without = [] } = {}) {
  const events = new Map();
  const hooks = new Map();
  const panels = new Map();
  const storage = new Map();
  const posts = [];
  const logs = [];
  const answers = {
    'settings.get': () => ({ settings: {} }),
    'storage.get': ({ key }) => ({ value: storage.get(key) ?? null }),
    'storage.set': ({ key, value }) => {
      storage.set(key, JSON.parse(JSON.stringify(value)));
      return { ok: true };
    },
    'workspace.readContext': () => demo.context,
    'workspace.list': () => ({ workspaces: [demo.workspace, { id: 'ws-other', kind: 'worktree', name: 'other', path: '/work/other', branch: 'main', hostId: 'local' }], truncated: false }),
    'agents.list': () => ({ agents: demo.agents }),
  };
  for (const method of without) delete answers[method];
  const register = (map) => (name, handler) => {
    map.set(name, handler);
    return { dispose: () => map.delete(name) };
  };
  return {
    events, hooks, panels, storage, posts, logs,
    orca: {
      api: { major: 1, minor: 6 },
      log: (message) => logs.push(message),
      host: {
        has: (method) => method in answers,
        call: async (method, params) => {
          if (!(method in answers)) throw Object.assign(new Error('no such method'), { code: 'unknown_method' });
          return answers[method](params ?? {});
        },
      },
      events: { on: register(events) },
      hooks: { on: register(hooks) },
      panels: { handle: register(panels), post: (event, payload) => posts.push({ event, payload }) },
    },
  };
}

async function writeScenario(home, demo) {
  const project = join(home, '.claude', 'projects', claudeProjectDirNames(demo.workspace.path)[0]);
  for (const session of demo.claudeSessions) {
    await mkdir(join(project, session.sessionId, 'subagents'), { recursive: true });
    await writeFile(join(project, `${session.sessionId}.jsonl`), `${session.lines.join('\n')}\n`);
    for (const [name, lines] of Object.entries(session.subagents)) {
      await writeFile(join(project, session.sessionId, 'subagents', `${name}.jsonl`), `${lines.join('\n')}\n`);
    }
  }
  const day = new Date();
  const folder = join(home, '.codex', 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  await mkdir(folder, { recursive: true });
  for (const session of demo.codexSessions) await writeFile(join(folder, `${session.file}.jsonl`), `${session.lines.join('\n')}\n`);
  // A session of another folder must not show up in this workspace.
  await writeFile(join(folder, 'rollout-elsewhere.jsonl'), `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: 'cx-else', cwd: '/work/other' } })}\n`);
  return project;
}

function emit(fake, demo) {
  for (const { at, event } of demo.toolEvents) fake.hooks.get('agent.tool.after')(event, () => undefined, at);
  for (const payload of demo.statusEvents) fake.events.get('agent.status.changed')(payload);
}

test('worker: answers trace.snapshot from transcripts and Orca events, and follows appended lines', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-trace-'));
  const NOW = Date.now();
  const demo = demoScenario(NOW);
  const fake = fakeOrca(demo);
  try {
    const project = await writeScenario(home, demo);
    const worker = await start(fake.orca, { home, now: () => NOW, persistMs: 5, notifyMs: 5 });
    assert.deepEqual([...fake.events.keys()].sort(), ['agent.status.changed', 'workspace.changed']);
    assert.deepEqual([...fake.hooks.keys()], ['agent.tool.after']);
    assert.equal(fake.hooks.get('agent.tool.after')(demo.toolEvents[0].event), undefined, 'the hook only observes');
    emit(fake, demo);

    const answer = await fake.panels.get('trace.snapshot')({ workspaceId: 'focused' });
    assert.equal(answer.selectedId, 'ws-checkout');
    assert.equal(answer.rangeHours, 6);
    assert.deepEqual(answer.workspaces.map((row) => [row.id, row.focused]), [['ws-checkout', true], ['ws-other', false]]);
    const view = answer.snapshot;
    assert.equal(view.totals.agents, 7);
    assert.deepEqual(view.notices, []);
    const names = view.nodes.flatMap((node) => [node.name, node.task]);
    assert.ok(names.includes('Review the retry change for race conditions'), 'the Codex session of this folder');
    assert.ok(!view.nodes.some((node) => node.id.includes('cx-else')), 'not the Codex session of another folder');
    const main = view.nodes.find((node) => node.id === 's:sess-main');
    assert.equal(main.state, 'running');
    assert.equal(main.requests, 6);
    assert.ok(view.totals.cost > 0);
    assert.ok(JSON.stringify(answer).length < 1024 * 1024);

    // The running subagent finishes and the main agent answers: only the new lines are read.
    const base = { sessionId: 'sess-main', cwd: demo.workspace.path };
    await appendFile(join(project, 'sess-main.jsonl'), `${[
      claude.result(NOW - 3000, 'a2', { toolUseResult: { agentId: 'tests-1' } }, base),
      claude.assistant(NOW - 1000, { id: 'm7', text: 'All green.', usage: { input_tokens: 10, output_tokens: 90, cache_read_input_tokens: 32000, cache_creation_input_tokens: 0 } }, base),
    ].join('\n')}\n`);
    const second = (await fake.panels.get('trace.snapshot')({ workspaceId: 'ws-checkout', rangeHours: 1 })).snapshot;
    const after = second.nodes.find((node) => node.id === 's:sess-main');
    assert.equal(after.requests, 7, 'old lines are not counted again');
    assert.equal(after.tokens.output, main.tokens.output + 90);
    assert.equal(second.nodes.find((node) => node.name === 'Run the full test suite').state, 'done');

    // The default scope is every active workspace: this one, and the other one whose Codex
    // session was just written.
    const fleet = await fake.panels.get('trace.snapshot')({});
    assert.equal(fleet.selectedId, 'all');
    assert.equal(fleet.rangeHours, 1);
    assert.equal(fleet.snapshot.scope, 'fleet');
    assert.deepEqual(fleet.snapshot.nodes.filter((node) => node.kind === 'workspace').map((node) => node.id).sort(), ['w:ws-checkout', 'w:ws-other']);
    assert.equal(fleet.snapshot.nodes.find((node) => node.id === 'w:ws-checkout').agentCount, 7);
    assert.equal(fleet.snapshot.totals.agents, 8);
    assert.equal(fleet.snapshot.nodes.find((node) => node.id === 's:sess-main').parentId, 'w:ws-checkout');
    assert.equal(new Set(fleet.snapshot.nodes.map((node) => node.id)).size, fleet.snapshot.nodes.length, 'node ids are unique');

    const other = (await fake.panels.get('trace.snapshot')({ workspaceId: 'ws-other' })).snapshot;
    assert.deepEqual(other.nodes.slice(1).map((node) => node.id), ['s:cx-else'], 'another workspace gets only its own session');

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(fake.posts.some((post) => post.event === 'trace.changed'));
    await worker.stop();
    const stored = fake.storage.get('live-v1');
    assert.equal(stored.panes.length, 5);
    assert.ok(JSON.stringify(stored).length < 256 * 1024);

    // A new worker starts from what was stored; nothing is running until Orca says so again.
    const next = await start(fake.orca, { home, now: () => NOW });
    assert.equal(next.live.panes().length, 5);
    await next.stop();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('worker: without workspace.list it still shows what the events say, and says why tokens are missing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-trace-'));
  const NOW = Date.now();
  const demo = demoScenario(NOW);
  const fake = fakeOrca(demo, { without: ['workspace.list', 'agents.list', 'storage.get', 'storage.set'] });
  try {
    const worker = await start(fake.orca, { home, now: () => NOW });
    emit(fake, demo);
    const answer = await fake.panels.get('trace.snapshot')({});
    assert.equal(answer.snapshot.scope, 'fleet');
    assert.deepEqual(answer.snapshot.nodes.filter((node) => node.kind === 'workspace').map((node) => node.name), ['Other agents']);
    assert.equal(answer.snapshot.totals.agents, 5);
    assert.ok(answer.snapshot.nodes.filter((node) => node.kind === 'agent').every((node) => node.source === 'events'));
    assert.match(answer.snapshot.notices[0], /transcripts were not read/);
    const focused = await fake.panels.get('trace.snapshot')({ workspaceId: 'focused' });
    assert.equal(focused.snapshot.totals.agents, 5);
    assert.match(focused.snapshot.notices[0], /transcripts were not read/);
    await worker.stop();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
