// The view, shared by the sidebar panel (index.html) and the editor tab (editor.html). It asks the
// plugin's worker for `trace.snapshot` and draws it: agent tree, trace timeline, tokens, events.
// No framework, no network: everything is built from the snapshot.
//
// Motion: the worker is polled every few seconds, and between polls a one-second clock advances
// "now" locally, so running durations count up and running bars grow. A region is redrawn only
// when its HTML changes, and animations are started with a negative delay equal to the page clock
// (--sync), so a redraw continues an animation instead of restarting it.
import { fmtClock, fmtCost, fmtDuration, fmtTokens, niceStep, prettyModel } from './format.js';
import { buildSequence, GUTTER_W, LANE_W, sequenceHtml } from './sequence.js';

const POLL_MS = 3000;
const TICK_MS = 1000;
// The timeline and the sequence diagram depend on "now", so while agents run their HTML changes
// on every tick. With a busy fleet that is thousands of bars rebuilt each second, which blocked
// the panel long enough for Orca to suspend it. The clock tick redraws them at most this often.
const HEAVY_TICK_MS = 5000;
// `trace.changed` arrives every few hundred ms while transcripts are being written; reloads are
// spaced at least this far apart.
const MIN_LOAD_GAP_MS = 2000;
const NARROW_PX = 640;
const TINY_PX = 340;
// A redraw waits while the pointer is over the region, so a tooltip or a click is not lost, but
// never longer than this.
const HOVER_HOLD_MS = 4000;
const ZOOMS = [1, 2, 4, 8, 16];
const STATS_MS = 60_000;
const FLEET = 'all';
const FOCUSED = 'focused';
const STATE_LABEL = {
  running: 'Running', 'needs-you': 'Needs you', waiting: 'Waiting', done: 'Done', failed: 'Failed', stopped: 'Stopped', unknown: 'Unknown',
};
const BUSY = new Set(['running', 'needs-you']);
const ICON = {
  running: '<svg viewBox="0 0 12 12" class="spin" aria-hidden="true"><path d="M6 1.5a4.5 4.5 0 1 0 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  'needs-you': '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 3.4v3M6 8.3v.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  waiting: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 2"/></svg>',
  done: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.4l2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  failed: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.6l4.8 8.6H1.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M6 5v2.2M6 8.6v.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  stopped: '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  unknown: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.7 4.8a1.4 1.4 0 1 1 1.9 1.3c-.4.2-.6.5-.6.9M6 8.6v.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
};

const $ = (id) => document.getElementById(id);
const api = window.orca;
const state = {
  workspaceId: FLEET, project: '', rangeHours: null, tab: 'trace', selected: null, zoom: 1,
  view: 'tree', // 'tree' | 'sequence': what the upper region draws
  seqWorkspace: 'all', // in the all-workspaces scope, the workspace node the sequence shows
  seqTools: null, // whether the sequence has tool rows; null follows the scope's default
  seqJump: false, // scroll the sequence to its newest row on the next draw
  prevAt: null, // when the previous snapshot was taken: rows after it animate in
  data: null, receivedAt: 0, error: null, loading: false, queued: false,
  stats: null, statsFor: null, statsAt: 0, statsLoading: false, // delivery statistics, loaded with their tab
  known: null, // node id → state at the previous snapshot; null before the first one
  fresh: new Set(), // nodes that first appeared in the current snapshot
  turned: new Set(), // nodes whose state changed in the current snapshot
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Every text in the snapshot goes through esc. The values below are not text: a state, kind or
// level picks a CSS class, and a time or count is a number. They are narrowed here as well, so a
// value of an unexpected shape can never add markup.
function tok(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9-]/g, '');
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

// The snapshot's clock, advanced locally while something is running.
function liveNow() {
  const snapshot = state.data.snapshot;
  return snapshot.live ? snapshot.generatedAt + (performance.now() - state.receivedAt) : snapshot.generatedAt;
}

async function load() {
  if (state.loading) {
    state.queued = true;
    return;
  }
  state.loading = true;
  state.loadedAt = performance.now();
  try {
    const input = { workspaceId: state.workspaceId };
    if (state.rangeHours) input.rangeHours = state.rangeHours;
    if (state.project) input.project = state.project;
    const data = await api.plugin.request('trace.snapshot', input, { timeoutMs: 30000 });
    const next = new Map(data.snapshot.nodes.map((node) => [node.id, node.state]));
    state.fresh = new Set();
    state.turned = new Set();
    if (state.known) {
      for (const [id, nodeState] of next) {
        if (!state.known.has(id)) state.fresh.add(id);
        else if (state.known.get(id) !== nodeState) state.turned.add(id);
      }
    }
    state.known = next;
    state.prevAt = state.data ? state.data.snapshot.generatedAt : null;
    state.data = data;
    state.receivedAt = performance.now();
    state.error = null;
  } catch (error) {
    state.error = `${error?.code ?? 'error'}: ${error?.message ?? error}`;
  } finally {
    state.loading = false;
  }
  render();
  if (state.queued) {
    state.queued = false;
    void load();
  }
}

const drawn = new WeakMap(); // region → the HTML it shows
const held = new WeakMap(); // region → when a redraw was first held back

