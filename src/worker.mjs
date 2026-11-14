// Composition root: the only file that knows Orca. It listens to Orca's agent events and tool
// hook (any agent), reads transcripts where an adapter exists (tokens, cost, subagents), and
// answers the view's `trace.snapshot` request. Every Orca call is best-effort: a failure goes to
// orca.log and the view gets what is known.
import { createLiveStore } from './core/live.mjs';
import { requestCost } from './core/pricing.mjs';
import { PRICES_AS_OF } from './core/prices-data.mjs';
import { buildFleetSnapshot, buildSnapshot } from './core/snapshot.mjs';
import { createTranscriptReader } from './node/transcripts.mjs';

const STORE_KEY = 'live-v1';
const ALIASES_KEY = 'aliases-v1';
// What the view sends as workspaceId for every active workspace, and for the focused one.
const FLEET = 'all';
const FOCUSED = 'focused';
const FLEET_RANGE_HOURS = 1;
const STORE_MAX_BYTES = 200 * 1024; // Orca caps a stored value at 256 KiB
const ANSWER_MAX_BYTES = 900 * 1024; // Orca caps a panel answer at 1 MiB
const RANGES_HOURS = [1, 6, 24, 168];
const DEFAULT_RANGE_HOURS = 6;
const KEEP_PANES_MS = 7 * 86_400_000;
const WORKSPACES_TTL_MS = 15_000;
const SETTINGS_TTL_MS = 10_000;
const SEED_TTL_MS = 5_000;

let running = null;

export default async function activate(orca) {
  running = await start(orca);
}

export async function deactivate() {
  const worker = running;
  running = null;
  await worker?.stop();
}

