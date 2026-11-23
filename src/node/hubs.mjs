// Remote transcripts and OpenTelemetry usage from Agent Trace hubs (hub/server.mjs) running on
// other Orca hosts. Hubs are listed in ~/.config/agent-trace/hubs.json, a file only the person
// writes (it holds bearer tokens, so it is kept out of Orca settings):
//
//   [{ "name": "orca-server", "hostIds": ["<Orca environment id>"], "url": "https://orca-server.<tailnet>.ts.net:8443", "token": "…" }]
//
// Only hosts on the person's tailnet are accepted: https on a *.ts.net name, or http/https on a
// Tailscale address (100.64.0.0/10). Every call has a short timeout and a failure is reported as
// a notice, never thrown.
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 6000;
const CACHE_MS = 2500;
const RELOAD_MS = 10_000;

export function allowedHubUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:' && url.hostname.endsWith('.ts.net')) return true;
  const parts = url.hostname.split('.').map(Number);
  const tailscale = parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  return tailscale && (url.protocol === 'https:' || url.protocol === 'http:');
}

export function parseHubs(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('hubs.json must be a JSON array');
  return list
    .filter((hub) => hub && typeof hub.url === 'string' && typeof hub.token === 'string' && hub.token.length >= 24 && Array.isArray(hub.hostIds))
    .map((hub) => ({ name: String(hub.name || hub.url), hostIds: hub.hostIds.map(String), url: hub.url.replace(/\/+$/, ''), token: hub.token, allowed: allowedHubUrl(hub.url) }));
}

export function createHubClient({ home = homedir(), file, fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {} } = {}) {
  const path = file ?? join(home, '.config/agent-trace/hubs.json');
  let hubs = [];
  let loadedAt = -Infinity;
  let mtime = 0;
  const cache = new Map(); // `${url}|${paths}|${since bucket}` → { at, byCwd }
  const warned = new Set();
  const warnOnce = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    log(message);
  };

  async function load() {
    if (now() - loadedAt < RELOAD_MS) return hubs;
    loadedAt = now();
    try {
      const info = await stat(path);
      if (info.mtimeMs === mtime) return hubs;
      mtime = info.mtimeMs;
      hubs = parseHubs(await readFile(path, 'utf8'));
      for (const hub of hubs) if (!hub.allowed) warnOnce(`url:${hub.url}`, `hub ${hub.name} ignored: only https *.ts.net or Tailscale (100.64.0.0/10) addresses are accepted`);
    } catch (error) {
      if (error?.code !== 'ENOENT') warnOnce(`file:${error?.message}`, `could not read ${path}: ${error?.message ?? error}`);
      hubs = [];
      mtime = 0;
    }
    return hubs;
  }

  return {
    async hubFor(hostId) {
      if (!hostId) return null;
      return (await load()).find((hub) => hub.allowed && hub.hostIds.includes(hostId)) ?? null;
    },
    // Any hub that can be asked (delivery statistics are not tied to a host).
    async anyHub() {
      return (await load()).find((hub) => hub.allowed) ?? null;
    },
    // Delivery statistics (pull requests, contributors, DORA) from the hub's GitHub sign-in.
    async stats(hub, project = '') {
      try {
        const res = await fetchImpl(`${hub.url}/v1/stats${project ? `?project=${encodeURIComponent(project)}` : ''}`, {
          headers: { authorization: `Bearer ${hub.token}` },
          signal: AbortSignal.timeout(20_000),
          redirect: 'error',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { stats: await res.json(), hub: hub.name };
      } catch (error) {
        return { error: `${hub.name} did not answer (${error?.name === 'TimeoutError' ? 'timeout' : error?.message ?? error})` };
      }
    },
    // byCwd for `paths` on the hub's host, or { error } when the hub could not answer.
    async sessions(hub, paths, since) {
      const key = `${hub.url}|${paths.join('\n')}|${Math.floor(since / 60_000)}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < CACHE_MS) return hit.result;
      let result;
      try {
        const res = await fetchImpl(`${hub.url}/v1/sessions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ paths, since }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: 'error',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        result = { byCwd: new Map(Object.entries(body?.byCwd ?? {}).map(([cwd, list]) => [cwd, Array.isArray(list) ? list : []])) };
      } catch (error) {
        result = { error: `${hub.name} did not answer (${error?.name === 'TimeoutError' ? 'timeout' : error?.message ?? error})` };
      }
      for (const [old, entry] of cache) if (now() - entry.at >= CACHE_MS) cache.delete(old);
      cache.set(key, { at: now(), result });
      return result;
    },
  };
}
