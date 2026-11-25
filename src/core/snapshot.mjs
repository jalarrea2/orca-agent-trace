// Builds what the view draws: a tree of agents with their spans, tokens, cost and state, plus
// totals and an event log. Two shapes:
//   - one workspace:  workspace → agent sessions → subagents            (buildSnapshot)
//   - the fleet:      all → active workspaces → agent sessions → subagents (buildFleetSnapshot)
// Transcript sessions give the detail; Orca's live panes give the state. Pure: no Node built-ins.
import { lastSeen, paneState, stateSpans } from './live.mjs';

const AGENT_LABELS = {
  claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode', opencode2: 'OpenCode', cursor: 'Cursor',
  copilot: 'Copilot', kiro: 'Kiro', grok: 'Grok', droid: 'Droid', pi: 'Pi', antigravity: 'Antigravity', kimi: 'Kimi',
  'qwen-code': 'Qwen Code', devin: 'Devin', hermes: 'Hermes',
};
const ACTIVE = new Set(['running', 'needs-you', 'waiting']);
const BUSY = new Set(['running', 'needs-you']);
const SETTLED = new Set(['done', 'failed', 'stopped']);
// A transcript with no live pane counts as running while it was written this recently.
const RECENT_MS = 120_000;
const MATCH_SLACK_MS = 180_000;
export const MAX_SPANS = 5000;
export const MAX_EVENTS = 200;
export const MAX_MESSAGES = 800;
// In the fleet view a workspace stays listed this long after its last agent activity.
export const ACTIVE_WINDOW_MS = 15 * 60_000;

export function agentLabel(kind) {
  if (typeof kind !== 'string' || !kind) return 'Agent';
  return Object.hasOwn(AGENT_LABELS, kind) ? AGENT_LABELS[kind] : kind.charAt(0).toUpperCase() + kind.slice(1);
}

// workspace: { id, name, branch, host? } | null; host is { id, name, local } (where it runs)
// sessions:  results of the transcript adapters (see adapters/claude.mjs)
// panes:     live panes of this workspace (see live.mjs)
export function buildSnapshot({ workspace = null, sessions = [], panes = [], now = Date.now(), since = 0, notices = [], pricesAsOf = '' } = {}) {
  const part = collectWorkspace({ workspace, sessions, panes, now, since, id: 'root', parentId: null, depth: 0 });
  return finish({ scope: 'workspace', nodes: part.nodes, spans: part.spans, events: part.events, flows: [part.flows], workspace, workspaces: 1, now, since, notices, pricesAsOf });
}

// groups: [{ workspace: { id, name, branch, host? }, sessions, panes, busy? }] for every workspace Orca
// lists; `busy` is true when Orca itself says an agent is working or waiting on the person there.
// Only workspaces that are active make it into the tree: an agent running or needing the person,
// or any agent activity since `activeSince`.
export function buildFleetSnapshot({ groups = [], now = Date.now(), since = 0, activeSince = now - ACTIVE_WINDOW_MS, notices = [], pricesAsOf = '' } = {}) {
  const root = node({ id: 'root', parentId: null, depth: 0, kind: 'fleet', group: 'Orca', name: 'Active workspaces', source: 'orca' });
  const parts = [];
  for (const group of groups) {
    const part = collectWorkspace({ ...group, now, since, id: `w:${group.workspace.id}`, parentId: 'root', depth: 1 });
    const agents = part.nodes.slice(1);
    const lastAt = maxOf(agents.map((item) => item.lastAt)) ?? 0;
    const busy = agents.some((item) => BUSY.has(item.state));
    if (!busy && lastAt < activeSince && !(group.busy === true)) continue;
    // Orca says the workspace is busy but no agent of it is known here: say so on the card.
    if (group.busy === true && agents.length === 0) {
      part.nodes[0].state = 'running';
      part.nodes[0].task = part.nodes[0].task || 'Agent working (no detail yet)';
    }
    parts.push({ part, busy: busy || group.busy === true, attention: agents.some((item) => item.state === 'needs-you'), lastAt });
  }
  // Workspaces that need the person first, then the busy ones, then the most recent.
  parts.sort((a, b) => Number(b.attention) - Number(a.attention) || Number(b.busy) - Number(a.busy) || b.lastAt - a.lastAt);
  const nodes = [root];
  const spans = [];
  const events = [];
  const flows = [];
  for (const { part } of parts) {
    nodes.push(...part.nodes);
    spans.push(...part.spans);
    events.push(...part.events);
    flows.push(part.flows);
  }
  return finish({ scope: 'fleet', nodes, spans, events, flows, workspace: null, workspaces: parts.length, now, since, notices, pricesAsOf });
}

