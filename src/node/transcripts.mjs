// Finds the transcripts of a workspace on disk and keeps one parser per session, reading only the
// bytes added since the last pass. Node only.
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { createClaudeParser } from '../core/adapters/claude.mjs';
import { createCodexParser } from '../core/adapters/codex.mjs';

const CHUNK = 1024 * 1024;
const HEAD_BYTES = 512 * 1024;
// A transcript line longer than this is skipped instead of being held in memory.
const MAX_LINE_BYTES = 32 * 1024 * 1024;
// A session not asked for in this long is dropped from memory.
const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 300;
// A session file untouched this long before the range is not checked for running subagents.
const SUBAGENT_LOOKBACK_MS = 24 * 3_600_000;

// Claude Code names a project folder after its cwd with every character outside [A-Za-z0-9]
// turned into '-'. Older versions only replaced separators and dots, so both spellings are tried.
export function claudeProjectDirNames(cwd) {
  return [...new Set([cwd.replace(/[^A-Za-z0-9]/g, '-'), cwd.replace(/[\\/.:]/g, '-')])];
}

export function createTranscriptReader({ home = homedir(), claudeDir = '', codexDir = '', cost = () => null, toolLabels = true, now = () => Date.now() } = {}) {
  const claudeRoot = resolveRoot(claudeDir, home) ?? join(home, '.claude');
  const codexRoot = resolveRoot(codexDir, home) ?? join(home, '.codex');
  const sessions = new Map(); // `${kind}:${sessionId}` → { kind, parser, offsets: Map(file → bytes read), usedAt }
  const codexHeads = new Map(); // file → { cwd, id } read once from its session_meta line

  function entry(kind, sessionId) {
    const key = `${kind}:${sessionId}`;
    let item = sessions.get(key);
    if (!item) {
      const make = kind === 'claude' ? createClaudeParser : createCodexParser;
      item = { kind, sessionId, parser: make({ sessionId, cost, toolLabels }), offsets: new Map(), usedAt: now() };
      sessions.set(key, item);
    }
    item.usedAt = now();
    return item;
  }

  function reset(kind, sessionId) {
    sessions.delete(`${kind}:${sessionId}`);
    return entry(kind, sessionId);
  }

  // Feeds the parser the complete lines added to `file` since the last pass. A last line still
  // being written is left for the next pass.
  async function feed(item, file, size) {
    let offset = item.offsets.get(file) ?? 0;
    if (size < offset) return false; // the file was rewritten: the caller starts the session over
    if (size === offset) return true;
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(CHUNK);
      let pending = Buffer.alloc(0);
      let skipping = false; // inside a line that went over MAX_LINE_BYTES: drop bytes up to its newline
      while (offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, size - offset), offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
        let chunk = buffer.subarray(0, bytesRead);
        if (skipping) {
          const end = chunk.indexOf(0x0a);
          if (end < 0) continue;
          chunk = chunk.subarray(end + 1);
          skipping = false;
        }
        const data = Buffer.concat([pending, chunk]);
        const newline = data.lastIndexOf(0x0a);
        if (newline < 0) {
          if (data.length > MAX_LINE_BYTES) {
            pending = Buffer.alloc(0);
            skipping = true;
          } else pending = data;
          continue;
        }
        for (const line of data.subarray(0, newline).toString('utf8').split('\n')) if (line) item.parser.push(line);
        pending = Buffer.from(data.subarray(newline + 1));
      }
      // An oversized line still being written is skipped for good: the next pass starts after it.
      item.offsets.set(file, skipping ? offset : offset - pending.length);
    } finally {
      await handle.close();
    }
    return true;
  }

  async function readSession(kind, sessionId, files) {
    let item = entry(kind, sessionId);
    for (let attempt = 0; attempt < 2; attempt++) {
      let ok = true;
      for (const { file, size } of files) {
        if (!(await feed(item, file, size).catch(() => true))) {
          ok = false;
          break;
        }
      }
      if (ok) break;
      item = reset(kind, sessionId);
    }
    return item.parser.result();
  }

  async function claudeSessions(cwd, since) {
    const out = [];
    for (const name of claudeProjectDirNames(cwd)) {
      const dir = join(claudeRoot, 'projects', name);
      for (const file of await jsonlFiles(dir)) {
        const sessionId = file.name.replace(/\.jsonl$/i, '');
        // A subagent writes to its own file while the main one waits, so those are checked too,
        // but only for sessions recent enough to still have one running.
        const subagents = file.mtimeMs >= since - SUBAGENT_LOOKBACK_MS ? await jsonlFiles(join(dir, sessionId, 'subagents')) : [];
        const files = [file, ...subagents];
        if (!files.some((item) => item.mtimeMs >= since)) continue;
        out.push(await readSession('claude', sessionId, files));
      }
      if (out.length) break;
    }
    return out;
  }

  // Codex sessions by the workspace folder they ran in. A session belongs to the deepest of
  // `cwds` that is its cwd or contains it.
  async function codexSessionsByCwd(cwds, since) {
    const out = new Map(cwds.map((cwd) => [cwd, []]));
    for (const file of await codexFiles(join(codexRoot, 'sessions'), since)) {
      let head = codexHeads.get(file.file);
      if (!head) {
        head = await codexHead(file.file);
        if (head) codexHeads.set(file.file, head);
      }
      if (!head) continue;
      let owner = null;
      for (const cwd of cwds) if (sameOrInside(head.cwd, cwd) && (owner === null || cwd.length > owner.length)) owner = cwd;
      if (owner !== null) out.get(owner).push(await readSession('codex', head.id || file.name, [file]));
    }
    return out;
  }

  function forget() {
    const cutoff = now() - IDLE_MS;
    for (const [key, item] of sessions) if (item.usedAt < cutoff) sessions.delete(key);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  const started = (session) => session.agents.some((agent) => agent.firstAt !== null);

  return {
    // Every session of the workspace at `cwd` whose transcript changed since `since` (ms).
    async sessionsFor(cwd, since) {
      if (!cwd) return [];
      const [claude, codex] = await Promise.all([
        claudeSessions(cwd, since).catch(() => []),
        codexSessionsByCwd([cwd], since).then((map) => map.get(cwd)).catch(() => []),
      ]);
      forget();
      return [...claude, ...codex].filter(started);
    },

    // The same for many workspace folders at once: Map(cwd → sessions). The Codex folder is
    // walked once, and only Claude project folders that exist are opened.
    async sessionsForMany(cwds, since) {
      const unique = [...new Set(cwds.filter(Boolean))];
      const out = new Map(unique.map((cwd) => [cwd, []]));
      const projects = new Set(await readdir(join(claudeRoot, 'projects')).catch(() => []));
      for (const cwd of unique) {
        if (!claudeProjectDirNames(cwd).some((name) => projects.has(name))) continue;
        out.get(cwd).push(...(await claudeSessions(cwd, since).catch(() => [])));
      }
      const codex = await codexSessionsByCwd(unique, since).catch(() => new Map());
      for (const [cwd, list] of codex) out.get(cwd).push(...list);
      forget();
      for (const [cwd, list] of out) out.set(cwd, list.filter(started));
      return out;
    },
    roots: { claude: claudeRoot, codex: codexRoot },
  };
}