// Replaces a region's HTML when it changed. `force` is for the person's own actions; `follow`
// keeps a region that was scrolled to its end at its end, so new rows stay in sight.
function setHtml(element, html, force, follow = false) {
  if (drawn.get(element) === html) {
    held.delete(element);
    return;
  }
  if (!force && drawn.has(element) && element.matches(':hover')) {
    const since = held.get(element);
    if (since === undefined) held.set(element, performance.now());
    if (since === undefined || performance.now() - since < HOVER_HOLD_MS) return;
  }
  held.delete(element);
  const { scrollLeft, scrollTop } = element;
  const atEnd = element.scrollHeight - scrollTop - element.clientHeight < 48;
  element.style.setProperty('--sync', `-${(performance.now() / 1000).toFixed(3)}s`);
  element.innerHTML = html;
  drawn.set(element, html);
  element.scrollLeft = scrollLeft;
  element.scrollTop = follow && atEnd ? element.scrollHeight : scrollTop;
}

let heavyAt = 0;

// `tick` is the one-second clock: it refreshes counters every time and the timeline/sequence
// regions only every HEAVY_TICK_MS.
function render(force = false, tick = false) {
  const heavy = !tick || performance.now() - heavyAt >= HEAVY_TICK_MS;
  if (heavy) heavyAt = performance.now();
  const width = document.documentElement.clientWidth;
  document.body.classList.toggle('narrow', width < NARROW_PX);
  document.body.classList.toggle('tiny', width < TINY_PX);
  const data = state.data;
  renderBar(data);
  const notices = [...(data?.snapshot.notices ?? []).map((text) => `<div class="notice">${esc(text)}</div>`)];
  if (state.error) notices.unshift(`<div class="notice error">Could not load the trace (${esc(state.error)}).</div>`);
  setHtml($('notices'), notices.join(''), true);
  if (!data) return;
  const snapshot = data.snapshot;
  const now = liveNow();
  const sequence = state.view === 'sequence';
  document.body.classList.toggle('seq-view', sequence);
  if (heavy || !sequence) setHtml($('graph'), sequence ? seqHtml(snapshot, now, width) : graphHtml(snapshot), force, sequence);
  if (sequence && state.seqJump) {
    state.seqJump = false;
    $('graph').scrollTop = $('graph').scrollHeight;
  }
  $('attn').textContent = snapshot.totals.attention ? String(snapshot.totals.attention) : '';
  $('totals').innerHTML = totalsHtml(snapshot, now);
  for (const tab of TABS) {
    $(`tab-${tab}`).setAttribute('aria-selected', String(state.tab === tab));
    $(`panel-${tab}`).hidden = state.tab !== tab;
  }
  const panel = $(`panel-${state.tab}`);
  if (heavy || state.tab !== 'trace') setHtml(panel, state.tab === 'trace' ? traceHtml(snapshot, now) : state.tab === 'tokens' ? tokensHtml(snapshot) : state.tab === 'delivery' ? deliveryHtml() : eventsHtml(snapshot), force);
  if (state.tab === 'delivery' && (state.statsFor !== state.project || performance.now() - state.statsAt > STATS_MS)) void loadStats();
  $('zoom').hidden = state.tab !== 'trace';
  fillLive(now);
}

// Running durations are left empty in the HTML and filled here, so a ticking clock alone does
// not count as a change to the region.
function fillLive(now) {
  for (const element of document.querySelectorAll('[data-live]')) {
    const text = `${element.dataset.prefix || ''}${fmtDuration(Math.max(0, now - Number(element.dataset.live)))}`;
    if (element.textContent !== text) element.textContent = text;
  }
}

function renderBar(data) {
  const projects = data?.projects ?? [];
  const projectPick = $('project');
  const projectHtml = `<option value="">All projects</option>${projects.map((item) => `<option value="${esc(item.name)}">${esc(item.name)} (${num(item.count)})</option>`).join('')}`;
  if (projectPick.dataset.html !== projectHtml) {
    projectPick.innerHTML = projectHtml;
    projectPick.dataset.html = projectHtml;
  }
  if (data) state.project = data.project ?? '';
  projectPick.value = state.project;
  projectPick.hidden = projects.length < 2;
  const select = $('ws');
  const rows = data?.workspaces ?? [];
  const options = rows.map((row) => `<option value="${esc(row.id)}">${esc(row.name)}${row.focused ? ' (focused)' : ''}</option>`);
  const html = `<option value="${FLEET}">${state.project ? `All active in ${esc(state.project)}` : 'All active workspaces'}</option><option value="${FOCUSED}">Focused workspace</option>${options.join('')}`;
  if (select.dataset.html !== html) {
    select.innerHTML = html;
    select.dataset.html = html;
  }
  select.value = state.workspaceId;
  const range = $('range');
  const ranges = (data?.ranges ?? [1, 6, 24, 168]).map(num);
  const rangeHtml = ranges.map((hours) => `<option value="${hours}">${hours < 24 ? `Last ${hours} h` : hours === 24 ? 'Last 24 h' : `Last ${hours / 24} days`}</option>`).join('');
  if (range.dataset.html !== rangeHtml) {
    range.innerHTML = rangeHtml;
    range.dataset.html = rangeHtml;
  }
  if (data) range.value = String(data.rangeHours);
  const snapshot = data?.snapshot;
  const workspace = snapshot?.workspace;
  renderViewControls(snapshot);
  $('branch').textContent = snapshot?.scope === 'fleet'
    ? `${num(snapshot.totals.workspaces)} active · ${num(snapshot.totals.running)} running`
    : workspace ? [state.workspaceId === FOCUSED ? workspace.name : '', workspace.branch].filter(Boolean).join(' · ') : '';
  $('live').hidden = !snapshot?.live;
}

