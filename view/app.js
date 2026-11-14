// The view, shared by the sidebar panel (index.html) and the editor tab (editor.html). It asks the
// plugin's worker for `trace.snapshot` and draws it: agent tree, trace timeline, tokens, events.
// No framework, no network: everything is built from the snapshot.
//
// Motion: the worker is polled every few seconds, and between polls a one-second clock advances
// "now" locally, so running durations count up and running bars grow. A region is redrawn only
// when its HTML changes, and animations are started with a negative delay equal to the page clock
// (--sync), so a redraw continues an animation instead of restarting it.
import { fmtClock, fmtCost, fmtDuration, fmtTokens, niceStep, prettyModel } from './format.js';

const POLL_MS = 3000;
const TICK_MS = 1000;
const NARROW_PX = 640;
const TINY_PX = 340;
// A redraw waits while the pointer is over the region, so a tooltip or a click is not lost, but
// never longer than this.
const HOVER_HOLD_MS = 4000;
const ZOOMS = [1, 2, 4, 8, 16];
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
  workspaceId: FLEET, rangeHours: null, tab: 'trace', selected: null, zoom: 1,
  data: null, receivedAt: 0, error: null, loading: false, queued: false,
  known: null, // node id → state at the previous snapshot; null before the first one
  fresh: new Set(), // nodes that first appeared in the current snapshot
  turned: new Set(), // nodes whose state changed in the current snapshot
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

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
  try {
    const input = { workspaceId: state.workspaceId };
    if (state.rangeHours) input.rangeHours = state.rangeHours;
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

// Replaces a region's HTML when it changed. `force` is for the person's own actions.
function setHtml(element, html, force) {
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
  element.style.setProperty('--sync', `-${(performance.now() / 1000).toFixed(3)}s`);
  element.innerHTML = html;
  drawn.set(element, html);
  element.scrollLeft = scrollLeft;
  element.scrollTop = scrollTop;
}

function render(force = false) {
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
  setHtml($('graph'), graphHtml(snapshot), force);
  $('attn').textContent = snapshot.totals.attention ? String(snapshot.totals.attention) : '';
  $('totals').innerHTML = totalsHtml(snapshot, now);
  for (const tab of ['trace', 'tokens', 'events']) {
    $(`tab-${tab}`).setAttribute('aria-selected', String(state.tab === tab));
    $(`panel-${tab}`).hidden = state.tab !== tab;
  }
  const panel = $(`panel-${state.tab}`);
  setHtml(panel, state.tab === 'trace' ? traceHtml(snapshot, now) : state.tab === 'tokens' ? tokensHtml(snapshot) : eventsHtml(snapshot), force);
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
  const select = $('ws');
  const rows = data?.workspaces ?? [];
  const options = rows.map((row) => `<option value="${esc(row.id)}">${esc(row.name)}${row.focused ? ' (focused)' : ''}</option>`);
  const html = `<option value="${FLEET}">All active workspaces</option><option value="${FOCUSED}">Focused workspace</option>${options.join('')}`;
  if (select.dataset.html !== html) {
    select.innerHTML = html;
    select.dataset.html = html;
  }
  select.value = state.workspaceId;
  const range = $('range');
  const ranges = data?.ranges ?? [1, 6, 24, 168];
  const rangeHtml = ranges.map((hours) => `<option value="${hours}">${hours < 24 ? `Last ${hours} h` : hours === 24 ? 'Last 24 h' : `Last ${hours / 24} days`}</option>`).join('');
  if (range.dataset.html !== rangeHtml) {
    range.innerHTML = rangeHtml;
    range.dataset.html = rangeHtml;
  }
  if (data) range.value = String(data.rangeHours);
  const snapshot = data?.snapshot;
  const workspace = snapshot?.workspace;
  $('branch').textContent = snapshot?.scope === 'fleet'
    ? `${snapshot.totals.workspaces} active · ${snapshot.totals.running} running`
    : workspace ? [state.workspaceId === FOCUSED ? workspace.name : '', workspace.branch].filter(Boolean).join(' · ') : '';
  $('live').hidden = !snapshot?.live;
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
  return `<span class="pill s-${nodeState}">${ICON[nodeState] ?? ''}${esc(STATE_LABEL[nodeState] ?? nodeState)}</span>`;
}

// A duration that counts up for a running node (filled by fillLive), or a fixed one.
function durationHtml(node, prefix = '') {
  if (node.startedAt === null) return '';
  if (node.endedAt === null) return `<span data-live="${node.startedAt}" data-prefix="${esc(prefix)}"></span>`;
  return `${esc(prefix)}${fmtDuration(Math.max(0, node.endedAt - node.startedAt))}`;
}

function cardHtml(node, snapshot) {
  const cost = node.total.cost === null ? '' : `<span class="cost" title="Estimated cost${node.total.costPartial ? ', incomplete: some models have no price' : ''}">${fmtCost(node.total.cost)}${node.total.costPartial ? '+' : ''}</span>`;
  const tokens = node.total.tokens ? `${fmtTokens(node.total.tokens)} tok` : '';
  const group = node.kind === 'fleet' || node.kind === 'workspace';
  const left = group ? `${node.agentCount} ${node.agentCount === 1 ? 'agent' : 'agents'}` : node.model ? prettyModel(node.model) : node.source === 'events' ? 'Events only' : '';
  const task = node.kind === 'fleet'
    ? `${snapshot.totals.workspaces} ${snapshot.totals.workspaces === 1 ? 'workspace' : 'workspaces'} · ${snapshot.totals.running} running`
    : node.task || (!group && node.kind !== 'subagent' && node.source === 'events' ? 'No transcript for this agent' : '');
  const classes = ['card', `st-${node.state}`];
  if (state.selected === node.id) classes.push('selected');
  if (state.fresh.has(node.id)) classes.push('enter');
  if (state.turned.has(node.id)) classes.push('turned');
  return `<div class="card-wrap">
    <div class="tag">${esc(node.group)}</div>
    <button class="${classes.join(' ')}" data-id="${esc(node.id)}" title="${esc(node.name)}${node.task ? ` — ${esc(node.task)}` : ''}${tokens ? `\n${tokens}` : ''}">
      <div class="row1">${glyph(node)}<span class="name">${esc(node.name)}</span>${pill(node.state)}</div>
      <div class="task">${esc(task)}</div>
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

// ---- Totals ------------------------------------------------------------------------------

function totalsHtml(snapshot, now) {
  const totals = snapshot.totals;
  const cost = totals.cost === null ? '—' : `${fmtCost(totals.cost)}${totals.costPartial ? '+' : ''}`;
  const elapsed = snapshot.range.start === null ? 0 : (snapshot.live ? now : snapshot.range.end) - snapshot.range.start;
  return `<span title="Agents finished / agents in range"><b>${totals.settled}/${totals.agents}</b> <span class="opt">agents</span></span>
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
        const cls = item.kind === 'state' ? `state-${item.name}` : `${item.kind}${item.error ? ' error' : ''}${item.point ? ' point' : ''}`;
        const what = item.kind === 'llm' ? prettyModel(item.name) : item.kind === 'state' ? (item.name === 'blocked' ? 'Needs you' : item.name === 'waiting' ? 'Waiting' : 'Working') : item.name;
        const tip = `${what}${item.label ? ` · ${item.label}` : ''}${item.point ? '' : ` · ${fmtDuration(to - item.start)}`}${item.error ? ' · failed' : ''}${item.open ? ' · running' : ''}`;
        bars.push(`<span class="bar ${cls}${item.open ? ' open' : ''}" style="left:${pct(item.start)};width:${item.point ? '2px' : width(item.start, to)}" title="${esc(tip)}"></span>`);
      }
    }
    const mark = node.state === 'running' ? `<span class="pill s-running bare">${ICON.running}</span>` : node.state === 'needs-you' ? `<span class="pill s-needs-you bare">${ICON['needs-you']}</span>` : '';
    return `<div class="trow k-${node.kind}${state.selected === node.id ? ' selected' : ''}" role="button" tabindex="0" data-id="${esc(node.id)}" title="${esc(node.name)}">
      <span class="t-name"><span class="indent" style="--d:${node.depth}"></span>${glyph(node)}<span class="label">${esc(node.name)}</span>${mark}</span>
      <span class="lane" style="--tick-w:${(step / span) * 100}%">${bars.join('')}${nowLine}</span>
      <span class="t-dur">${durationHtml(node)}</span>
    </div>`;
  });
  const dropped = snapshot.spansDropped ? `<span>${snapshot.spansDropped} older calls are not drawn.</span>` : '';
  return `<div class="trace" style="--zoom:${state.zoom}">
    <div class="thead"><span class="h-name">Agent · call</span><span class="axis">${ticks.join('')}</span><span class="h-dur"></span></div>
    ${rows.join('')}
    <div class="legend"><span><i style="background:color-mix(in srgb, var(--llm) 62%, transparent)"></i>Model</span><span><i style="background:var(--tool)"></i>Tool call</span><span><i style="background:var(--failed)"></i>Failed call</span><span><i style="background:var(--attention);height:5px"></i>Needs you</span><span><i style="background:color-mix(in srgb, var(--muted-fg) 40%, transparent);height:5px"></i>Waiting</span><span><i style="background:color-mix(in srgb, var(--running) 45%, transparent)"></i>Working (events only)</span>${dropped}</div>
  </div>`;
}