// One workspace as a node followed by its agents and subagents, in tree order.
function collectWorkspace({ workspace, sessions = [], panes = [], now, since, id, parentId, depth }) {
  const nodes = [];
  const spans = [];
  const events = [];
  // What the sequence view needs to pair agents: prompts, orchestration commands, and which node
  // answers to which orchestration id or terminal handle.
  const flows = { prompts: [], orch: [], inbound: [], terminals: [] };

  const live = sessions.filter((session) => (mainOf(session)?.lastAt ?? 0) >= since && mainOf(session)?.firstAt !== null);
  live.sort((a, b) => mainOf(a).firstAt - mainOf(b).firstAt);
  const recentPanes = panes.filter((pane) => lastSeen(pane) >= since);
  const paneOf = matchPanes(live, recentPanes);
  const matchedPanes = new Set(paneOf.values());

  // Where the workspace runs (this Mac, or a remote Orca host): every agent card under it says so.
  const host = hostOf(workspace);
  const top = node({
    id, parentId, depth, kind: 'workspace', group: 'Workspace',
    name: workspace?.name || 'Workspace', task: workspace?.branch || '', source: 'orca', host,
  });
  nodes.push(top);

  for (const session of live) {
    const pane = paneOf.get(session) ?? null;
    const idOf = (key) => (key === '' ? `s:${session.sessionId}` : `s:${session.sessionId}:${key}`);
    const mainState = sessionState(session, pane, now);
    for (const { agent, depth: below } of depthFirst(session.agents)) {
      const isMain = agent.key === '';
      const state = isMain ? mainState : subagentState(agent, mainState, now);
      const item = node({
        id: idOf(agent.key),
        parentId: isMain ? id : idOf(agent.parentKey ?? ''),
        depth: depth + 1 + below,
        kind: isMain ? 'agent' : 'subagent',
        group: isMain ? agentLabel(session.agentKind) : agent.type || 'Subagent',
        agent: session.agentKind,
        // A live pane's title names the card; the session's first prompt becomes its task line.
        name: (isMain && pane?.title) || agent.name || (isMain ? 'Session' : 'Subagent'),
        task: isMain ? pane?.task || (pane?.title && agent.name !== 'Session' ? agent.name : '') : '',
        model: agent.model,
        state,
        host,
        source: 'transcript',
        live: isMain && pane !== null,
        startedAt: agent.firstAt,
        endedAt: ACTIVE.has(state) ? null : agent.lastAt,
        lastAt: Math.max(agent.lastAt ?? 0, isMain && pane ? pane.lastAt ?? 0 : 0),
        tokens: tokensOf(agent.usage),
        cost: agent.unpriced && agent.cost === 0 ? null : agent.cost,
        costPartial: agent.unpriced && agent.cost > 0,
        requests: agent.requests,
        toolCount: agent.toolCount,
        errorCount: agent.errorCount,
        // What the agent itself reported over OpenTelemetry (an Agent Trace hub), for the whole
        // session including its subagents. Null when no hub saw the session or it had no price.
        reportedCost: isMain && session.otel?.priced ? session.otel.costUsd : null,
      });
      nodes.push(item);
      const openEnd = ACTIVE.has(state) ? now : agent.lastAt ?? now;
      for (const span of agent.spans) {
        spans.push({ nodeId: item.id, kind: span.kind, name: span.name, label: span.label || '', start: span.start, end: span.end ?? openEnd, error: span.error === true, open: span.end === null && ACTIVE.has(state), ...(span.orch ? { orch: true } : {}) });
      }
      if (isMain && pane) {
        // Only the stretches a person may care about: the agent waiting on them.
        for (const span of stateSpans(pane, now)) {
          if (span.name === 'blocked' || span.name === 'waiting') spans.push({ nodeId: item.id, ...span, label: '', error: false, open: false });
        }
        paneEvents(pane, item.id, events);
      }
    }
    for (const event of session.events) events.push({ ts: event.ts, nodeId: idOf(event.agentKey ?? ''), level: event.level, text: event.text });
    flows.inbound.push({ nodeId: idOf(''), ids: session.inboundIds ?? [] });
    if (pane?.terminalId) flows.terminals.push({ id: pane.terminalId, nodeId: idOf('') });
    for (const prompt of session.prompts ?? []) flows.prompts.push({ ts: prompt.ts, to: idOf(prompt.agentKey ?? ''), text: prompt.text, ids: prompt.ids ?? [] });
    for (const command of session.orch ?? []) flows.orch.push({ ts: command.ts, from: idOf(command.agentKey ?? ''), verb: command.verb, subject: command.subject, ids: command.ids ?? [], error: command.error === true });
  }

  // Panes with no transcript behind them: an agent with no adapter, or a session not found on disk.
  for (const pane of recentPanes) {
    if (matchedPanes.has(pane)) continue;
    const state = paneState(pane);
    const item = node({
      id: `p:${pane.key}`, parentId: id, depth: depth + 1, kind: 'agent', group: agentLabel(pane.agent), agent: pane.agent,
      name: pane.title || pane.task || agentLabel(pane.agent), task: pane.title ? pane.task : '', state, source: 'events', live: true, host,
      startedAt: pane.firstAt, endedAt: ACTIVE.has(state) ? null : pane.lastAt, lastAt: pane.lastAt ?? 0, toolCount: pane.tools.length,
    });
    nodes.push(item);
    const working = state === 'running';
    const list = stateSpans(pane, now);
    list.forEach((span, index) => spans.push({ nodeId: item.id, ...span, label: '', error: false, open: working && index === list.length - 1 && span.name === 'working' }));
    for (const tool of pane.tools) spans.push({ nodeId: item.id, kind: 'tool', name: tool.tool, label: tool.label || '', start: tool.at, end: tool.at, error: false, open: false, point: true });
    paneEvents(pane, item.id, events);
    if (pane.terminalId) flows.terminals.push({ id: pane.terminalId, nodeId: item.id });
  }

  const agents = nodes.slice(1);
  top.state = groupState(agents);
  top.startedAt = minOf(agents.map((item) => item.startedAt));
  top.endedAt = ACTIVE.has(top.state) ? null : maxOf(agents.map((item) => item.endedAt));
  top.lastAt = maxOf(agents.map((item) => item.lastAt)) ?? 0;
  return { nodes, spans, events, flows };
}