// ---- Sequence ----------------------------------------------------------------------------

// Tool rows are on by default for one workspace and off for all of them, where the point is
// which agent talked to which.
function seqToolsOn(snapshot) {
  return state.seqTools ?? snapshot?.scope !== 'fleet';
}

function renderViewControls(snapshot) {
  const sequence = state.view === 'sequence';
  $('view-tree').setAttribute('aria-pressed', String(!sequence));
  $('view-seq').setAttribute('aria-pressed', String(sequence));
  const pick = $('seq-ws');
  const tops = (snapshot?.nodes ?? []).filter((node) => node.kind === 'workspace');
  const fleet = snapshot?.scope === 'fleet';
  const html = `<option value="all">All workspaces</option>${tops.map((node) => `<option value="${esc(node.id)}">${esc(node.name)}</option>`).join('')}`;
  if (pick.dataset.html !== html) {
    pick.innerHTML = html;
    pick.dataset.html = html;
  }
  if (!tops.some((node) => node.id === state.seqWorkspace)) state.seqWorkspace = 'all';
  pick.value = state.seqWorkspace;
  pick.hidden = !(sequence && fleet && tops.length > 1);
  $('seq-tools-wrap').hidden = !sequence;
  $('seq-tools').checked = seqToolsOn(snapshot);
  const focused = sequence && state.selected ? snapshot?.nodes.find((node) => node.id === state.selected && (node.kind === 'agent' || node.kind === 'subagent')) : null;
  $('seq-focus').hidden = !focused;
  if (focused) $('seq-focus').textContent = `✕ ${focused.name}`;
}

function laneGlyph(lane) {
  if (lane.kind === 'you') return '<span class="glyph ws" aria-hidden="true">●</span>';
  if (lane.kind === 'orca') return '<span class="glyph ws" aria-hidden="true">◎</span>';
  if (lane.kind === 'tool') return '<span class="glyph tool" aria-hidden="true">⚙</span>';
  return glyph(lane);
}

function seqHtml(snapshot, now, width) {
  const sequence = buildSequence(snapshot, {
    now,
    focusId: state.selected,
    workspaceId: snapshot.scope === 'fleet' ? state.seqWorkspace : 'all',
    tools: seqToolsOn(snapshot),
  });
  // Lanes share the width when they fit, down to a floor; past that the diagram scrolls sideways.
  const laneWidth = Math.max(width < NARROW_PX ? 96 : 112, Math.min(LANE_W, Math.floor((width - GUTTER_W - 6) / Math.max(1, sequence.lanes.length))));
  return sequenceHtml(sequence, { esc, glyph: laneGlyph, newerThan: state.prevAt, selected: state.selected, laneWidth });
}

// ---- Graph -------------------------------------------------------------------------------

function glyph(node) {
  if (node.kind === 'fleet') return '<span class="glyph ws" aria-hidden="true">◎</span>';
  if (node.kind === 'workspace') return '<span class="glyph ws" aria-hidden="true">◆</span>';
  const key = node.agent || node.group || 'agent';
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  const letter = (node.kind === 'subagent' ? node.group : key).trim().charAt(0).toUpperCase() || 'A';
  return `<span class="glyph" style="--h:${hash}" aria-hidden="true">${esc(letter)}</span>`;
}

function pill(nodeState) {
  return `<span class="pill s-${tok(nodeState)}">${own(ICON, nodeState) ?? ''}${esc(own(STATE_LABEL, nodeState) ?? nodeState)}</span>`;
}

// A duration that counts up for a running node (filled by fillLive), or a fixed one.
function durationHtml(node, prefix = '') {
  if (node.startedAt === null) return '';
  if (node.endedAt === null) return `<span data-live="${num(node.startedAt)}" data-prefix="${esc(prefix)}"></span>`;
  return `${esc(prefix)}${fmtDuration(Math.max(0, node.endedAt - node.startedAt))}`;
}

