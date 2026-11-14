// Synthetic transcripts and Orca events for the tests and for dev/preview.html. Nothing here comes
// from a real session: names, prompts and numbers are invented. Pure, so the browser can import it.

const iso = (ms) => new Date(ms).toISOString();

export const claude = {
  user: (ts, text, extra = {}) => JSON.stringify({ type: 'user', timestamp: iso(ts), ...extra, message: { role: 'user', content: text } }),
  assistant: (ts, { id, model = 'claude-opus-5-5', usage, tools = [], text = '', requestId = `req_${id}` }, extra = {}) =>
    JSON.stringify({
      type: 'assistant', timestamp: iso(ts), requestId, ...extra,
      message: {
        id, type: 'message', role: 'assistant', model,
        content: [...(text ? [{ type: 'text', text }] : []), ...tools.map((tool) => ({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input ?? {} }))],
        usage: usage ?? { input_tokens: 20, output_tokens: 200, cache_read_input_tokens: 8000, cache_creation_input_tokens: 400 },
      },
    }),
  result: (ts, toolId, { error = false, toolUseResult } = {}, extra = {}) =>
    JSON.stringify({
      type: 'user', timestamp: iso(ts), ...extra, ...(toolUseResult ? { toolUseResult } : {}),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: error, content: 'ok' }] },
    }),
};

export const codex = {
  meta: (ts, id, cwd) => JSON.stringify({ timestamp: iso(ts), type: 'session_meta', payload: { id, cwd } }),
  turn: (ts, model) => JSON.stringify({ timestamp: iso(ts), type: 'turn_context', payload: { model } }),
  user: (ts, text) => JSON.stringify({ timestamp: iso(ts), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }),
  assistant: (ts, text) => JSON.stringify({ timestamp: iso(ts), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
  call: (ts, callId, name, args) => JSON.stringify({ timestamp: iso(ts), type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId } }),
  output: (ts, callId) => JSON.stringify({ timestamp: iso(ts), type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: 'ok' } }),
  tokens: (ts, last, total) => JSON.stringify({ timestamp: iso(ts), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total } } }),
};