function finish({ scope, nodes, spans, events, flows = [], workspace, workspaces, now, since, notices, pricesAsOf }) {
  rollUp(nodes);
  const root = nodes[0];
  const agents = nodes.filter((item) => item.kind === 'agent' || item.kind === 'subagent');
  if (scope === 'fleet') {
    const tops = nodes.filter((item) => item.parentId === 'root');
    root.state = groupState(tops);
    root.startedAt = minOf(tops.map((item) => item.startedAt));
    root.endedAt = ACTIVE.has(root.state) ? null : maxOf(tops.map((item) => item.endedAt));
    root.lastAt = maxOf(tops.map((item) => item.lastAt)) ?? 0;
  }
  const clipped = clipSpans(spans, since, now);
  events.sort((a, b) => b.ts - a.ts);
  const live = nodes.some((item) => item.id !== 'root' && BUSY.has(item.state));
  const start = root.startedAt === null ? null : Math.max(root.startedAt, since);
  const end = start === null ? null : live || ACTIVE.has(root.state) ? now : Math.max(maxOf(nodes.map((item) => item.endedAt)) ?? now, start);
  return {
    generatedAt: now,
    since,
    scope,
    workspace: workspace ? { id: workspace.id, name: workspace.name, branch: workspace.branch || '', host: hostOf(workspace) } : null,
    live,
    range: { start, end },
    totals: {
      workspaces,
      agents: agents.length,
      settled: agents.filter((item) => SETTLED.has(item.state)).length,
      running: agents.filter((item) => item.state === 'running').length,
      elapsedMs: start === null ? 0 : Math.max(0, end - start),
      tokens: root.total.tokens,
      cost: root.total.cost,
      costPartial: root.total.costPartial,
      attention: agents.filter((item) => item.state === 'needs-you' || item.state === 'failed').length,
    },
    nodes,
    spans: clipped.spans,
    spansDropped: clipped.dropped,
    events: events.filter((event) => event.ts >= since).slice(0, MAX_EVENTS),
    messages: resolveMessages(flows, new Set(nodes.map((item) => item.id)), since),
    notices,
    pricesAsOf,
  };
}