function cardHtml(node, snapshot) {
  const cost = node.total.cost === null ? '' : `<span class="cost" title="Estimated cost${node.total.costPartial ? ', incomplete: some models have no price' : ''}">${fmtCost(node.total.cost)}${node.total.costPartial ? '+' : ''}</span>`;
  const tokens = node.total.tokens ? `${fmtTokens(node.total.tokens)} tok` : '';
  const group = node.kind === 'fleet' || node.kind === 'workspace';
  const left = group ? `${num(node.agentCount)} ${node.agentCount === 1 ? 'agent' : 'agents'}` : node.model ? prettyModel(node.model) : node.source === 'events' ? 'Events only' : '';
  const task = node.kind === 'fleet'
    ? `${num(snapshot.totals.workspaces)} ${snapshot.totals.workspaces === 1 ? 'workspace' : 'workspaces'} · ${num(snapshot.totals.running)} running`
    : node.task || (!group && node.kind !== 'subagent' && node.source === 'events' ? 'No transcript for this agent' : '');
  const classes = ['card', `st-${tok(node.state)}`];
  if (state.selected === node.id) classes.push('selected');
  if (state.fresh.has(node.id)) classes.push('enter');
  if (state.turned.has(node.id)) classes.push('turned');
  return `<div class="card-wrap">
    <div class="tag">${esc(node.group)}</div>
    <button class="${classes.join(' ')}" data-id="${esc(node.id)}" title="${esc(node.name)}${node.task ? ` — ${esc(node.task)}` : ''}${tokens ? `\n${tokens}` : ''}">
      <div class="row1">${glyph(node)}<span class="name">${esc(node.name)}</span>${pill(node.state)}</div>
      <div class="task">${esc(task)}</div>
      ${group && progressOf(snapshot).get(node.id) ? progressBar(progressOf(snapshot).get(node.id)) : ''}
      <div class="meta"><span class="model">${esc(left)}</span>${cost}<span class="time">${durationHtml(node, cost ? '· ' : '')}</span></div>
    </button>
  </div>`;
}

// The class that animates the connector into a node: flowing while it runs, amber while it waits
// on the person.
function edge(node) {
  return node.state === 'running' ? ' flow' : node.state === 'needs-you' ? ' flow wait' : '';
}

function graphHtml(snapshot) {
  const nodes = snapshot.nodes;
  const root = nodes[0];
  const kidsOf = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!kidsOf.has(node.parentId)) kidsOf.set(node.parentId, []);
    kidsOf.get(node.parentId).push(node);
  }
  const subtree = (node) => {
    const kids = kidsOf.get(node.id) ?? [];
    if (!kids.length) return '';
    return `<div class="kids">${kids.map((kid) => `<div class="kid${edge(kid)}">${cardHtml(kid, snapshot)}${subtree(kid)}</div>`).join('')}</div>`;
  };
  const top = kidsOf.get(root.id) ?? [];
  if (!top.length) {
    const empty = snapshot.scope === 'fleet'
      ? 'No active workspaces. A workspace shows here while an agent in it is running or waiting on you, and for 15 minutes after its last activity.'
      : 'No agent activity in this workspace for the selected range.';
    return `<div class="tree"><div class="root-row">${cardHtml(root, snapshot)}</div></div><div class="empty">${empty}</div>`;
  }
  return `<div class="tree">
    <div class="root-row has-kids${edge(root)}">${cardHtml(root, snapshot)}</div>
    <div class="columns">${top.map((node) => `<div class="col${edge(node)}">${cardHtml(node, snapshot)}${subtree(node)}</div>`).join('')}</div>
  </div>`;
}

// ---- Progress ----------------------------------------------------------------------------

const PROGRESS_PARTS = [
  ['done', 'done'], ['failed', 'failed'], ['stopped', 'stopped'], ['running', 'running'], ['needs-you', 'needs you'], ['waiting', 'waiting'], ['unknown', 'unknown'],
];
const progressCache = new WeakMap();

// Agent states per group node (the fleet root and each workspace), from the tree order of the
// snapshot: a workspace node is followed by its agents and subagents.
function progressOf(snapshot) {
  if (progressCache.has(snapshot)) return progressCache.get(snapshot);
  const out = new Map();
  const bump = (id, nodeState) => {
    if (!out.has(id)) out.set(id, { total: 0 });
    const counts = out.get(id);
    counts.total += 1;
    counts[nodeState] = (counts[nodeState] ?? 0) + 1;
  };
  let workspace = null;
  const root = snapshot.nodes[0];
  for (const node of snapshot.nodes) {
    if (node.kind === 'workspace') workspace = node.id;
    if (node.kind !== 'agent' && node.kind !== 'subagent') continue;
    const nodeState = STATE_LABEL[node.state] ? node.state : 'unknown';
    if (workspace) bump(workspace, nodeState);
    if (root && root.id !== workspace) bump(root.id, nodeState);
  }
  progressCache.set(snapshot, out);
  return out;
}

// A stacked bar: settled work (done, failed, stopped) first, then what is still moving.
function progressBar(counts, size = '') {
  if (!counts?.total) return '';
  const settled = (counts.done ?? 0) + (counts.failed ?? 0) + (counts.stopped ?? 0);
  const pct = Math.round((settled / counts.total) * 100);
  const segments = PROGRESS_PARTS.filter(([key]) => counts[key]).map(([key]) => `<i class="p-${key}" style="flex-grow:${counts[key]}"></i>`).join('');
  const tip = `${pct}% settled · ${PROGRESS_PARTS.filter(([key]) => counts[key]).map(([key, label]) => `${counts[key]} ${label}`).join(' · ')}`;
  return `<span class="progress ${size}" role="progressbar" aria-valuemin="0" aria-valuemax="${counts.total}" aria-valuenow="${settled}" title="${esc(tip)}">${segments}</span>`;
}

