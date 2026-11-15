// The sequence view: who called whom, in order. One lane per participant (you, each agent and
// subagent, Orca's orchestration, and tool families), one row per message.
//
// Rows come from four places in the snapshot:
//   - snapshot.messages: prompts and orchestration commands, already paired agent to agent
//   - subagent nodes: the call that started each one and its return
//   - spans: tool calls (grouped by family), and the stretches an agent waited on the person
//   - events: turns that finished, failed or were stopped
// Pure: it returns data and HTML strings and touches no DOM.
import { fmtDuration, prettyModel } from './format.js';

export const LANE_W = 156;
export const GUTTER_W = 58;
export const ROW_H = 38;
const MAX_ROWS = 250;
const BUSY = new Set(['running', 'needs-you']);
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const SHELL = new Set(['bash', 'shell', 'shell_command', 'exec_command', 'local_shell_call', 'run_shell', 'run_shell_command', 'terminal', 'execute_command']);
const FILES = new Set(['read', 'write', 'edit', 'multiedit', 'notebookedit', 'glob', 'grep', 'ls', 'apply_patch', 'read_file', 'write_file', 'edit_file', 'view', 'view_image', 'search_files', 'list_dir', 'str_replace_editor']);
const WEB = new Set(['webfetch', 'websearch', 'web_search', 'web_fetch', 'fetch', 'browser']);

// The lane a tool call goes to: [lane id, lane label].
export function toolLane(name) {
  const mcp = /^mcp__(.+?)__/.exec(name);
  if (mcp) return [`tool:mcp:${mcp[1]}`, mcp[1].replace(/[_-]+/g, ' ')];
  const key = String(name).toLowerCase();
  if (SHELL.has(key)) return ['tool:shell', 'Shell'];
  if (FILES.has(key)) return ['tool:files', 'Files'];
  if (WEB.has(key)) return ['tool:web', 'Web'];
  return ['tool:other', 'Other tools'];
}