// Who talked to whom: every prompt and orchestration command as { ts, from, to, kind, verb,
// label, error }, where from/to is a node id, 'you' (typed by the person, as far as the
// transcript shows) or 'orca' (an orchestration id no agent in range answers to).
// Agents are paired by orchestration ids: a dispatched worker's first prompt carries its task
// and dispatch ids, a terminal handle names its pane, and an id a worker's command produced
// (the message id of a question, say) names that worker to whoever uses it next.
function resolveMessages(flows, known, since) {
  const rootOf = (id) => (id.startsWith('s:') ? id.split(':').slice(0, 2).join(':') : id);
  const owner = new Map(); // id → the node it addresses
  const inbound = new Map(); // node → Set of the ids it was dispatched with
  const prompts = [];
  const orch = [];
  for (const flow of flows) {
    for (const { nodeId, ids } of flow.inbound) {
      inbound.set(nodeId, new Set(ids));
      for (const id of ids) if (!owner.has(id)) owner.set(id, nodeId);
    }
    for (const { id, nodeId } of flow.terminals) owner.set(id, nodeId);
    prompts.push(...flow.prompts);
    orch.push(...flow.orch);
  }
  orch.sort((a, b) => a.ts - b.ts);
  prompts.sort((a, b) => a.ts - b.ts);

  // The coordinator of a worker: the first other agent to run a command with one of its ids.
  const usedBy = new Map(); // id → roots that ran a command naming it, in time order
  for (const command of orch) {
    const root = rootOf(command.from);
    for (const id of command.ids) {
      if (!usedBy.has(id)) usedBy.set(id, []);
      if (!usedBy.get(id).includes(root)) usedBy.get(id).push(root);
    }
  }
  const coordinatorOf = (root) => {
    for (const id of inbound.get(root) ?? []) {
      const other = (usedBy.get(id) ?? []).find((candidate) => candidate !== root);
      if (other) return other;
    }
    return null;
  };

  const out = [];
  const claimed = new Map(); // an id nobody was dispatched with → the agent whose command first carried it
  for (const command of orch) {
    const root = rootOf(command.from);
    let to = null;
    for (const id of command.ids) {
      const target = owner.get(id) ?? claimed.get(id);
      if (target && rootOf(target) !== root) {
        to = target;
        break;
      }
    }
    to ??= coordinatorOf(root) ?? 'orca';
    for (const id of command.ids) if (!owner.has(id) && !claimed.has(id)) claimed.set(id, root);
    out.push({ ts: command.ts, from: command.from, to, kind: 'orch', verb: command.verb, label: command.subject ? `${command.verb}: ${command.subject}` : command.verb, error: command.error });
  }
  for (const prompt of prompts) {
    const root = rootOf(prompt.to);
    let from = 'you';
    if (prompt.ids.length) {
      // A worker reporting back names itself; a coordinator dispatching names its worker.
      const reporter = prompt.ids.map((id) => owner.get(id) ?? claimed.get(id)).find((target) => target && rootOf(target) !== root);
      const dispatcher = prompt.ids.flatMap((id) => usedBy.get(id) ?? []).find((candidate) => candidate !== root);
      from = reporter ?? dispatcher ?? 'orca';
    }
    // The command that sent it is already drawn: do not draw the delivery as a second message.
    const sent = from !== 'you' && from !== 'orca' && out.some((message) => message.kind === 'orch' && rootOf(message.from) === rootOf(from) && rootOf(message.to) === root && prompt.ts - message.ts >= 0 && prompt.ts - message.ts < 120_000);
    if (sent) continue;
    out.push({ ts: prompt.ts, from, to: prompt.to, kind: 'prompt', verb: '', label: prompt.text, error: false });
  }
  return out
    .filter((message) => message.ts >= since && (known.has(message.from) || message.from === 'you' || message.from === 'orca') && (known.has(message.to) || message.to === 'orca'))
    .sort((a, b) => a.ts - b.ts)
    .slice(-MAX_MESSAGES);
}