// ---- Totals ------------------------------------------------------------------------------

function totalsHtml(snapshot, now) {
  const totals = snapshot.totals;
  const cost = totals.cost === null ? '—' : `${fmtCost(totals.cost)}${totals.costPartial ? '+' : ''}`;
  const elapsed = snapshot.range.start === null ? 0 : (snapshot.live ? now : snapshot.range.end) - snapshot.range.start;
  const overall = progressOf(snapshot).get(snapshot.nodes[0]?.id);
  return `<span class="totals-progress" title="Agents finished / agents in range">${overall ? progressBar(overall, 'wide') : ''}<b>${num(totals.settled)}/${num(totals.agents)}</b> <span class="opt">agents</span></span>
    <span title="From the first activity in range to now, or to the last activity when nothing is running"><b>${fmtDuration(Math.max(0, elapsed))}</b></span>
    <span title="Tokens: input, output and cache"><b>${fmtTokens(totals.tokens)}</b> <span class="opt">tok</span></span>
    <span title="Estimated cost from a local price table${totals.costPartial ? '. Incomplete: some models have no price' : ''}"><b>${cost}</b></span>`;
}

// ---- Trace -------------------------------------------------------------------------------

function traceHtml(snapshot, now) {
  const start = snapshot.range.start;
  if (start === null) return '<div class="empty">Nothing to trace yet.</div>';
  const end = snapshot.live ? Math.max(now, start) : snapshot.range.end;
  const span = Math.max(1000, end - start);
  const step = niceStep(span / (6 * state.zoom));
  const ticks = [];
  for (let at = 0; at < span; at += step) ticks.push(`<span class="tick" style="left:${(at / span) * 100}%">${at === 0 ? '0s' : fmtDuration(at, true)}</span>`);
  const byNode = new Map();
  for (const item of snapshot.spans) {
    if (!byNode.has(item.nodeId)) byNode.set(item.nodeId, []);
    byNode.get(item.nodeId).push(item);
  }
  const pct = (value) => `${Math.max(0, Math.min(100, ((value - start) / span) * 100)).toFixed(3)}%`;
  const width = (from, to) => `${Math.max(0, Math.min(100, ((to - from) / span) * 100)).toFixed(3)}%`;
  const nowLine = snapshot.live ? `<span class="nowline" style="left:${pct(end)}"></span>` : '';
  const rows = snapshot.nodes.map((node) => {
    const bars = [];
    if (node.kind === 'fleet' || node.kind === 'workspace') {
      if (node.startedAt !== null) {
        const from = Math.max(node.startedAt, start);
        const to = node.endedAt === null ? end : node.endedAt;
        bars.push(`<span class="bar extent${node.endedAt === null && BUSY.has(node.state) ? ' open' : ''}" style="left:${pct(from)};width:${width(from, to)}"></span>`);
      }
    } else {
      for (const item of byNode.get(node.id) ?? []) {
        const to = item.open ? end : item.end;
        const cls = item.kind === 'state' ? `state-${tok(item.name)}` : `${tok(item.kind)}${item.error ? ' error' : ''}${item.point ? ' point' : ''}`;
        const what = item.kind === 'llm' ? prettyModel(item.name) : item.kind === 'state' ? (item.name === 'blocked' ? 'Needs you' : item.name === 'waiting' ? 'Waiting' : 'Working') : item.name;
        const tip = `${what}${item.label ? ` · ${item.label}` : ''}${item.point ? '' : ` · ${fmtDuration(to - item.start)}`}${item.error ? ' · failed' : ''}${item.open ? ' · running' : ''}`;
        bars.push(`<span class="bar ${cls}${item.open ? ' open' : ''}" style="left:${pct(item.start)};width:${item.point ? '2px' : width(item.start, to)}" title="${esc(tip)}"></span>`);
      }
    }
    const mark = node.state === 'running' ? `<span class="pill s-running bare">${ICON.running}</span>` : node.state === 'needs-you' ? `<span class="pill s-needs-you bare">${ICON['needs-you']}</span>` : '';
    return `<div class="trow k-${tok(node.kind)}${state.selected === node.id ? ' selected' : ''}" role="button" tabindex="0" data-id="${esc(node.id)}" title="${esc(node.name)}">
      <span class="t-name"><span class="indent" style="--d:${num(node.depth)}"></span>${glyph(node)}<span class="label">${esc(node.name)}</span>${mark}</span>
      <span class="lane" style="--tick-w:${(step / span) * 100}%">${bars.join('')}${nowLine}</span>
      <span class="t-dur">${durationHtml(node)}</span>
    </div>`;
  });
  const dropped = snapshot.spansDropped ? `<span>${num(snapshot.spansDropped)} older calls are not drawn.</span>` : '';
  return `<div class="trace" style="--zoom:${state.zoom}">
    <div class="thead"><span class="h-name">Agent · call</span><span class="axis">${ticks.join('')}</span><span class="h-dur"></span></div>
    ${rows.join('')}
    <div class="legend"><span><i style="background:color-mix(in srgb, var(--llm) 62%, transparent)"></i>Model</span><span><i style="background:var(--tool)"></i>Tool call</span><span><i style="background:var(--failed)"></i>Failed call</span><span><i style="background:var(--attention);height:5px"></i>Needs you</span><span><i style="background:color-mix(in srgb, var(--muted-fg) 40%, transparent);height:5px"></i>Waiting</span><span><i style="background:color-mix(in srgb, var(--running) 45%, transparent)"></i>Working (events only)</span>${dropped}</div>
  </div>`;
}

