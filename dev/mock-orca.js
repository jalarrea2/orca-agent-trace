// A stand-in for window.orca so the view can be opened in a plain browser (see dev/preview.html).
// It runs the real pipeline (adapters → snapshot) over the synthetic scenario in tests/fixtures.mjs.
import { createClaudeParser } from '../src/core/adapters/claude.mjs';
import { createCodexParser } from '../src/core/adapters/codex.mjs';
import { createLiveStore } from '../src/core/live.mjs';
import { requestCost } from '../src/core/pricing.mjs';
import { PRICES_AS_OF } from '../src/core/prices-data.mjs';
import { buildFleetSnapshot, buildSnapshot } from '../src/core/snapshot.mjs';
import { claude, codex, demoScenario } from '../tests/fixtures.mjs';

function parse(make, lines) {
  const parser = make({ cost: requestCost });
  for (const line of lines) parser.push(line);
  return parser.result();
}

export function installMock() {
  const t0 = Date.now();
  const demo = demoScenario(t0);
  const live = createLiveStore();
  for (const { at, event } of demo.toolEvents) live.onTool(event, at);
  for (const payload of demo.statusEvents) live.onStatus(payload);

  // Two more workspaces for the fleet view: one with a Codex agent still running, and one whose
  // only session ended hours ago (it must not show).
  const billing = { id: 'ws-billing', name: 'billing-api', branch: 'payments · fix/invoice-rounding' };
  const billingLines = [
    codex.meta(t0 - 48_000, 'cx-billing', '/work/billing-api'),
    codex.turn(t0 - 48_000, 'gpt-6-sol'),
    // Started by the checkout coordinator through Orca's orchestration: the prompt carries the ids.
    codex.user(t0 - 47_000, 'Task task_91be04 · Dispatch ctx_7f3a2c. Fix the rounding error in invoice totals'),
    codex.call(t0 - 41_000, 'b1', 'shell_command', { command: 'rg "toFixed" src/invoices' }),
    codex.output(t0 - 40_200, 'b1'),
    codex.tokens(t0 - 40_000, { input_tokens: 24000, cached_input_tokens: 9000, output_tokens: 700 }, { input_tokens: 24000, cached_input_tokens: 9000, output_tokens: 700 }),
    codex.call(t0 - 33_000, 'bq', 'shell_command', { command: 'orca orchestration ask --body "Round half-even or half-up?"' }),
    codex.output(t0 - 26_000, 'bq', 'messageId: msg_4411aa\nanswer: Half-even, as finance asked'),
    codex.call(t0 - 22_000, 'b2', 'apply_patch', { path: '/work/billing-api/src/invoices/total.ts' }),
    codex.output(t0 - 21_500, 'b2'),
    codex.tokens(t0 - 21_000, { input_tokens: 26000, cached_input_tokens: 24000, output_tokens: 2100 }, { input_tokens: 50000, cached_input_tokens: 33000, output_tokens: 2800 }),
    codex.call(t0 - 9_000, 'b3', 'shell_command', { command: 'pnpm test invoices' }),
  ];
  live.onStatus({ workspaceId: billing.id, paneKey: 'pane-b', terminalId: 'term-b', title: 'Invoice rounding', state: 'working', receivedAt: t0 - 47_000 });
  const old = { id: 'ws-old', name: 'landing-page', branch: 'web · main' };
  const oldLines = [
    claude.user(t0 - 5 * 3_600_000, 'Tidy the hero copy', { sessionId: 'sess-old', cwd: '/work/landing-page' }),
    claude.assistant(t0 - 5 * 3_600_000 + 9000, { id: 'o1', text: 'Done.' }, { sessionId: 'sess-old', cwd: '/work/landing-page' }),
  ];

  // The first Claude Code session also coordinates: it starts the billing worker and answers it.
  const coordinator = { sessionId: 'sess-main', cwd: demo.workspace.path };
  const coordinatorLines = [
    claude.assistant(t0 - 52_000, { id: 'k1', tools: [{ id: 'o1', name: 'Bash', input: { command: 'orca orchestration worker-start --spec "Fix the rounding error in invoice totals" --worktree new-top-level --agent codex' } }] }, coordinator),
    claude.result(t0 - 49_500, 'o1', { content: 'worker started\ntask: task_91be04\ndispatch: ctx_7f3a2c' }, coordinator),
    claude.user(t0 - 31_000, '[Orca] Question from dispatch ctx_7f3a2c (msg_4411aa): Round half-even or half-up?', coordinator),
    claude.assistant(t0 - 28_000, { id: 'k2', tools: [{ id: 'o2', name: 'Bash', input: { command: 'orca orchestration reply --id msg_4411aa --body "Half-even, as finance asked"' } }] }, coordinator),
    claude.result(t0 - 27_400, 'o2', {}, coordinator),
  ];
  const sessionsOf = {
    [demo.workspace.id]: () => [
      ...demo.claudeSessions.map((session, index) => parse(createClaudeParser, [...session.lines, ...(index === 0 ? coordinatorLines : []), ...Object.values(session.subagents).flat()])),
      ...demo.codexSessions.map((session) => parse(createCodexParser, session.lines)),
    ],
    [billing.id]: () => [parse(createCodexParser, billingLines)],
    [old.id]: () => [parse(createClaudeParser, oldLines)],
  };
  const main = { id: demo.workspace.id, name: demo.workspace.name, branch: `shop · ${demo.workspace.branch}` };
  const all = [main, billing, old];
  const notices = ['Preview with invented data: nothing here comes from a real session.'];

  window.orca = Object.freeze({
    api: { major: 1, minor: 6 },
    on: () => ({ dispose() {} }),
    plugin: Object.freeze({
      on: () => ({ dispose() {} }),
      async request(name, input = {}) {
        if (name !== 'trace.snapshot') throw Object.assign(new Error(name), { code: 'unknown_method' });
        const now = Date.now();
        const scope = input.workspaceId || 'all';
        const rangeHours = input.rangeHours ?? (scope === 'all' ? 1 : 6);
        const since = now - rangeHours * 3_600_000;
        live.seed(demo.agents, demo.workspace.id, now);
        const panesOf = (id) => live.panes().filter((pane) => pane.workspaceId === id);
        let snapshot;
        if (scope === 'all') {
          snapshot = buildFleetSnapshot({
            groups: all.map((workspace) => ({ workspace, sessions: sessionsOf[workspace.id](), panes: panesOf(workspace.id) })),
            now, since, notices, pricesAsOf: PRICES_AS_OF,
          });
        } else {
          const workspace = all.find((item) => item.id === scope) ?? main;
          snapshot = buildSnapshot({ workspace, sessions: sessionsOf[workspace.id](), panes: panesOf(workspace.id), now, since, notices, pricesAsOf: PRICES_AS_OF });
        }
        return {
          snapshot,
          workspaces: all.map((workspace) => ({ id: workspace.id, name: workspace.name, branch: workspace.branch, focused: workspace.id === main.id })),
          selectedId: scope,
          rangeHours,
          ranges: [1, 6, 24, 168],
        };
      },
    }),
  });
}
