// What Orca itself reports about every agent pane, whatever CLI runs in it: status changes
// (agent.status.changed), finished tool calls (agent.tool.after hook) and the focused workspace's
// agent list (agents.list). This is the agent-agnostic layer. Pure: no Node built-ins.
import { clip, str, toolLabel } from './adapters/shared.mjs';

const STATES = new Set(['working', 'blocked', 'waiting', 'done']);

export function createLiveStore({ maxPanes = 300, maxTransitions = 500, maxTools = 800 } = {}) {
  const panes = new Map(); // key → pane; key is Orca's paneKey, or `t:<terminalId>` until one is known
  const byTerminal = new Map(); // terminalId → key

  function ensure(key) {
    let pane = panes.get(key);
    if (!pane) {
      pane = {
        key, terminalId: '', workspaceId: '', workspaceListId: '', title: '', agent: '', sessionId: '', task: '',
        transitions: [], tools: [], firstAt: null, lastAt: null, aliveAt: null, restored: false,
      };
      panes.set(key, pane);
      if (panes.size > maxPanes) evictOldest();
    }
    return pane;
  }

  function evictOldest() {
    let oldest = null;
    for (const pane of panes.values()) if (!oldest || lastSeen(pane) < lastSeen(oldest)) oldest = pane;
    if (oldest) remove(oldest.key);
  }

  function remove(key) {
    const pane = panes.get(key);
    if (!pane) return;
    if (pane.terminalId && byTerminal.get(pane.terminalId) === key) byTerminal.delete(pane.terminalId);
    panes.delete(key);
  }

  function bindTerminal(pane, terminalId) {
    if (!terminalId) return;
    const otherKey = byTerminal.get(terminalId);
    if (otherKey && otherKey !== pane.key) {
      // The terminal was first seen without a pane key (a hook or agents.list): fold it in.
      const other = panes.get(otherKey);
      if (other) {
        pane.agent ||= other.agent;
        pane.sessionId ||= other.sessionId;
        pane.task ||= other.task;
        pane.title ||= other.title;
        pane.tools = [...other.tools, ...pane.tools].sort((a, b) => a.at - b.at).slice(-maxTools);
        pane.transitions = [...other.transitions, ...pane.transitions].sort((a, b) => a.at - b.at).slice(-maxTransitions);
        if (other.firstAt !== null && (pane.firstAt === null || other.firstAt < pane.firstAt)) pane.firstAt = other.firstAt;
        panes.delete(otherKey);
      }
    }
    pane.terminalId = terminalId;
    byTerminal.set(terminalId, pane.key);
  }

  function seen(pane, at) {
    if (pane.firstAt === null || at < pane.firstAt) pane.firstAt = at;
    if (pane.lastAt === null || at > pane.lastAt) pane.lastAt = at;
  }

  function transition(pane, at, state, outcome) {
    if (!STATES.has(state)) return;
    const last = pane.transitions[pane.transitions.length - 1];
    if (last && last.state === state && (last.outcome ?? '') === (outcome ?? '')) return;
    pane.transitions.push(outcome ? { at, state, outcome } : { at, state });
    if (pane.transitions.length > maxTransitions) pane.transitions.shift();
  }

  return {
    // agent.status.changed payload.
    onStatus(payload, now = Date.now()) {
      const key = str(payload?.paneKey) || (str(payload?.terminalId) ? `t:${payload.terminalId}` : '');
      if (!key) return null;
      const at = Number.isFinite(payload.receivedAt) ? payload.receivedAt : now;
      const pane = ensure(key);
      bindTerminal(pane, str(payload.terminalId));
      if (str(payload.workspaceId)) pane.workspaceId = payload.workspaceId;
      if (str(payload.workspaceListId)) pane.workspaceListId = payload.workspaceListId;
      if (str(payload.title)) pane.title = clip(payload.title, 80);
      if (str(payload.sessionId)) pane.sessionId = payload.sessionId;
      const outcome = str(payload.mainAgent?.outcome);
      transition(pane, at, payload.state, payload.state === 'done' ? outcome : '');
      seen(pane, at);
      pane.restored = false;
      return pane;
    },

    // agent.tool.after hook event. Keeps the tool's name and a short label, never its input or output.
    onTool(event, now = Date.now(), { toolLabels = true } = {}) {
      const terminalId = str(event?.terminalId);
      if (!terminalId) return null;
      const pane = ensure(byTerminal.get(terminalId) ?? `t:${terminalId}`);
      bindTerminal(pane, terminalId);
      if (str(event.agent)) pane.agent = clip(event.agent, 40);
      if (str(event.workspaceId) && !pane.workspaceId) pane.workspaceId = event.workspaceId;
      pane.tools.push({ at: now, tool: clip(str(event.tool) || 'tool', 60), label: toolLabel(event.input, toolLabels) });
      if (pane.tools.length > maxTools) pane.tools.shift();
      seen(pane, now);
      return pane;
    },

    // agents.list answer for the focused workspace, with that workspace's id.
    seed(agents, workspaceId, now = Date.now()) {
      for (const item of Array.isArray(agents) ? agents : []) {
        const terminalId = str(item?.terminalId);
        if (!terminalId) continue;
        const pane = ensure(byTerminal.get(terminalId) ?? `t:${terminalId}`);
        bindTerminal(pane, terminalId);
        if (str(item.agent)) pane.agent = clip(item.agent, 40);
        if (str(item.title)) pane.title = clip(item.title, 80);
        if (str(item.sessionId)) pane.sessionId = item.sessionId;
        if (str(item.task?.title)) pane.task = clip(item.task.title, 120);
        if (str(workspaceId)) pane.workspaceId ||= workspaceId;
        const at = Number.isFinite(item.stateStartedAt) ? item.stateStartedAt : now;
        // The list has no outcome: it must not replace a `done` whose outcome an event already gave.
        const last = pane.transitions[pane.transitions.length - 1];
        if (!last || last.state !== item.state) transition(pane, at, item.state, '');
        seen(pane, at);
        // Listed means alive now, which is not an event: lastAt stays the last thing that happened.
        pane.aliveAt = now;
        pane.restored = false;
      }
    },

    panes() {
      return [...panes.values()];
    },

    // Drops panes with no activity since `before`.
    prune(before) {
      for (const pane of [...panes.values()]) if (lastSeen(pane) < before) remove(pane.key);
    },

    serialize() {
      return { v: 1, panes: [...panes.values()] };
    },

    restore(data) {
      if (data?.v !== 1 || !Array.isArray(data.panes)) return;
      for (const saved of data.panes) {
        if (!saved || typeof saved.key !== 'string') continue;
        const pane = ensure(saved.key);
        Object.assign(pane, {
          terminalId: '', workspaceId: str(saved.workspaceId), workspaceListId: str(saved.workspaceListId),
          title: clip(str(saved.title), 80), agent: clip(str(saved.agent), 40), sessionId: str(saved.sessionId), task: clip(str(saved.task), 120),
          // Stored values are rebuilt field by field, so nothing of an unexpected type comes back.
          transitions: Array.isArray(saved.transitions)
            ? saved.transitions.filter((t) => STATES.has(t?.state) && Number.isFinite(t.at)).slice(-maxTransitions)
              .map((t) => (str(t.outcome) ? { at: t.at, state: t.state, outcome: clip(t.outcome, 40) } : { at: t.at, state: t.state }))
            : [],
          tools: Array.isArray(saved.tools)
            ? saved.tools.filter((t) => Number.isFinite(t?.at)).slice(-maxTools)
              .map((t) => ({ at: t.at, tool: clip(str(t.tool) || 'tool', 60), label: clip(str(t.label), 60) }))
            : [],
          firstAt: Number.isFinite(saved.firstAt) ? saved.firstAt : null,
          lastAt: Number.isFinite(saved.lastAt) ? saved.lastAt : null,
          aliveAt: Number.isFinite(saved.aliveAt) ? saved.aliveAt : null,
          // Not heard from since the worker restarted: its last state may be out of date.
          restored: true,
        });
        bindTerminal(pane, str(saved.terminalId));
      }
    },
  };
}