function node(fields) {
  return {
    id: '', parentId: null, depth: 0, kind: 'agent', group: '', agent: '', name: '', task: '', model: '', state: 'done',
    source: 'transcript', live: false, host: null, startedAt: null, endedAt: null, lastAt: 0, tokens: null, cost: null, costPartial: false,
    requests: 0, toolCount: 0, errorCount: 0, agentCount: 0, total: { tokens: 0, cost: null, costPartial: false }, ...fields,
  };
}

// A workspace's host as { id, name, local }, or null when Orca did not say where it runs.
function hostOf(workspace) {
  const host = workspace?.host;
  if (!host || typeof host.name !== 'string' || !host.name) return null;
  return { id: String(host.id ?? ''), name: host.name, local: host.local === true };
}

function mainOf(session) {
  return session.agents.find((agent) => agent.key === '') ?? null;
}

function tokensOf(usage) {
  return {
    input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
    total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
  };
}

// Agents in tree order, each with its depth below the main agent (0).
function depthFirst(agents) {
  const byParent = new Map();
  for (const agent of agents) {
    if (agent.key === '') continue;
    const parent = agents.some((other) => other.key === agent.parentKey) ? agent.parentKey : '';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(agent);
  }
  for (const list of byParent.values()) list.sort((a, b) => (a.firstAt ?? 0) - (b.firstAt ?? 0));
  const out = [];
  const visit = (agent, depth, trail) => {
    out.push({ agent, depth });
    if (trail.has(agent.key)) return;
    const next = new Set(trail).add(agent.key);
    for (const child of byParent.get(agent.key) ?? []) visit(child, depth + 1, next);
  };
  const main = agents.find((agent) => agent.key === '');
  if (main) visit(main, 0, new Set());
  return out;
}

function sessionState(session, pane, now) {
  if (pane) {
    const state = paneState(pane);
    if (state !== 'unknown') return state;
  }
  const main = mainOf(session);
  return now - (main?.lastAt ?? 0) < RECENT_MS ? 'running' : 'done';
}

function subagentState(agent, mainState, now) {
  if (agent.done) return 'done';
  const open = agent.spans.some((span) => span.end === null);
  if (mainState === 'running' && (open || now - (agent.lastAt ?? 0) < RECENT_MS)) return 'running';
  return 'done';
}

