import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeParser } from '../src/core/adapters/claude.mjs';
import { createCodexParser } from '../src/core/adapters/codex.mjs';
import { createLiveStore, paneState, stateSpans } from '../src/core/live.mjs';
import { normalizeModel, requestCost, resolvePrice } from '../src/core/pricing.mjs';
import { buildFleetSnapshot, buildSnapshot } from '../src/core/snapshot.mjs';
import { demoScenario } from './fixtures.mjs';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const demo = demoScenario(NOW);

function parseClaude(session) {
  const parser = createClaudeParser({ cost: requestCost });
  for (const line of [...session.lines, ...Object.values(session.subagents).flat()]) parser.push(line);
  return parser.result();
}

test('pricing: resolves dated and prefixed ids, applies tiers, null when unknown', () => {
  assert.equal(normalizeModel('anthropic/claude-opus-5-5-20261001[1m]'), 'claude-opus-5-5');
  assert.equal(resolvePrice('claude-opus-5-5-20261001').id, 'claude-opus-5-5');
  assert.equal(resolvePrice('some-new-model'), null);
  assert.equal(requestCost('some-new-model', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }), null);
  const row = resolvePrice('claude-sonnet-5-5');
  const usage = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6, cacheWrite1h: 0 };
  assert.ok(Math.abs(requestCost('claude-sonnet-5-5', usage) - (row.input + row.output + row.cacheRead + row.cacheWrite)) < 1e-9);
  const haiku = resolvePrice('claude-haiku-5-5');
  const small = requestCost('claude-haiku-5-5', { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
  const large = requestCost('claude-haiku-5-5', { input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
  assert.ok(Math.abs(small - (1000 * haiku.input) / 1e6) < 1e-12);
  assert.ok(Math.abs(large - (200_000 * haiku.tiers[0].input) / 1e6) < 1e-12);
});

test('claude: usage counts once per message, tools close, failures flag, subagents link', () => {
  const session = parseClaude(demo.claudeSessions[0]);
  assert.equal(session.agentKind, 'claude');
  assert.equal(session.sessionId, 'sess-main');
  assert.equal(session.cwd, '/work/checkout-service');
  const main = session.agents.find((agent) => agent.key === '');
  assert.equal(main.name, 'Add retry with exponential backoff to the webhook sender');
  assert.equal(main.requests, 6, 'm1 is on two lines and counts once');
  assert.equal(main.usage.output, 310 + 420 + 1900 + 260 + 1300 + 380);
  assert.equal(main.usage.cacheWrite1h, 21000);
  assert.equal(main.toolCount, 7);
  assert.equal(main.errorCount, 1);
  assert.ok(main.cost > 0 && !main.unpriced);
  const bash = main.spans.find((span) => span.kind === 'tool' && span.name === 'Bash');
  assert.equal(bash.error, true);
  assert.equal(bash.end - bash.start, 12_000);
  assert.equal(bash.label, 'pnpm test webhooks --run');
  const read = main.spans.find((span) => span.kind === 'tool' && span.name === 'Read');
  assert.equal(read.label, 'sender.ts');
  const llm = main.spans.filter((span) => span.kind === 'llm');
  assert.equal(llm.length, 6);
  assert.equal(llm[0].end - llm[0].start, 4200, 'from the prompt to the last line of message m1');
  const open = main.spans.filter((span) => span.end === null);
  assert.deepEqual(open.map((span) => span.name), ['Agent'], 'the second Agent call is still running');

  const explore = session.agents.find((agent) => agent.key === 'explore-1');
  assert.equal(explore.name, 'Map webhook call sites');
  assert.equal(explore.type, 'Explore');
  assert.equal(explore.parentKey, '');
  assert.equal(explore.model, 'claude-sonnet-5-5');
  assert.equal(explore.toolCount, 3);
  const tests = session.agents.find((agent) => agent.key === 'tests-1');
  assert.equal(tests.name, 'Run the full test suite', 'linked by start order: its call has no result yet');
  assert.ok(session.events.some((event) => event.level === 'error' && event.text.startsWith('Bash failed')));
  assert.ok(session.events.some((event) => event.text.startsWith('Prompt: Add retry')));
});

test('claude: ignores lines that are not JSON or have no timestamp', () => {
  const parser = createClaudeParser();
  parser.push('not json');
  parser.push('{"type":"assistant","message":{"usage":{"input_tokens":5}}}');
  parser.push('[1,2]');
  const main = parser.result().agents[0];
  assert.equal(main.requests, 0);
  assert.equal(main.firstAt, null);
});

test('codex: model, tools, usage without the repeated count', () => {
  const parser = createCodexParser({ cost: requestCost });
  for (const line of demo.codexSessions[0].lines) parser.push(line);
  const session = parser.result();
  assert.equal(session.sessionId, 'cx-review');
  assert.equal(session.cwd, '/work/checkout-service');
  const main = session.agents[0];
  assert.equal(main.model, 'gpt-6-sol');
  assert.equal(main.name, 'Review the retry change for race conditions');
  assert.equal(main.requests, 3);
  assert.equal(main.usage.cacheRead, 12000 + 18000 + 21000);
  assert.equal(main.usage.input, 6000 + 3000 + 1000, 'cached input is not counted twice');
  assert.equal(main.usage.output, 400 + 900 + 1600);
  assert.equal(main.toolCount, 2);
  assert.ok(main.spans.filter((span) => span.kind === 'tool').every((span) => span.end !== null));
  assert.equal(main.spans.find((span) => span.kind === 'tool').label, 'git diff --stat');
  assert.ok(main.cost > 0);
});

test('live: a terminal seen first by a hook folds into its pane, and restored panes are unknown', () => {
  const store = createLiveStore();
  store.onTool({ agent: 'gemini', terminalId: 'term-4', tool: 'read_file', input: { path: '/a/b/c.md' } }, 1000);
  assert.equal(store.panes().length, 1);
  store.onStatus({ paneKey: 'pane-4', terminalId: 'term-4', workspaceId: 'ws', state: 'working', receivedAt: 2000 });
  store.onStatus({ paneKey: 'pane-4', terminalId: 'term-4', workspaceId: 'ws', state: 'working', receivedAt: 2500 });
  store.onStatus({ paneKey: 'pane-4', terminalId: 'term-4', workspaceId: 'ws', state: 'blocked', receivedAt: 5000 });
  const [pane] = store.panes();
  assert.equal(store.panes().length, 1);
  assert.equal(pane.key, 'pane-4');
  assert.equal(pane.agent, 'gemini');
  assert.equal(pane.tools[0].label, 'c.md');
  assert.equal(pane.transitions.length, 2, 'a repeated state is one transition');
  assert.equal(paneState(pane), 'needs-you');
  assert.deepEqual(stateSpans(pane, 9000).map((span) => [span.name, span.start, span.end]), [['working', 2000, 5000], ['blocked', 5000, 9000]]);

  store.onStatus({ paneKey: 'pane-4', terminalId: 'term-4', state: 'done', receivedAt: 9000, mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 9000 } });
  assert.equal(paneState(pane), 'failed');
  store.seed([{ terminalId: 'term-4', agent: 'gemini', state: 'done', stateStartedAt: 9000 }], 'ws', 9500);
  assert.equal(paneState(pane), 'failed', 'agents.list has no outcome and must not erase one');

  const copy = createLiveStore();
  copy.restore(JSON.parse(JSON.stringify(store.serialize())));
  assert.equal(paneState(copy.panes()[0]), 'failed');
  store.onStatus({ paneKey: 'pane-9', terminalId: 'term-9', state: 'working', receivedAt: 100 });
  const again = createLiveStore();
  again.restore(JSON.parse(JSON.stringify(store.serialize())));
  const stale = again.panes().find((item) => item.key === 'pane-9');
  assert.equal(paneState(stale), 'unknown', 'not heard from since the restart');
  assert.deepEqual(stateSpans(stale, 99_999).map((span) => span.end), [100]);
  again.onStatus({ paneKey: 'pane-9', terminalId: 'term-9', state: 'working', receivedAt: 200 });
  assert.equal(paneState(stale), 'running');
});

test('snapshot: tree, states, roll-up and events-only agents', () => {
  const sessions = [...demo.claudeSessions.map(parseClaude)];
  const codex = createCodexParser({ cost: requestCost });
  for (const line of demo.codexSessions[0].lines) codex.push(line);
  sessions.push(codex.result());
  const store = createLiveStore();
  for (const { at, event } of demo.toolEvents) store.onTool(event, at);
  for (const payload of demo.statusEvents) store.onStatus(payload);
  store.seed(demo.agents, demo.workspace.id, NOW);

  const view = buildSnapshot({ workspace: demo.workspace, sessions, panes: store.panes(), now: NOW, since: NOW - 3_600_000, pricesAsOf: 'x' });
  const byName = new Map(view.nodes.flatMap((node) => [[node.name, node], [node.task, node]]));
  assert.equal(view.nodes[0].id, 'root');
  assert.equal(view.totals.agents, 7, 'three sessions, two subagents, two events-only panes');
  const main = byName.get('Add retry with exponential backoff to the webhook sender');
  assert.equal(main.state, 'running');
  assert.equal(main.live, true);
  assert.equal(main.name, 'Webhook retry', 'the pane title names the card');
  assert.equal(byName.get('Map webhook call sites').parentId, main.id);
  assert.equal(byName.get('Map webhook call sites').state, 'done');
  assert.equal(byName.get('Run the full test suite').state, 'running');
  assert.equal(byName.get('Write migration notes for the retry change').state, 'needs-you');
  assert.equal(byName.get('Review the retry change for race conditions').state, 'done');
  const gemini = byName.get('Update API docs');
  assert.equal(gemini.source, 'events');
  assert.equal(gemini.group, 'Gemini');
  assert.equal(gemini.tokens, null);
  assert.equal(gemini.state, 'running');
  assert.equal(byName.get('Bump lint rules').state, 'failed');

  const subs = [byName.get('Map webhook call sites'), byName.get('Run the full test suite')];
  assert.equal(main.total.tokens, main.tokens.total + subs[0].tokens.total + subs[1].tokens.total);
  assert.ok(Math.abs(main.total.cost - (main.cost + subs[0].cost + subs[1].cost)) < 1e-9);
  const sumTokens = view.nodes.reduce((total, node) => total + (node.tokens?.total ?? 0), 0);
  assert.equal(view.totals.tokens, sumTokens);
  assert.equal(view.totals.attention, 2, 'one needs you, one failed');
  assert.equal(view.totals.settled, 3);
  assert.equal(view.live, true);
  assert.equal(view.range.end, NOW);

  assert.ok(view.spans.every((span) => span.end >= span.start && span.end <= NOW));
  assert.ok(view.spans.some((span) => span.nodeId === gemini.id && span.point));
  assert.ok(view.spans.some((span) => span.kind === 'state' && span.name === 'blocked'));
  const open = view.spans.filter((span) => span.open);
  assert.ok(open.length >= 2 && open.every((span) => span.end === NOW), 'calls still running end at now');
  assert.ok(view.events.some((event) => event.text === 'Needs you'));
  assert.ok(view.events.some((event) => event.text === 'Turn failed'));
  assert.ok(view.events[0].ts >= view.events[view.events.length - 1].ts, 'newest first');
  assert.ok(JSON.stringify(view).length < 200_000);
});

test('snapshot: an empty workspace still draws a root', () => {
  const view = buildSnapshot({ workspace: { id: 'w', name: 'empty', branch: 'main' }, now: NOW, since: NOW - 1000 });
  assert.equal(view.nodes.length, 1);
  assert.equal(view.range.start, null);
  assert.equal(view.totals.cost, null);
  assert.equal(view.live, false);
});

test('fleet: only active workspaces, the ones that need the person first', () => {
  const claudeAt = (id, cwd, lastAgo) => {
    const parser = createClaudeParser({ cost: requestCost });
    const base = { sessionId: id, cwd };
    parser.push(JSON.stringify({ type: 'user', timestamp: new Date(NOW - lastAgo - 20_000).toISOString(), ...base, message: { role: 'user', content: `Task ${id}` } }));
    parser.push(JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - lastAgo).toISOString(), ...base, message: { id: `m-${id}`, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 20 } } }));
    return parser.result();
  };
  const store = createLiveStore();
  store.onStatus({ paneKey: 'p-b', terminalId: 't-b', state: 'working', receivedAt: NOW - 600_000 });
  store.onStatus({ paneKey: 'p-b', terminalId: 't-b', state: 'blocked', receivedAt: NOW - 500_000 });
  const groups = [
    { workspace: { id: 'a', name: 'running', branch: 'x' }, sessions: [claudeAt('sa', '/a', 5_000)], panes: [] },
    { workspace: { id: 'b', name: 'blocked', branch: 'x' }, sessions: [], panes: store.panes() },
    { workspace: { id: 'c', name: 'just-finished', branch: 'x' }, sessions: [claudeAt('sc', '/c', 10 * 60_000)], panes: [] },
    { workspace: { id: 'd', name: 'idle', branch: 'x' }, sessions: [claudeAt('sd', '/d', 40 * 60_000)], panes: [] },
    { workspace: { id: 'e', name: 'empty', branch: 'x' }, sessions: [], panes: [] },
    { workspace: { id: 'f', name: 'orca-says-busy', branch: 'x' }, sessions: [], panes: [], busy: true },
  ];
  const view = buildFleetSnapshot({ groups, now: NOW, since: NOW - 3_600_000 });
  const tops = view.nodes.filter((node) => node.kind === 'workspace');
  assert.deepEqual(tops.map((node) => node.name), ['blocked', 'running', 'orca-says-busy', 'just-finished']);
  assert.deepEqual(tops.map((node) => node.state), ['needs-you', 'running', 'running', 'done']);
  assert.equal(view.scope, 'fleet');
  assert.equal(view.nodes[0].kind, 'fleet');
  assert.equal(view.nodes[0].state, 'needs-you');
  assert.equal(view.nodes[0].agentCount, 3);
  assert.equal(view.totals.workspaces, 4);
  assert.equal(view.totals.agents, 3);
  assert.equal(view.totals.running, 1);
  assert.equal(view.totals.attention, 1);
  assert.equal(view.live, true);
  assert.ok(view.nodes.every((node) => node.id === 'root' || node.depth >= 1));
  assert.equal(view.nodes.find((node) => node.id === 's:sa').depth, 2);
  assert.equal(view.nodes[0].total.tokens, 60, 'two transcript sessions of 30 tokens; the idle one is left out');

  const none = buildFleetSnapshot({ groups: groups.slice(3, 5), now: NOW, since: NOW - 3_600_000 });
  assert.equal(none.nodes.length, 1);
  assert.equal(none.live, false);
  assert.equal(none.range.start, null);
});