async function jsonlFiles(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!/\.jsonl$/i.test(name)) continue;
    const file = join(dir, name);
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) out.push({ file, name, size: info.size, mtimeMs: info.mtimeMs });
  }
  return out;
}

// Rollout files under sessions/YYYY/MM/DD changed since `since`. Day folders older than the day
// before `since` are skipped unread; a session that runs past midnight stays in its start folder,
// so the folder cut-off is a week earlier than the file cut-off.
async function codexFiles(root, since) {
  const floor = new Date(since - 7 * 86_400_000);
  const floorKey = floor.getFullYear() * 10000 + (floor.getMonth() + 1) * 100 + floor.getDate();
  const out = [];
  for (const year of await numericDirs(root)) {
    for (const month of await numericDirs(join(root, year))) {
      for (const day of await numericDirs(join(root, year, month))) {
        if (Number(year) * 10000 + Number(month) * 100 + Number(day) < floorKey) continue;
        for (const file of await jsonlFiles(join(root, year, month, day))) if (file.mtimeMs >= since) out.push(file);
      }
    }
  }
  return out;
}

async function numericDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((item) => item.isDirectory() && /^\d+$/.test(item.name)).map((item) => item.name);
  } catch {
    return [];
  }
}

// The session id and cwd from a rollout's first line (session_meta), which can be long.
async function codexHead(file) {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.allocUnsafe(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const line = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
    try {
      const obj = JSON.parse(line);
      if (obj?.type === 'session_meta' && typeof obj.payload?.cwd === 'string') return { cwd: obj.payload.cwd, id: String(obj.payload.id ?? '') };
    } catch {
      // A first line longer than HEAD_BYTES: fall back to picking the two fields out of the text.
      const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
      const id = /"id":"([^"\\]+)"/.exec(line);
      try {
        if (cwd) return { cwd: JSON.parse(`"${cwd[1]}"`), id: id ? id[1] : '' };
      } catch {
        // not a JSON string after all: this file is not a rollout this reader understands
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

// The folder a setting names, or null to use the default. `~` is the home folder. A relative path
// is refused: it would be read against whatever folder the worker happens to run in.
export function resolveRoot(setting, home = homedir()) {
  let path = typeof setting === 'string' ? setting.trim() : '';
  if (!path || path.includes('\0')) return null;
  if (path === '~') path = home;
  else if (path.startsWith('~/') || path.startsWith('~\\')) path = join(home, path.slice(2));
  return isAbsolute(path) ? normalize(path) : null;
}

function sameOrInside(path, root) {
  const a = trimSep(path);
  const b = trimSep(root);
  return a === b || a.startsWith(b + sep) || a.startsWith(`${b}/`);
}

function trimSep(path) {
  return String(path ?? '').replace(/[\\/]+$/, '');
}