// { lanes, rows, frames, activations, dropped, start } for the part of the snapshot in view.
//   focusId:     an agent or subagent node: only its session
//   workspaceId: a workspace node id, or 'all'
//   tools:       whether tool calls get rows
export function buildSequence(snapshot, { now, focusId = null, workspaceId = 'all', tools = true } = {}) {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const isAgent = (node) => node && (node.kind === 'agent' || node.kind === 'subagent');
  const sessionOf = (node) => {
    let at = node;
    while (at && at.kind === 'subagent') at = byId.get(at.parentId);
    return at;
  };
  const workspaceOf = (node) => {
    let at = node;
    while (at && at.kind !== 'workspace') at = byId.get(at.parentId);
    return at;
  };

  const focus = isAgent(byId.get(focusId)) ? sessionOf(byId.get(focusId)) : null;
  const scope = new Set();
  for (const node of snapshot.nodes) {
    if (!isAgent(node)) continue;
    if (focus ? sessionOf(node) === focus : workspaceId === 'all' || workspaceOf(node)?.id === workspaceId) scope.add(node.id);
  }

  const items = [];
  for (const message of snapshot.messages ?? []) {
    if (!scope.has(message.from) && !scope.has(message.to)) continue;
    items.push({ ts: message.ts, from: message.from, to: message.to, kind: message.error ? 'failed' : message.kind, label: message.label || (message.kind === 'prompt' ? 'Prompt' : message.verb), tip: message.label });
  }
  for (const node of snapshot.nodes) {
    if (node.kind !== 'subagent' || !scope.has(node.id) || node.startedAt === null) continue;
    items.push({ ts: node.startedAt, from: node.parentId, to: node.id, kind: 'call', label: node.name, tip: node.name });
    if (node.endedAt !== null) items.push({ ts: node.endedAt, from: node.id, to: node.parentId, kind: 'return', label: `done · ${fmtDuration(node.endedAt - node.startedAt)}`, tip: node.name });
  }
  for (const span of snapshot.spans) {
    if (!scope.has(span.nodeId)) continue;
    if (span.kind === 'state' && span.name === 'blocked') {
      items.push({ ts: span.start, from: span.nodeId, to: 'you', kind: 'needs-you', label: 'Needs you', tip: `Waited ${fmtDuration(span.end - span.start)}` });
    } else if (tools && span.kind === 'tool' && !span.orch && !SUBAGENT_TOOLS.has(span.name)) {
      const [lane, laneLabel] = toolLane(span.name);
      items.push({ ts: span.start, from: span.nodeId, to: lane, laneLabel, kind: span.error ? 'failed' : 'tool', tool: span.name, detail: span.label, open: span.open === true, count: 1 });
    }
  }
  const TURN = { 'Turn finished': 'done', 'Turn failed': 'failed', 'Turn stopped': 'stopped' };
  for (const event of snapshot.events) {
    if (TURN[event.text] && scope.has(event.nodeId)) items.push({ ts: event.ts, from: event.nodeId, to: 'you', kind: TURN[event.text], label: event.text, tip: event.text });
  }
  items.sort((a, b) => a.ts - b.ts);

  // A run of tool calls from one agent to one lane becomes one row; a failed or running call
  // keeps its own.
  const rows = [];
  for (const item of items) {
    const last = rows[rows.length - 1];
    if (item.kind === 'tool' && !item.open && last && last.kind === 'tool' && !last.open && last.from === item.from && last.to === item.to) {
      last.count += 1;
      last.names.set(item.tool, (last.names.get(item.tool) ?? 0) + 1);
      last.end = item.ts;
      continue;
    }
    rows.push(item.tool ? { ...item, names: new Map([[item.tool, 1]]) } : item);
  }
  for (const row of rows) {
    if (!row.tool) continue;
    const short = shortTool(row.tool);
    if (row.count === 1) {
      row.label = `${short}${row.detail ? ` ${row.detail}` : ''}${row.kind === 'failed' ? ' failed' : ''}`;
    } else {
      const names = [...row.names].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => shortTool(name));
      row.label = `${row.count} calls · ${names.join(', ')}${row.names.size > 3 ? '…' : ''}`;
    }
    row.tip = row.label;
  }
  const dropped = Math.max(0, rows.length - MAX_ROWS);
  const shown = dropped ? rows.slice(dropped) : rows;

  // Lanes, in a fixed order: you, agents (tree order), Orca, tool families.
  const used = new Set();
  for (const row of shown) {
    used.add(row.from);
    used.add(row.to);
  }
  const lanes = [];
  if (used.has('you')) lanes.push({ id: 'you', label: 'You', sub: '', kind: 'you' });
  for (const node of snapshot.nodes) {
    if (!isAgent(node) || !(used.has(node.id) || (scope.has(node.id) && node.kind === 'agent'))) continue;
    const workspace = workspaceOf(node);
    lanes.push({
      id: node.id, label: node.name, kind: node.kind, state: node.state, agent: node.agent, group: node.group,
      sub: node.kind === 'subagent' ? node.group : [snapshot.scope === 'fleet' && workspace ? workspace.name : '', node.group].filter(Boolean).join(' · '),
      outside: !scope.has(node.id), model: prettyModel(node.model),
    });
  }
  if (used.has('orca')) lanes.push({ id: 'orca', label: 'Orca', sub: 'orchestration', kind: 'orca' });
  const toolLanes = new Map();
  for (const row of shown) if (row.laneLabel && !toolLanes.has(row.to)) toolLanes.set(row.to, row.laneLabel);
  for (const id of ['tool:shell', 'tool:files', 'tool:web']) if (toolLanes.has(id)) lanes.push({ id, label: toolLanes.get(id), sub: 'tools', kind: 'tool' });
  for (const [id, label] of toolLanes) if (id.startsWith('tool:mcp:')) lanes.push({ id, label, sub: 'MCP', kind: 'tool' });
  if (toolLanes.has('tool:other')) lanes.push({ id: 'tool:other', label: toolLanes.get('tool:other'), sub: 'tools', kind: 'tool' });
  const laneAt = new Map(lanes.map((lane, index) => [lane.id, index]));
  const placed = shown.filter((row) => laneAt.has(row.from) && laneAt.has(row.to) && row.from !== row.to);
  placed.forEach((row, index) => {
    row.index = index;
    row.a = laneAt.get(row.from);
    row.b = laneAt.get(row.to);
  });

  // An agent's lifeline is active from its first row to its last, and to the bottom while it runs.
  const activations = [];
  for (const lane of lanes) {
    if (lane.kind !== 'agent' && lane.kind !== 'subagent') continue;
    const mine = placed.filter((row) => row.from === lane.id || row.to === lane.id);
    if (!mine.length) continue;
    const live = BUSY.has(lane.state) && !lane.outside;
    activations.push({ lane: laneAt.get(lane.id), from: mine[0].index, to: live ? placed.length : mine[mine.length - 1].index, live, wait: lane.state === 'needs-you' });
  }

  const frames = [];
  // PAR: subagents of one agent whose runs overlap.
  const kids = new Map();
  for (const node of snapshot.nodes) {
    if (node.kind !== 'subagent' || !scope.has(node.id) || node.startedAt === null) continue;
    if (!kids.has(node.parentId)) kids.set(node.parentId, []);
    kids.get(node.parentId).push(node);
  }
  for (const [parentId, list] of kids) {
    list.sort((a, b) => a.startedAt - b.startedAt);
    let cluster = [];
    let until = -Infinity;
    const flush = () => {
      if (cluster.length >= 2) {
        const ids = new Set(cluster.map((node) => node.id));
        const inside = placed.filter((row) => ids.has(row.from) || ids.has(row.to));
        if (inside.length) {
          const cols = inside.flatMap((row) => [row.a, row.b]).concat(laneAt.get(parentId) ?? []);
          frames.push({ tag: 'PAR', top: inside[0].index, bottom: inside[inside.length - 1].index, left: Math.min(...cols), right: Math.max(...cols) });
        }
      }
      cluster = [];
    };
    for (const node of list) {
      if (node.startedAt > until) flush();
      cluster.push(node);
      until = Math.max(until, node.endedAt ?? now);
    }
    flush();
  }
  // RETRY: a failed tool call, then the same tool again from the same agent.
  for (let i = 0; i < placed.length; i++) {
    const row = placed[i];
    if (row.kind !== 'failed' || !row.tool) continue;
    const next = placed.slice(i + 1, i + 12).find((other) => other.from === row.from && other.tool);
    if (next && next.to === row.to && next.names.has(row.tool)) {
      frames.push({ tag: 'RETRY', top: row.index, bottom: next.index, left: Math.min(row.a, row.b), right: Math.max(row.a, row.b) });
    }
  }

  return { lanes, rows: placed, frames, activations, dropped, start: placed.length ? placed[0].ts : null };
}