// When the pane last did something or was last listed by Orca.
export function lastSeen(pane) {
  return Math.max(pane.lastAt ?? 0, pane.aliveAt ?? 0);
}

// The pane's state for the view: running, needs-you, waiting, done, failed, stopped, or unknown
// for a pane restored from storage that Orca has not reported on since.
export function paneState(pane) {
  const last = pane.transitions[pane.transitions.length - 1];
  if (!last) return 'waiting';
  if (pane.restored && last.state !== 'done') return 'unknown';
  if (last.state === 'working') return 'running';
  if (last.state === 'blocked') return 'needs-you';
  if (last.state === 'waiting') return 'waiting';
  if (last.outcome === 'failure') return 'failed';
  if (last.outcome === 'cancellation' || last.outcome === 'interruption') return 'stopped';
  return 'done';
}

// Each stretch the pane spent in one state, the last one running to `now` (or, for a restored
// pane, only to when it was last heard from).
export function stateSpans(pane, now) {
  const spans = [];
  if (pane.restored) now = pane.lastAt ?? now;
  for (let i = 0; i < pane.transitions.length; i++) {
    const current = pane.transitions[i];
    const end = i + 1 < pane.transitions.length ? pane.transitions[i + 1].at : now;
    if (current.state === 'done') continue;
    spans.push({ kind: 'state', name: current.state, start: current.at, end: Math.max(current.at, end) });
  }
  return spans;
}