// ---- Tokens & cost -----------------------------------------------------------------------

function tokensHtml(snapshot) {
  const cell = (value) => (value ? fmtTokens(value) : '<span class="dim-text">0</span>');
  const fleet = snapshot.scope === 'fleet';
  const base = fleet ? 2 : 1;
  const rows = snapshot.nodes.filter((node) => node.id !== 'root').map((node) => {
    const name = `<div class="cell"><span style="flex:0 0 ${Math.max(0, node.depth - base) * 14}px"></span>${glyph(node)}<span class="label" style="overflow:hidden;text-overflow:ellipsis">${esc(node.name)}</span></div>`;
    if (node.kind === 'workspace') {
      const total = node.total.cost === null ? '' : `${fmtCost(node.total.cost)}${node.total.costPartial ? '+' : ''}`;
      return `<tr class="group"><td>${name}</td><td class="left dim-text" colspan="5">${esc(node.task)}</td><td>${cell(node.total.tokens)}</td><td>${total}</td></tr>`;
    }
    const tokens = node.tokens;
    if (!tokens) return `<tr><td>${name}</td><td class="left dim-text" colspan="7">Events only: Orca reports this agent's status and tool calls, not its tokens.</td></tr>`;
    const cost = node.cost === null ? '<span class="dim-text" title="No price for this model in the local table">no price</span>' : `${fmtCost(node.cost)}${node.costPartial ? '+' : ''}`;
    return `<tr><td>${name}</td><td class="left">${esc(prettyModel(node.model) || '—')}</td><td>${cell(tokens.input)}</td><td>${cell(tokens.output)}</td><td>${cell(tokens.cacheRead)}</td><td>${cell(tokens.cacheWrite)}</td><td>${cell(tokens.total)}</td><td>${cost}</td></tr>`;
  });
  if (!rows.length) return '<div class="empty">No agents in range.</div>';
  const totals = snapshot.totals;
  const sum = (field) => snapshot.nodes.reduce((total, node) => total + (node.tokens?.[field] ?? 0), 0);
  return `<table>
    <thead><tr><th>Agent</th><th class="left">Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Total</th><th>Est. cost</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot><tr><td>Total</td><td></td><td>${fmtTokens(sum('input'))}</td><td>${fmtTokens(sum('output'))}</td><td>${fmtTokens(sum('cacheRead'))}</td><td>${fmtTokens(sum('cacheWrite'))}</td><td>${fmtTokens(totals.tokens)}</td><td>${totals.cost === null ? '—' : `${fmtCost(totals.cost)}${totals.costPartial ? '+' : ''}`}</td></tr></tfoot>
  </table>
  <div class="foot">Each agent row is that agent's own usage${fleet ? '; a workspace row is the sum of its agents' : ''}. Cost is an estimate from a local price table${snapshot.pricesAsOf ? ` (prices as of ${esc(snapshot.pricesAsOf)})` : ''}, not a bill; a “+” means some usage had no price.</div>`;
}