// A state, kind or tag picks a CSS class: only letters, digits and '-' get through.
function tok(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9-]/g, '');
}

function shortTool(name) {
  const mcp = /^mcp__.+?__(.+)$/.exec(name);
  return mcp ? mcp[1] : name;
}

function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

// The diagram as HTML. `esc` escapes text, `glyph(lane)` draws a lane's badge, `newerThan` marks
// rows that arrived after that time so they animate in, `selected` is the focused node id.
export function sequenceHtml(sequence, { esc, glyph, newerThan = null, selected = null, laneWidth = LANE_W }) {
  const { lanes, rows, frames, activations, dropped, start } = sequence;
  if (!rows.length) return '<div class="empty">No messages between agents in this range yet.</div>';
  const x = (lane) => GUTTER_W + lane * laneWidth + laneWidth / 2;
  const width = GUTTER_W + lanes.length * laneWidth;
  const height = rows.length * ROW_H;
  const head = lanes.map((lane, index) => {
    const node = lane.kind === 'agent' || lane.kind === 'subagent';
    const cls = `lane-chip k-${tok(lane.kind)}${lane.state ? ` st-${tok(lane.state)}` : ''}${lane.outside ? ' outside' : ''}${selected === lane.id ? ' selected' : ''}`;
    const title = `${lane.label}${lane.sub ? ` — ${lane.sub}` : ''}${lane.model ? ` — ${lane.model}` : ''}`;
    const inner = `${glyph(lane)}<span class="lane-name">${esc(lane.label)}</span>`;
    const chip = node ? `<button class="${cls}" data-id="${esc(lane.id)}" title="${esc(title)}">${inner}</button>` : `<span class="${cls}" title="${esc(title)}">${inner}</span>`;
    return `<div class="lane-head" style="left:${GUTTER_W + index * laneWidth}px;width:${laneWidth}px"><span class="lane-sub">${esc(lane.sub)}</span>${chip}</div>`;
  }).join('');
  const lines = lanes.map((lane, index) => `<i class="life" style="left:${x(index)}px"></i>`).join('');
  const acts = activations.map((act) => `<i class="act${act.live ? ' live' : ''}${act.wait ? ' wait' : ''}" style="left:${x(act.lane) - 4}px;top:${act.from * ROW_H + ROW_H - 9}px;height:${Math.max(10, (act.to - act.from) * ROW_H + (act.live ? 12 : 0))}px"></i>`).join('');
  const boxes = frames.map((frame) => `<div class="frame f-${tok(frame.tag).toLowerCase()}" style="left:${x(frame.left) - 46}px;top:${frame.top * ROW_H + 1}px;width:${x(frame.right) - x(frame.left) + 92}px;height:${(frame.bottom - frame.top + 1) * ROW_H - 2}px"><b>${esc(frame.tag)}</b></div>`).join('');
  const body = rows.map((row) => {
    const right = row.b > row.a;
    const left = x(Math.min(row.a, row.b));
    const span = Math.abs(x(row.b) - x(row.a));
    const cls = `arrow a-${tok(row.kind)}${right ? ' ltr' : ' rtl'}${row.open ? ' open' : ''}`;
    const fresh = newerThan !== null && row.ts > newerThan ? ' enter' : '';
    return `<div class="srow${fresh}"><span class="stime">${clock(row.ts - start)}</span><div class="${cls}" style="left:${left + 5}px;width:${span - 10}px" title="${esc(row.tip || row.label)}"><span class="alabel">${esc(row.label)}</span></div></div>`;
  }).join('');
  const note = dropped ? `<div class="seq-note">${Number(dropped) || 0} earlier messages are not shown.</div>` : '';
  return `<div class="seq" style="width:${width}px">
    <div class="seq-head" style="width:${width}px"><span class="seq-corner"></span>${head}</div>
    ${note}
    <div class="seq-body" style="height:${height + 14}px">${lines}${acts}${boxes}${body}</div>
  </div>`;
}