// One workspace with five agents, `now` being the moment the view is drawn:
//   - a Claude Code session still running, with two subagents (one linked by toolUseResult.agentId,
//     one only by start order) and a failed shell call
//   - a second Claude Code session blocked on the person
//   - a finished Codex session
//   - a Gemini pane and an OpenCode pane that Orca reports but no adapter reads (events only)
export function demoScenario(now, cwd = '/work/checkout-service') {
  const t0 = now - 110_000;
  const at = (seconds) => t0 + seconds * 1000;
  const main = { sessionId: 'sess-main', cwd };
  const base = { sessionId: main.sessionId, cwd };
  const sub = (agentId) => ({ ...base, agentId, isSidechain: true });

  const mainLines = [
    claude.user(at(0), 'Add retry with exponential backoff to the webhook sender', base),
    claude.assistant(at(4), { id: 'm1', tools: [{ id: 't1', name: 'Read', input: { file_path: `${cwd}/src/webhooks/sender.ts` } }], usage: { input_tokens: 40, output_tokens: 310, cache_read_input_tokens: 0, cache_creation_input_tokens: 21000, cache_creation: { ephemeral_1h_input_tokens: 21000 } } }, base),
    // The same message continues on a second line: its usage must count once.
    claude.assistant(at(4.2), { id: 'm1', tools: [{ id: 't2', name: 'Grep', input: { pattern: 'sendWebhook', path: `${cwd}/src` } }], usage: { input_tokens: 40, output_tokens: 310, cache_read_input_tokens: 0, cache_creation_input_tokens: 21000, cache_creation: { ephemeral_1h_input_tokens: 21000 } } }, base),
    claude.result(at(4.6), 't1', {}, base),
    claude.result(at(5.1), 't2', {}, base),
    claude.assistant(at(9), { id: 'm2', tools: [{ id: 'a1', name: 'Agent', input: { description: 'Map webhook call sites', subagent_type: 'Explore', prompt: 'Find every caller' } }], usage: { input_tokens: 60, output_tokens: 420, cache_read_input_tokens: 21000, cache_creation_input_tokens: 1800 } }, base),
    claude.result(at(31), 'a1', { toolUseResult: { agentId: 'explore-1', totalTokens: 52000 } }, base),
    claude.assistant(at(38), { id: 'm3', tools: [{ id: 't3', name: 'Edit', input: { file_path: `${cwd}/src/webhooks/sender.ts` } }], usage: { input_tokens: 90, output_tokens: 1900, cache_read_input_tokens: 22800, cache_creation_input_tokens: 2600 } }, base),
    claude.result(at(38.4), 't3', {}, base),
    claude.assistant(at(46), { id: 'm4', tools: [{ id: 't4', name: 'Bash', input: { command: 'pnpm test webhooks --run' } }], usage: { input_tokens: 70, output_tokens: 260, cache_read_input_tokens: 25400, cache_creation_input_tokens: 2100 } }, base),
    claude.result(at(58), 't4', { error: true }, base),
    claude.assistant(at(66), { id: 'm5', tools: [{ id: 't5', name: 'Edit', input: { file_path: `${cwd}/src/webhooks/backoff.ts` } }], usage: { input_tokens: 80, output_tokens: 1300, cache_read_input_tokens: 27500, cache_creation_input_tokens: 3400 } }, base),
    claude.result(at(66.5), 't5', {}, base),
    claude.assistant(at(73), { id: 'm6', tools: [{ id: 'a2', name: 'Agent', input: { description: 'Run the full test suite', subagent_type: 'general-purpose', prompt: 'Run and report' } }], usage: { input_tokens: 50, output_tokens: 380, cache_read_input_tokens: 30900, cache_creation_input_tokens: 1500 } }, base),
  ];
  const exploreLines = [
    claude.user(at(9.5), 'Find every caller', sub('explore-1')),
    claude.assistant(at(12), { id: 'e1', model: 'claude-sonnet-5-5', tools: [{ id: 'e-t1', name: 'Grep', input: { pattern: 'sendWebhook\\(' } }], usage: { input_tokens: 30, output_tokens: 180, cache_read_input_tokens: 0, cache_creation_input_tokens: 9000 } }, sub('explore-1')),
    claude.result(at(13), 'e-t1', {}, sub('explore-1')),
    claude.assistant(at(17), { id: 'e2', model: 'claude-sonnet-5-5', tools: [{ id: 'e-t2', name: 'Read', input: { file_path: `${cwd}/src/orders/notify.ts` } }, { id: 'e-t3', name: 'Read', input: { file_path: `${cwd}/src/billing/events.ts` } }], usage: { input_tokens: 30, output_tokens: 240, cache_read_input_tokens: 9000, cache_creation_input_tokens: 2400 } }, sub('explore-1')),
    claude.result(at(17.8), 'e-t2', {}, sub('explore-1')),
    claude.result(at(18.3), 'e-t3', {}, sub('explore-1')),
    claude.assistant(at(30), { id: 'e3', model: 'claude-sonnet-5-5', text: 'Three call sites.', usage: { input_tokens: 40, output_tokens: 900, cache_read_input_tokens: 11400, cache_creation_input_tokens: 19000 } }, sub('explore-1')),
  ];
  // Still running at `now`: its Agent call has no result yet, so it is linked by start order.
  const testsLines = [
    claude.user(at(73.5), 'Run and report', sub('tests-1')),
    claude.assistant(at(77), { id: 'r1', model: 'claude-haiku-5-5', tools: [{ id: 'r-t1', name: 'Bash', input: { command: 'pnpm test --run' } }], usage: { input_tokens: 30, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 7000 } }, sub('tests-1')),
  ];

  const docsBase = { sessionId: 'sess-docs', cwd };
  const docsLines = [
    claude.user(at(20), 'Write migration notes for the retry change', docsBase),
    claude.assistant(at(26), { id: 'd1', model: 'claude-sonnet-5-5', tools: [{ id: 'd-t1', name: 'Read', input: { file_path: `${cwd}/CHANGELOG.md` } }], usage: { input_tokens: 30, output_tokens: 240, cache_read_input_tokens: 0, cache_creation_input_tokens: 14000 } }, docsBase),
    claude.result(at(26.4), 'd-t1', {}, docsBase),
    claude.assistant(at(41), { id: 'd2', model: 'claude-sonnet-5-5', tools: [{ id: 'd-t2', name: 'Write', input: { file_path: `${cwd}/docs/migrations/retry.md` } }], usage: { input_tokens: 40, output_tokens: 1500, cache_read_input_tokens: 14000, cache_creation_input_tokens: 1200 } }, docsBase),
  ];

  const codexLines = [
    codex.meta(at(34), 'cx-review', cwd),
    codex.turn(at(34), 'gpt-6-sol'),
    codex.user(at(34.5), 'Review the retry change for race conditions'),
    codex.call(at(39), 'c1', 'shell_command', { command: 'git diff --stat' }),
    codex.output(at(39.6), 'c1'),
    codex.tokens(at(39.7), { input_tokens: 18000, cached_input_tokens: 12000, output_tokens: 400 }, { input_tokens: 18000, cached_input_tokens: 12000, output_tokens: 400 }),
    codex.call(at(47), 'c2', 'shell_command', { command: 'rg "setTimeout" src/webhooks' }),
    codex.output(at(47.9), 'c2'),
    codex.tokens(at(48), { input_tokens: 21000, cached_input_tokens: 18000, output_tokens: 900 }, { input_tokens: 39000, cached_input_tokens: 30000, output_tokens: 1300 }),
    // Codex repeats a count whose total has not moved: it must add nothing.
    codex.tokens(at(48.1), { input_tokens: 21000, cached_input_tokens: 18000, output_tokens: 900 }, { input_tokens: 39000, cached_input_tokens: 30000, output_tokens: 1300 }),
    codex.assistant(at(61), 'One race: two retries can overlap when the timer fires during a send.'),
    codex.tokens(at(61.1), { input_tokens: 22000, cached_input_tokens: 21000, output_tokens: 1600 }, { input_tokens: 61000, cached_input_tokens: 51000, output_tokens: 2900 }),
  ];

  const ws = 'ws-checkout';
  const status = (seconds, paneKey, terminalId, title, state, outcome) => ({
    workspaceId: ws, paneKey, terminalId, title, state, receivedAt: at(seconds), ...(outcome ? { mainAgent: { state, outcome, stateStartedAt: at(seconds) } } : {}),
  });
  const statusEvents = [
    status(0, 'pane-1', 'term-1', 'Webhook retry', 'working'),
    status(20, 'pane-2', 'term-2', 'Migration notes', 'working'),
    status(41.5, 'pane-2', 'term-2', 'Migration notes', 'blocked'),
    status(34, 'pane-3', 'term-3', 'Race review', 'working'),
    status(61.5, 'pane-3', 'term-3', 'Race review', 'done', 'success'),
    status(12, 'pane-4', 'term-4', 'Update API docs', 'working'),
    status(52, 'pane-4', 'term-4', 'Update API docs', 'waiting'),
    status(70, 'pane-4', 'term-4', 'Update API docs', 'working'),
    status(5, 'pane-5', 'term-5', 'Bump lint rules', 'working'),
    status(27, 'pane-5', 'term-5', 'Bump lint rules', 'done', 'failure'),
  ];
  const tool = (seconds, terminalId, agent, name, input) => ({ at: at(seconds), event: { agent, workspaceId: ws, terminalId, tool: name, input } });
  const toolEvents = [
    tool(15, 'term-4', 'gemini', 'read_file', { path: `${cwd}/docs/api/webhooks.md` }),
    tool(22, 'term-4', 'gemini', 'search', { query: 'retry-after header' }),
    tool(36, 'term-4', 'gemini', 'edit_file', { path: `${cwd}/docs/api/webhooks.md` }),
    tool(78, 'term-4', 'gemini', 'run_shell', { command: 'pnpm docs:build' }),
    tool(9, 'term-5', 'opencode', 'bash', { command: 'pnpm lint' }),
    tool(21, 'term-5', 'opencode', 'edit', { path: `${cwd}/.eslintrc.json` }),
  ];

  return {
    workspace: { id: ws, name: 'checkout-service', branch: 'feat/retry-webhooks', path: cwd, kind: 'worktree', hostId: 'local' },
    context: { workspaceId: ws, branch: 'feat/retry-webhooks', displayName: 'checkout-service', terminals: ['term-1', 'term-2', 'term-3', 'term-4', 'term-5'].map((id) => ({ id })) },
    claudeSessions: [
      { sessionId: main.sessionId, lines: mainLines, subagents: { 'agent-explore-1': exploreLines, 'agent-tests-1': testsLines } },
      { sessionId: docsBase.sessionId, lines: docsLines, subagents: {} },
    ],
    codexSessions: [{ file: 'rollout-2026-01-01T00-00-00-cx-review', lines: codexLines }],
    statusEvents,
    toolEvents,
    // agents.list for the focused workspace: gives the agent kind of each terminal.
    agents: [
      { terminalId: 'term-1', title: 'Webhook retry', agent: 'claude', state: 'working', stateStartedAt: at(0) },
      { terminalId: 'term-2', title: 'Migration notes', agent: 'claude', state: 'blocked', stateStartedAt: at(41.5) },
      { terminalId: 'term-3', title: 'Race review', agent: 'codex', state: 'done', stateStartedAt: at(61.5) },
      { terminalId: 'term-4', title: 'Update API docs', agent: 'gemini', state: 'working', stateStartedAt: at(70) },
      { terminalId: 'term-5', title: 'Bump lint rules', agent: 'opencode', state: 'done', stateStartedAt: at(27) },
    ],
  };
}