// session → pane. By session id when Orca reports one. Otherwise by time: among panes of the same
// agent kind active while the transcript was written, the one that started or last acted closest
// to it. Closest pairs are taken first, so one near match cannot take another session's pane.
function matchPanes(sessions, panes) {
  const result = new Map();
  const free = new Set(panes);
  for (const session of sessions) {
    const pane = panes.find((candidate) => candidate.sessionId && candidate.sessionId === session.sessionId);
    if (pane && free.has(pane)) {
      result.set(session, pane);
      free.delete(pane);
    }
  }
  const pairs = [];
  for (const session of sessions) {
    if (result.has(session)) continue;
    const main = mainOf(session);
    for (const pane of free) {
      if (pane.sessionId) continue; // it names another session
      if (pane.agent && pane.agent !== session.agentKind) continue;
      if (pane.firstAt === null || pane.lastAt === null) continue;
      const overlaps = pane.firstAt <= main.lastAt + MATCH_SLACK_MS && lastSeen(pane) >= main.firstAt - MATCH_SLACK_MS;
      if (!overlaps) continue;
      pairs.push({ session, pane, gap: Math.min(Math.abs(pane.firstAt - main.firstAt), Math.abs(pane.lastAt - main.lastAt)) });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap);
  for (const { session, pane } of pairs) {
    if (result.has(session) || !free.has(pane)) continue;
    result.set(session, pane);
    free.delete(pane);
  }
  return result;
}

function paneEvents(pane, nodeId, events) {
  for (const transition of pane.transitions) {
    if (transition.state === 'blocked') events.push({ ts: transition.at, nodeId, level: 'warn', text: 'Needs you' });
    else if (transition.state === 'done' && transition.outcome === 'failure') events.push({ ts: transition.at, nodeId, level: 'error', text: 'Turn failed' });
    else if (transition.state === 'done' && (transition.outcome === 'cancellation' || transition.outcome === 'interruption')) events.push({ ts: transition.at, nodeId, level: 'warn', text: 'Turn stopped' });
    else if (transition.state === 'done') events.push({ ts: transition.at, nodeId, level: 'info', text: 'Turn finished' });
  }
}

// Each node's total is its own tokens and cost plus its descendants', and agentCount is how many
// agents and subagents sit below it. Nodes arrive parents first.
function rollUp(nodes) {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  for (const item of nodes) {
    item.total = { tokens: item.tokens?.total ?? 0, cost: item.cost, costPartial: item.costPartial };
    item.agentCount = 0;
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    const item = nodes[i];
    const parent = item.parentId ? byId.get(item.parentId) : null;
    if (!parent) continue;
    parent.agentCount += item.agentCount + (item.kind === 'agent' || item.kind === 'subagent' ? 1 : 0);
    parent.total.tokens += item.total.tokens;
    if (item.total.cost !== null) parent.total.cost = (parent.total.cost ?? 0) + item.total.cost;
    // A child with tokens but no price leaves the parent's cost short.
    if (item.total.costPartial || (item.total.cost === null && item.total.tokens > 0)) parent.total.costPartial = true;
  }
}

function groupState(children) {
  if (children.some((item) => item.state === 'needs-you')) return 'needs-you';
  if (children.some((item) => item.state === 'running')) return 'running';
  if (children.some((item) => item.state === 'waiting')) return 'waiting';
  if (children.some((item) => item.state === 'failed')) return 'failed';
  return 'done';
}

function clipSpans(spans, since, now) {
  const kept = [];
  for (const span of spans) {
    if (span.end < since || span.start > now) continue;
    kept.push({ ...span, start: Math.max(span.start, since), end: Math.min(span.end, now) });
  }
  kept.sort((a, b) => a.start - b.start);
  const dropped = Math.max(0, kept.length - MAX_SPANS);
  return { spans: dropped ? kept.slice(dropped) : kept, dropped };
}

function minOf(values) {
  const real = values.filter((value) => Number.isFinite(value));
  return real.length ? Math.min(...real) : null;
}

function maxOf(values) {
  const real = values.filter((value) => Number.isFinite(value));
  return real.length ? Math.max(...real) : null;
}
