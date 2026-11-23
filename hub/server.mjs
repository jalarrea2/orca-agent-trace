#!/usr/bin/env node
// Agent Trace hub: runs on a machine whose agents the Agent Trace plugin cannot read directly (an
// Orca server). It combines two sources and serves them to the plugin over the tailnet:
//   - OpenTelemetry: an OTLP/HTTP JSON receiver for Claude Code and Codex (usage the agent reports)
//   - transcripts: the same reader the plugin uses (agent tree, spans, orchestration, history)
//
// Both listeners bind to 127.0.0.1. The API is published to the tailnet with `tailscale serve`
// and every API call needs the bearer token in AGENT_TRACE_HUB_TOKEN_FILE.
//
//   AGENT_TRACE_HUB_PORT       API port            (default 7787)
//   AGENT_TRACE_OTLP_PORT      OTLP receiver port  (default 4318)
//   AGENT_TRACE_HUB_TOKEN_FILE bearer token file   (default ~/.config/agent-trace-hub/token)
//   AGENT_TRACE_HUB_STATE_DIR  persisted OTel rows (default ~/.local/state/agent-trace-hub)
import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { requestCost } from '../src/core/pricing.mjs';
import { PRICES_AS_OF } from '../src/core/prices-data.mjs';
import { createTranscriptReader } from '../src/node/transcripts.mjs';
import { createGithubStats } from './github.mjs';
import { createOtelStore } from './otel.mjs';

export const HUB_VERSION = '1';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PATHS = 300;
const MAX_RANGE_MS = 7 * 86_400_000;

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

function sameToken(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Adds the agent-reported usage to each transcript session that OpenTelemetry also saw.
export function withOtel(sessions, otel) {
  return sessions.map((session) => {
    const usage = otel.get(session.sessionId);
    return usage ? { ...session, otel: usage } : session;
  });
}

export function createHub({ token, home = homedir(), now = () => Date.now(), stateDir, github } = {}) {
  if (!token || String(token).length < 24) throw new Error('a token of at least 24 characters is required');
  const otel = createOtelStore({ now });
  const reader = createTranscriptReader({ home, cost: requestCost, now });
  const delivery = github ?? createGithubStats({ home, now, log: (message) => console.error(message) });
  const statePath = stateDir ? join(stateDir, 'otel.json') : null;
  let dirty = false;

  async function load() {
    if (!statePath) return;
    try {
      otel.restore(JSON.parse(await readFile(statePath, 'utf8')));
    } catch {
      // first start or an unreadable file: start empty
    }
  }

  async function persist() {
    if (!statePath || !dirty) return;
    dirty = false;
    otel.prune();
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(otel.serialize()), { mode: 0o600 });
    await rename(tmp, statePath);
  }

  // OTLP/HTTP: JSON encoding only (exporters are configured with protocol http/json).
  async function otlp(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const type = String(req.headers['content-type'] ?? '');
    if (!type.includes('json')) return send(res, 415, { error: 'only the OTLP JSON encoding is accepted' });
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch (error) {
      return send(res, error.status ?? 400, { error: 'invalid body' });
    }
    if (req.url.startsWith('/v1/logs')) {
      otel.ingestLogs(body);
      dirty = true;
    }
    // Metrics and traces are accepted and dropped: usage comes from the log events.
    return send(res, 200, {});
  }

  async function api(req, res) {
    const auth = String(req.headers.authorization ?? '');
    if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), token)) return send(res, 401, { error: 'unauthorized' });
    const url = new URL(req.url, 'http://hub');
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      const stats = otel.stats();
      return send(res, 200, { ok: true, version: HUB_VERSION, pricesAsOf: PRICES_AS_OF, otel: { records: stats.records, sessions: stats.sessions } });
    }
    if (req.method === 'GET' && url.pathname === '/v1/stats') {
      const project = url.searchParams.get('project') ?? '';
      return send(res, 200, await delivery.stats({ project: /^[\w.-]{0,100}$/.test(project) ? project : '' }));
    }
    if (req.method === 'GET' && url.pathname === '/v1/otel/shapes') return send(res, 200, otel.stats().shapes);
    if (req.method === 'POST' && url.pathname === '/v1/sessions') {
      let input;
      try {
        input = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8'));
      } catch (error) {
        return send(res, error.status ?? 400, { error: 'invalid body' });
      }
      const paths = (Array.isArray(input?.paths) ? input.paths : []).filter((path) => typeof path === 'string' && path.startsWith('/')).slice(0, MAX_PATHS);
      const since = Math.max(now() - MAX_RANGE_MS, Number(input?.since) || now() - 3_600_000);
      const byCwd = await reader.sessionsForMany(paths, since);
      const out = {};
      for (const [cwd, list] of byCwd) out[cwd] = withOtel(list, otel);
      return send(res, 200, { version: HUB_VERSION, generatedAt: now(), byCwd: out });
    }
    return send(res, 404, { error: 'not found' });
  }

  return { otel, delivery, load, persist, otlp, api };
}

async function main() {
  const home = homedir();
  const tokenFile = process.env.AGENT_TRACE_HUB_TOKEN_FILE || join(home, '.config/agent-trace-hub/token');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const stateDir = process.env.AGENT_TRACE_HUB_STATE_DIR || join(home, '.local/state/agent-trace-hub');
  const hub = createHub({ token, home, stateDir });
  await hub.load();
  hub.delivery.start();
  const apiPort = Number(process.env.AGENT_TRACE_HUB_PORT || 7787);
  const otlpPort = Number(process.env.AGENT_TRACE_OTLP_PORT || 4318);
  const guard = (handler) => (req, res) => handler(req, res).catch((error) => {
    console.error(`request failed: ${error?.message ?? error}`);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
  });
  createServer(guard(hub.api)).listen(apiPort, '127.0.0.1');
  createServer(guard(hub.otlp)).listen(otlpPort, '127.0.0.1');
  setInterval(() => void hub.persist().catch((error) => console.error(`persist failed: ${error.message}`)), 30_000).unref();
  const stop = async () => {
    await hub.persist().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  console.log(`agent-trace-hub ${HUB_VERSION}: API 127.0.0.1:${apiPort}, OTLP 127.0.0.1:${otlpPort}, prices as of ${PRICES_AS_OF}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