// Exported for tests: `orca` may be a stand-in, and `options` replaces the clock and home folder.
export async function start(orca, { now = () => Date.now(), home, persistMs = 5_000, notifyMs = 400 } = {}) {
  const live = createLiveStore();
  const warned = new Set();
  const aliases = new Map(); // a workspace id as events name it → its id in workspace.list
  let settings = { at: -Infinity, rangeHours: DEFAULT_RANGE_HOURS, claudeDir: '', codexDir: '', toolLabels: true };
  let reader = null;
  let readerKey = '';
  let context = null; // the focused workspace, as workspace.readContext answers
  let workspaces = { at: -Infinity, rows: [] };
  let seededAt = -Infinity;
  let statusSupported = null; // whether workspace.list takes includeStatus (host API 1.7)
  let aliasesDirty = false;
  let notifyTimer = null;
  let persistTimer = null;
  let chain = Promise.resolve();
  let stopped = false;
  const disposables = [];

  const log = (message) => {
    try {
      orca.log(`Agent Trace: ${message}`);
    } catch {
      // logging must never take the worker down
    }
  };
  const warnOnce = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    log(message);
  };
  const has = (method) => {
    try {
      return orca.host.has(method);
    } catch {
      return false;
    }
  };
  // null when the method is missing, not granted or fails.
  const call = async (method, params = {}) => {
    if (!has(method)) return null;
    try {
      return await orca.host.call(method, params);
    } catch (error) {
      warnOnce(`${method}:${error?.code}`, `${method} failed: ${error?.code ?? ''} ${error?.message ?? error}`);
      return null;
    }
  };

  async function readSettings() {
    if (now() - settings.at < SETTINGS_TTL_MS) return settings;
    const raw = (await call('settings.get'))?.settings ?? {};
    const hours = Number(raw.rangeHours);
    settings = {
      at: now(),
      rangeHours: RANGES_HOURS.includes(hours) ? hours : DEFAULT_RANGE_HOURS,
      claudeDir: typeof raw.claudeDir === 'string' ? raw.claudeDir.trim() : '',
      codexDir: typeof raw.codexDir === 'string' ? raw.codexDir.trim() : '',
      toolLabels: raw.toolLabels !== false,
    };
    const key = JSON.stringify([settings.claudeDir, settings.codexDir, settings.toolLabels]);
    if (!reader || key !== readerKey) {
      readerKey = key;
      reader = createTranscriptReader({
        home, claudeDir: settings.claudeDir, codexDir: settings.codexDir, cost: requestCost, toolLabels: settings.toolLabels, now,
      });
    }
    return settings;
  }

  async function listWorkspaces() {
    if (now() - workspaces.at < WORKSPACES_TTL_MS) return workspaces.rows;
    let answer = null;
    if (statusSupported !== false && has('workspace.list')) {
      // Older hosts refuse the parameter: ask once, then stop asking.
      try {
        answer = await orca.host.call('workspace.list', { includeStatus: true });
        statusSupported = true;
      } catch {
        statusSupported = false;
      }
    }
    if (!answer) answer = await call('workspace.list');
    const rows = Array.isArray(answer?.workspaces) ? answer.workspaces.filter((row) => row && typeof row.id === 'string') : [];
    workspaces = { at: now(), rows };
    return rows;
  }

  function rowFor(rows, ctx) {
    if (!ctx) return null;
    const only = (list) => (list.length === 1 ? list[0] : null);
    return (
      rows.find((row) => ctx.workspaceId && (row.id === ctx.workspaceId || row.id === aliases.get(ctx.workspaceId))) ??
      only(rows.filter((row) => row.name === ctx.displayName && (row.branch ?? '') === (ctx.branch ?? ''))) ??
      only(rows.filter((row) => row.name === ctx.displayName)) ??
      only(rows.filter((row) => row.branch && row.branch === ctx.branch)) ??
      null
    );
  }

  // The workspace.list row a pane belongs to, or null. Before host API 1.7 an event names the
  // workspace by Orca's raw id, which differs from the list id for most worktrees, so this falls
  // back to ids learned while a workspace was focused, then to a raw id that contains the
  // worktree's path, then to the focused workspace's terminals.
  function rowOfPane(pane, rows, focusedRow) {
    if (pane.workspaceListId) return rows.find((row) => row.id === pane.workspaceListId) ?? null;
    if (pane.workspaceId) {
      const known = aliases.get(pane.workspaceId);
      const direct = rows.find((row) => row.id === pane.workspaceId || row.id === known);
      if (direct) return direct;
      let best = null;
      for (const row of rows) {
        if (!row.path || (best && row.path.length <= best.path.length)) continue;
        const index = pane.workspaceId.indexOf(row.path);
        if (index < 0) continue;
        const next = pane.workspaceId[index + row.path.length];
        if (next === undefined || !/[\w.\-]/.test(next)) best = row;
      }
      if (best) return best;
    }
    if (focusedRow && pane.terminalId && context?.terminals?.some((terminal) => terminal.id === pane.terminalId)) return focusedRow;
    return null;
  }

  const isLocal = (row) => !row.hostId || row.hostId === 'local';
  const workspaceOf = (row) => ({ id: row.id, name: row.name, branch: [row.project && row.project !== row.name ? row.project : '', row.branch ?? ''].filter(Boolean).join(' · ') });

  async function fleet(rows, focusedRow, at, since, notices) {
    const local = rows.filter(isLocal);
    const byCwd = await reader.sessionsForMany(local.map((row) => row.path), since);
    const panesOf = new Map();
    const orphans = [];
    for (const pane of live.panes()) {
      const row = rowOfPane(pane, rows, focusedRow);
      if (!row) orphans.push(pane);
      else if (panesOf.has(row.id)) panesOf.get(row.id).push(pane);
      else panesOf.set(row.id, [pane]);
    }
    const taken = new Set(); // two rows can share a folder: its sessions go to the first
    const groups = rows.map((row) => {
      const mine = isLocal(row) && !taken.has(row.path);
      if (mine) taken.add(row.path);
      return {
        workspace: workspaceOf(row),
        sessions: mine ? byCwd.get(row.path) ?? [] : [],
        panes: panesOf.get(row.id) ?? [],
        busy: row.status?.state === 'working' || row.status?.state === 'permission',
      };
    });
    if (orphans.length) groups.push({ workspace: { id: 'unmapped', name: 'Other agents', branch: 'workspace not identified' }, sessions: [], panes: orphans });
    if (rows.length === 0) notices.push('Orca did not list its workspaces, so only agents seen through events are shown and transcripts were not read.');
    return buildFleetSnapshot({ groups, now: at, since, notices, pricesAsOf: PRICES_AS_OF });
  }

  async function snapshot(input) {
    const config = await readSettings();
    const wanted = typeof input?.workspaceId === 'string' && input.workspaceId ? input.workspaceId : FLEET;
    const asked = Number(input?.rangeHours);
    const rangeHours = RANGES_HOURS.includes(asked) ? asked : wanted === FLEET ? FLEET_RANGE_HOURS : config.rangeHours;
    const at = now();
    const since = at - rangeHours * 3_600_000;
    const notices = [];

    context = (await call('workspace.readContext')) ?? context;
    const rows = await listWorkspaces();
    const focusedRow = rowFor(rows, context);
    if (focusedRow && context?.workspaceId && aliases.get(context.workspaceId) !== focusedRow.id) {
      aliases.set(context.workspaceId, focusedRow.id);
      aliasesDirty = true;
    }
    const row = wanted === FLEET ? null : (wanted === FOCUSED ? null : rows.find((item) => item.id === wanted)) ?? focusedRow;

    if (focusedRow && (wanted === FLEET || row?.id === focusedRow.id) && at - seededAt >= SEED_TTL_MS) {
      seededAt = at;
      const answer = await call('agents.list');
      if (answer?.agents) live.seed(answer.agents, context?.workspaceId ?? focusedRow.id, at);
    }

    let view;
    if (wanted === FLEET) {
      view = await fleet(rows, focusedRow, at, since, notices);
    } else {
      let workspace = null;
      let panes = [];
      let sessions = [];
      if (row) {
        workspace = workspaceOf(row);
        panes = live.panes().filter((pane) => rowOfPane(pane, rows, focusedRow)?.id === row.id);
        if (!isLocal(row)) notices.push('This workspace is on another host: transcripts are read only on this computer, so tokens and cost are missing.');
        else sessions = await reader.sessionsFor(row.path, since);
      } else if (context) {
        // No workspace.list row to name its folder: show what Orca's events alone say.
        workspace = { id: context.workspaceId ?? 'focused', name: context.displayName, branch: context.branch ?? '' };
        panes = live.panes().filter((pane) => (context.workspaceId && pane.workspaceId === context.workspaceId) || context.terminals?.some((terminal) => terminal.id === pane.terminalId));
        notices.push('The workspace folder is unknown, so transcripts were not read: tokens and cost are missing.');
      } else {
        notices.push('No workspace is focused. Open a workspace in Orca, or pick one above.');
      }
      view = buildSnapshot({ workspace, sessions, panes, now: at, since, notices, pricesAsOf: PRICES_AS_OF });
    }

    // Stay under Orca's answer cap: drop the oldest spans first.
    while (JSON.stringify(view).length > ANSWER_MAX_BYTES && view.spans.length > 200) {
      const cut = Math.ceil(view.spans.length / 3);
      view = { ...view, spans: view.spans.slice(cut), spansDropped: view.spansDropped + cut };
    }
    return {
      snapshot: view,
      workspaces: rows.map((item) => ({ id: item.id, name: item.name, branch: item.branch ?? '', focused: focusedRow?.id === item.id })),
      selectedId: wanted === FLEET ? FLEET : row?.id ?? FOCUSED,
      rangeHours,
      ranges: RANGES_HOURS,
    };
  }

  function changed() {
    if (stopped) return;
    if (!notifyTimer) {
      notifyTimer = setTimeout(() => {
        notifyTimer = null;
        try {
          orca.panels?.post?.('trace.changed', { at: now() });
        } catch {
          // no open view, or posts are rate-limited: the view also polls
        }
      }, notifyMs);
      notifyTimer.unref?.();
    }
    if (!persistTimer) {
      persistTimer = setTimeout(() => {
        persistTimer = null;
        void persist();
      }, persistMs);
      persistTimer.unref?.();
    }
  }

  async function persist() {
    live.prune(now() - KEEP_PANES_MS);
    let data = live.serialize();
    // Trim tool lists, newest kept, until the value fits.
    for (let keep = 400; JSON.stringify(data).length > STORE_MAX_BYTES && keep >= 0; keep = Math.floor(keep / 2)) {
      data = { ...data, panes: data.panes.map((pane) => ({ ...pane, tools: keep ? pane.tools.slice(-keep) : [], transitions: pane.transitions.slice(-Math.max(keep, 40)) })) };
      if (keep === 0) break;
    }
    await call('storage.set', { key: STORE_KEY, value: data });
    if (aliasesDirty) {
      aliasesDirty = false;
      await call('storage.set', { key: ALIASES_KEY, value: Object.fromEntries([...aliases].slice(-500)) });
    }
  }

  const stored = await call('storage.get', { key: STORE_KEY });
  if (stored?.value) live.restore(stored.value);
  const storedAliases = (await call('storage.get', { key: ALIASES_KEY }))?.value;
  if (storedAliases && typeof storedAliases === 'object') {
    for (const [raw, id] of Object.entries(storedAliases)) if (typeof id === 'string') aliases.set(raw, id);
  }
  await readSettings();

  const on = (register) => {
    try {
      const subscription = register();
      if (subscription?.dispose) disposables.push(subscription);
    } catch (error) {
      log(`cannot subscribe: ${error?.message ?? error}`);
    }
  };
  on(() => orca.events.on('agent.status.changed', (payload) => {
    live.onStatus(payload, now());
    changed();
  }));
  on(() => orca.events.on('workspace.changed', (payload) => {
    context = payload?.context ?? null;
    changed();
  }));
  // Observe only: Orca does not wait for this hook, so it never slows an agent down.
  on(() => orca.hooks?.on('agent.tool.after', (event) => {
    live.onTool(event, now(), { toolLabels: settings.toolLabels });
    changed();
  }));

  // One snapshot at a time: the transcript reader keeps per-session state.
  on(() => orca.panels?.handle('trace.snapshot', (input) => {
    const next = chain.then(() => snapshot(input));
    chain = next.catch((error) => log(`snapshot failed: ${error?.stack ?? error}`));
    return next;
  }));

  log(`started; reading ${reader.roots.claude} and ${reader.roots.codex}; prices as of ${PRICES_AS_OF}`);

  return {
    snapshot,
    live,
    async stop() {
      stopped = true;
      clearTimeout(notifyTimer);
      clearTimeout(persistTimer);
      for (const item of disposables) {
        try {
          item.dispose();
        } catch {
          // already gone
        }
      }
      await chain;
      await persist();
    },
  };
}