// ---- Events ------------------------------------------------------------------------------

function eventsHtml(snapshot) {
  if (!snapshot.events.length) return '<div class="empty">No events in range.</div>';
  const names = new Map(snapshot.nodes.map((node) => [node.id, node.name]));
  return snapshot.events.map((event) => `<div class="event">
    <span class="when">${fmtClock(event.ts)}</span><span class="dot ${esc(event.level)}" title="${esc(event.level)}"></span>
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
  for (const tab of ['trace', 'tokens', 'events']) {
    $(`tab-${tab}`).addEventListener('click', () => {
      state.tab = tab;
      render(true);
    });
  }
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
  for (const id of ['graph', 'panel-trace', 'panel-tokens', 'panel-events']) $(id).addEventListener('mouseleave', () => render());
  window.addEventListener('resize', () => render(true));
  setInterval(() => {
    if (!document.hidden) void load();
  }, POLL_MS);
  setInterval(() => {
    if (!document.hidden && state.data?.snapshot.live) render();
  }, TICK_MS);
  let timer = null;
  api.plugin.on('trace.changed', () => {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 250);
  });
}

async function boot() {
  // An editor tab may carry its own view settings in the .agenttrace file.
  if (api.document?.get) {
    try {
      const doc = await api.document.get();
      const config = JSON.parse(doc?.content?.text || '{}');
      if (typeof config.workspaceId === 'string' && config.workspaceId) state.workspaceId = config.workspaceId;
      if (Number.isFinite(config.rangeHours)) state.rangeHours = config.rangeHours;
    } catch {
      // an empty or hand-edited file: use the defaults
    }
  }
  wire();
  await load();
}

void boot();