// ---- Delivery ----------------------------------------------------------------------------

const TABS = ['trace', 'tokens', 'events', 'delivery'];

async function loadStats() {
  if (state.statsLoading) return;
  state.statsLoading = true;
  state.statsAt = performance.now();
  const project = state.project;
  try {
    const answer = await api.plugin.request('trace.stats', { project }, { timeoutMs: 30000 });
    state.stats = { ...answer, project };
  } catch (error) {
    state.stats = { stats: null, notice: `Could not load delivery statistics (${error?.code ?? 'error'}: ${error?.message ?? error}).`, project };
  } finally {
    state.statsFor = project;
    state.statsLoading = false;
  }
  render(true);
}

const pctText = (value) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`);
const durText = (ms) => (ms === null || ms === undefined ? '—' : fmtDuration(ms));
const rateText = (perDay) => (perDay >= 1 ? `${perDay.toFixed(perDay >= 10 ? 0 : 1)}/day` : perDay > 0 ? `${(perDay * 7).toFixed(1)}/week` : '0');

// DORA performance bands (State of DevOps): elite, high, medium, low.
function band(metric, value) {
  if (value === null || value === undefined) return '';
  const levels = {
    deploys: value >= 1 ? 'elite' : value >= 1 / 7 ? 'high' : value >= 1 / 30 ? 'medium' : 'low',
    lead: value <= 86_400_000 ? 'elite' : value <= 7 * 86_400_000 ? 'high' : value <= 30 * 86_400_000 ? 'medium' : 'low',
    cfr: value <= 0.05 ? 'elite' : value <= 0.1 ? 'high' : value <= 0.15 ? 'medium' : 'low',
    restore: value <= 3_600_000 ? 'elite' : value <= 86_400_000 ? 'high' : value <= 7 * 86_400_000 ? 'medium' : 'low',
  };
  return `<span class="band b-${levels[metric]}">${levels[metric]}</span>`;
}

function doraTiles(dora) {
  const tile = (label, value, extra, tip) => `<div class="tile" title="${esc(tip)}"><div class="t-label">${label}</div><div class="t-value">${value}</div><div class="t-extra">${extra}</div></div>`;
  return `<div class="tiles">
    ${tile('Deployment frequency', rateText(dora.deploysPerDay), `${num(dora.deploys)} deploys ${band('deploys', dora.deploysPerDay)}`, 'Successful runs of the deploy workflow on the production branch')}
    ${tile('Lead time for changes', durText(dora.leadTimeMs), band('lead', dora.leadTimeMs), 'Median time from pull request opened to merged, for PRs merged in the window')}
    ${tile('Change failure rate', pctText(dora.changeFailureRate), `${num(dora.failedDeploys)} failed ${band('cfr', dora.changeFailureRate)}`, 'Failed deploy runs / finished deploy runs')}
    ${tile('Time to restore', durText(dora.timeToRestoreMs), `${dora.unrestored ? `${num(dora.unrestored)} not restored ` : ''}${band('restore', dora.timeToRestoreMs)}`, 'Median time from a failed deploy run to the next successful one')}
  </div>`;
}

function deliveryHtml() {
  const answer = state.stats;
  if (!answer || state.statsFor !== state.project) return '<div class="empty">Loading delivery statistics…</div>';
  if (!answer.stats) return `<div class="empty">${esc(answer.notice ?? 'No delivery statistics.')}</div>`;
  const stats = answer.stats;
  const day = stats.total['24h'];
  const week = stats.total['7d'];
  const prRow = (label, key) => `<tr><td class="left">${label}</td><td>${num(day.prs[key])}</td><td>${num(week.prs[key])}</td></tr>`;
  const authors = (day.authors.length ? day.authors : week.authors).slice(0, 12);
  const authorRows = authors.map((row) => {
    const weekRow = week.authors.find((item) => item.login === row.login) ?? row;
    const dayRow = day.authors.find((item) => item.login === row.login) ?? { opened: 0, merged: 0 };
    return `<tr><td class="left">${esc(row.login)}${row.bot ? ' <span class="dim-text">bot</span>' : ''}</td><td>${num(dayRow.opened)} / ${num(dayRow.merged)}</td><td>${num(weekRow.opened)} / ${num(weekRow.merged)}</td><td><span class="add">+${num(weekRow.additions)}</span> <span class="del">−${num(weekRow.deletions)}</span></td></tr>`;
  }).join('');
  const projects = stats.projects.length > 1 ? `<table class="stats"><thead><tr><th class="left">Project</th><th>PRs merged 24 h</th><th>PRs merged 7 d</th><th>Deploys 7 d</th><th>Lead time 7 d</th><th>CFR 7 d</th></tr></thead><tbody>${stats.projects.map((row) => {
    const w = row.windows['7d'];
    return `<tr><td class="left" title="${esc(row.repo)}${row.deploySource ? ` · deploys: ${esc(row.deploySource)}` : ''}">${esc(row.project)}</td><td>${num(row.windows['24h'].prs.merged)}</td><td>${num(w.prs.merged)}</td><td>${num(w.dora.deploys)}</td><td>${durText(w.dora.leadTimeMs)}</td><td>${pctText(w.dora.changeFailureRate)}</td></tr>`;
  }).join('')}</tbody></table>` : '';
  const errors = Object.entries(stats.errors ?? {}).map(([name, message]) => `<div class="notice">${esc(name)}: ${esc(message)}</div>`).join('');
  const sources = stats.projects.map((row) => `${esc(row.project)}: ${row.deploySource ? esc(row.deploySource) : 'no deploy workflow found'}`).join(' · ');
  return `<div class="delivery">
    ${errors}
    <h3>Last 24 hours ${state.project ? `· ${esc(state.project)}` : '· all projects'}</h3>
    ${doraTiles(day.dora)}
    <h3>Last 7 days</h3>
    ${doraTiles(week.dora)}
    <div class="stats-grid">
      <table class="stats"><thead><tr><th class="left">Pull requests</th><th>24 h</th><th>7 d</th></tr></thead><tbody>
        ${prRow('Opened', 'opened')}${prRow('Merged', 'merged')}${prRow('Closed without merge', 'closed')}
        <tr><td class="left">Open now</td><td colspan="2">${num(day.prs.open)}</td></tr>
        <tr><td class="left">Lines merged</td><td><span class="add">+${num(day.prs.additions)}</span> <span class="del">−${num(day.prs.deletions)}</span></td><td><span class="add">+${num(week.prs.additions)}</span> <span class="del">−${num(week.prs.deletions)}</span></td></tr>
      </tbody></table>
      <table class="stats"><thead><tr><th class="left">Contributor</th><th>24 h opened / merged</th><th>7 d opened / merged</th><th>7 d lines</th></tr></thead><tbody>${authorRows || '<tr><td class="left dim-text" colspan="4">No pull requests in the window.</td></tr>'}</tbody></table>
    </div>
    ${projects}
    <div class="legend">From GitHub through the ${esc(answer.hub ?? 'hub')} hub's <code>gh</code> sign-in, refreshed every 5 minutes (fetched ${fmtClock(stats.fetchedAt)}). DORA metrics are proxies: lead time is PR opened → merged; deploys are ${sources}. Bands follow the DORA report (elite/high/medium/low).</div>
  </div>`;
}

// ---- Tokens & cost -----------------------------------------------------------------------

function tokensHtml(snapshot) {
  const cell = (value) => (value ? fmtTokens(value) : '<span class="dim-text">0</span>');
  const fleet = snapshot.scope === 'fleet';
  const base = fleet ? 2 : 1;
  const rows = snapshot.nodes.filter((node) => node.id !== 'root').map((node) => {
    const name = `<div class="cell"><span style="flex:0 0 ${Math.max(0, num(node.depth) - base) * 14}px"></span>${glyph(node)}<span class="label" style="overflow:hidden;text-overflow:ellipsis">${esc(node.name)}</span></div>`;
    if (node.kind === 'workspace') {
      const total = node.total.cost === null ? '' : `${fmtCost(node.total.cost)}${node.total.costPartial ? '+' : ''}`;
      return `<tr class="group"><td>${name}</td><td class="left dim-text" colspan="5">${esc(node.task)}</td><td>${cell(node.total.tokens)}</td><td>${total}</td></tr>`;
    }
    const tokens = node.tokens;
    if (!tokens) return `<tr><td>${name}</td><td class="left dim-text" colspan="7">Events only: Orca reports this agent's status and tool calls, not its tokens.</td></tr>`;
    const cost = node.cost === null ? '<span class="dim-text" title="No price for this model in the local table">no price</span>' : `${fmtCost(node.cost)}${node.costPartial ? '+' : ''}`;
    const reported = typeof node.reportedCost === 'number' ? `<div class="dim-text" title="Reported by the agent over OpenTelemetry, for the whole session including subagents">${fmtCost(node.reportedCost)} reported</div>` : '';
    return `<tr><td>${name}</td><td class="left">${esc(prettyModel(node.model) || '—')}</td><td>${cell(tokens.input)}</td><td>${cell(tokens.output)}</td><td>${cell(tokens.cacheRead)}</td><td>${cell(tokens.cacheWrite)}</td><td>${cell(tokens.total)}</td><td>${cost}${reported}</td></tr>`;
  });
  if (!rows.length) return '<div class="empty">No agents in range.</div>';
  const totals = snapshot.totals;
  const sum = (field) => snapshot.nodes.reduce((total, node) => total + (node.tokens?.[field] ?? 0), 0);
  return `<table>
    <thead><tr><th>Agent</th><th class="left">Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Total</th><th>Est. cost</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot><tr><td>Total</td><td></td><td>${fmtTokens(sum('input'))}</td><td>${fmtTokens(sum('output'))}</td><td>${fmtTokens(sum('cacheRead'))}</td><td>${fmtTokens(sum('cacheWrite'))}</td><td>${fmtTokens(totals.tokens)}</td><td>${totals.cost === null ? '—' : `${fmtCost(totals.cost)}${totals.costPartial ? '+' : ''}`}</td></tr></tfoot>
  </table>
  <div class="foot">Each agent row is that agent's own usage${fleet ? '; a workspace row is the sum of its agents' : ''}. Cost is an estimate from a local price table${snapshot.pricesAsOf ? ` (prices as of ${esc(snapshot.pricesAsOf)})` : ''}, not a bill; a “+” means some usage had no price. “Reported” is the cost the agent itself sent over OpenTelemetry to an Agent Trace hub (remote hosts).</div>`;
}

// ---- Events ------------------------------------------------------------------------------

function eventsHtml(snapshot) {
  if (!snapshot.events.length) return '<div class="empty">No events in range.</div>';
  const names = new Map(snapshot.nodes.map((node) => [node.id, node.name]));
  return snapshot.events.map((event) => `<div class="event">
    <span class="when">${fmtClock(event.ts)}</span><span class="dot ${tok(event.level)}" title="${esc(event.level)}"></span>
    <span class="who">${esc(names.get(event.nodeId) ?? '')}</span><span class="what" title="${esc(event.text)}">${esc(event.text)}</span>
  </div>`).join('');
}

// ---- Wiring ------------------------------------------------------------------------------

function select(id) {
  state.selected = state.selected === id ? null : id;
  render(true);
  if (!state.selected) return;
  for (const element of document.querySelectorAll(`[data-id="${CSS.escape(state.selected)}"]`)) {
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function wire() {
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-id]');
    if (target) select(target.dataset.id);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target.closest('.trow[data-id]');
    if (!target) return;
    event.preventDefault();
    select(target.dataset.id);
  });
  for (const [id, view] of [['view-tree', 'tree'], ['view-seq', 'sequence']]) {
    $(id).addEventListener('click', () => {
      state.view = view;
      state.seqJump = view === 'sequence';
      render(true);
    });
  }
  $('seq-ws').addEventListener('change', (event) => {
    state.seqWorkspace = event.target.value;
    state.seqJump = true;
    render(true);
  });
  $('seq-tools').addEventListener('change', (event) => {
    state.seqTools = event.target.checked;
    render(true);
  });
  $('seq-focus').addEventListener('click', () => {
    state.selected = null;
    render(true);
  });
  for (const tab of TABS) {
    $(`tab-${tab}`).addEventListener('click', () => {
      state.tab = tab;
      render(true);
    });
  }
  $('project').addEventListener('change', (event) => {
    state.project = event.target.value;
    state.workspaceId = FLEET;
    state.selected = null;
    state.known = null;
    void load();
  });
  $('ws').addEventListener('change', (event) => {
    state.workspaceId = event.target.value || FLEET;
    state.selected = null;
    state.rangeHours = null; // each scope opens on its own default range
    state.known = null;
    void load();
  });
  $('range').addEventListener('change', (event) => {
    state.rangeHours = Number(event.target.value);
    void load();
  });
  $('zoom-in').addEventListener('click', () => {
    state.zoom = ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(state.zoom) + 1)];
    render(true);
  });
  $('zoom-out').addEventListener('click', () => {
    state.zoom = ZOOMS[Math.max(0, ZOOMS.indexOf(state.zoom) - 1)];
    render(true);
  });
  // A redraw held back while the pointer was over a region happens as soon as it leaves.
  for (const id of ['graph', 'panel-trace', 'panel-tokens', 'panel-events', 'panel-delivery']) $(id).addEventListener('mouseleave', () => render());
  window.addEventListener('resize', () => render(true));
  setInterval(() => {
    if (!document.hidden) void load();
  }, POLL_MS);
  setInterval(() => {
    if (!document.hidden && state.data?.snapshot.live) render(false, true);
  }, TICK_MS);
  let timer = null;
  api.plugin.on('trace.changed', () => {
    if (document.hidden) return; // the poll catches up when the panel is shown again
    clearTimeout(timer);
    const gap = MIN_LOAD_GAP_MS - (performance.now() - (state.loadedAt ?? 0));
    timer = setTimeout(() => void load(), Math.max(250, gap));
  });
}

async function boot() {
  // An editor tab may carry its own view settings in the .agenttrace file.
  if (api.document?.get) {
    try {
      const doc = await api.document.get();
      const config = JSON.parse(doc?.content?.text || '{}');
      if (typeof config.workspaceId === 'string' && config.workspaceId) state.workspaceId = config.workspaceId;
      if (typeof config.project === 'string') state.project = config.project;
      if (config.view === 'sequence') state.view = 'sequence';
      if (Number.isFinite(config.rangeHours)) state.rangeHours = config.rangeHours;
    } catch {
      // an empty or hand-edited file: use the defaults
    }
  }
  wire();
  await load();
}

void boot();
