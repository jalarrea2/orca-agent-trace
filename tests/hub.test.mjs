import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createHub } from '../hub/server.mjs';
import { combine, slugOf, summarize } from '../hub/github.mjs';
import { createOtelStore } from '../hub/otel.mjs';
import { allowedHubUrl, createHubClient, parseHubs } from '../src/node/hubs.mjs';
import { claudeProjectDirNames } from '../src/node/transcripts.mjs';
import { claude } from './fixtures.mjs';

const TOKEN = 'test-token-0123456789abcdefghij';
const str = (key, value) => ({ key, value: { stringValue: value } });
const int = (key, value) => ({ key, value: { intValue: String(value) } });
const dbl = (key, value) => ({ key, value: { doubleValue: value } });

function logs(service, records) {
  return { resourceLogs: [{ resource: { attributes: [str('service.name', service)] }, scopeLogs: [{ logRecords: records }] }] };
}

// Calls a hub handler with a fake request; resolves { status, body }.
function call(handler, { method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { method, url, headers });
  return new Promise((resolve, reject) => {
    const res = {
      headersSent: false,
      writeHead(status) {
        this.status = status;
        this.headersSent = true;
      },
      end(text) {
        resolve({ status: this.status, body: text ? JSON.parse(text) : null });
      },
    };
    handler(req, res).catch(reject);
  });
}

test('otel: folds Claude Code and Codex log events into usage per session, without text', () => {
  const store = createOtelStore({ now: () => 1_800_000_000_000 });
  store.ingestLogs(logs('claude-code', [
    { timeUnixNano: '1799999990000000000', attributes: [str('event.name', 'api_request'), str('session.id', 's1'), str('model', 'claude-opus-5-5'), dbl('cost_usd', 0.25), int('input_tokens', 10), int('output_tokens', 100), int('cache_read_tokens', 5000), int('cache_creation_tokens', 300), str('prompt', 'secret prompt text')] },
    { timeUnixNano: '1799999991000000000', attributes: [str('event.name', 'claude_code.api_request'), str('session.id', 's1'), dbl('cost_usd', 0.5), int('input_tokens', 1), int('output_tokens', 2)] },
    { attributes: [str('event.name', 'tool_result'), str('session.id', 's1'), str('tool_name', 'Bash'), { key: 'success', value: { boolValue: false } }] },
    { attributes: [str('event.name', 'user_prompt'), str('session.id', 's1'), str('prompt', 'never stored')] },
  ]));
  store.ingestLogs(logs('codex', [
    { attributes: [str('event.name', 'codex.api_request'), str('conversation.id', 'c1'), int('input_token_count', 40), int('output_token_count', 4), int('cached_token_count', 30)] },
  ]));
  const s1 = store.get('s1');
  assert.equal(s1.requests, 2);
  assert.equal(s1.costUsd, 0.75);
  assert.equal(s1.priced, true);
  assert.deepEqual([s1.input, s1.output, s1.cacheRead, s1.cacheWrite], [11, 102, 5000, 300]);
  assert.deepEqual([s1.tools, s1.toolErrors], [1, 1]);
  assert.ok(!JSON.stringify(store.serialize()).includes('prompt text'), 'no text is kept');
  const c1 = store.get('c1');
  assert.deepEqual([c1.input, c1.output, c1.cacheRead, c1.priced], [40, 4, 30, false]);
  assert.ok(store.stats().shapes['claude-code:api_request'].includes('cost_usd'), 'attribute names are kept for tuning');
});

test('hub: OTLP JSON receiver and token-protected sessions API with OTel usage attached', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-trace-hub-'));
  const now = Date.now();
  try {
    const cwd = '/home/orca/orca/workspaces/demo/w1';
    const dir = join(home, '.claude', 'projects', claudeProjectDirNames(cwd)[0]);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'sess-r.jsonl'), [
      claude.user(now - 60_000, 'Fix the flaky test', { cwd, sessionId: 'sess-r' }),
      claude.assistant(now - 50_000, { id: 'm1' }, { cwd, sessionId: 'sess-r' }),
    ].join('\n') + '\n');
    assert.throws(() => createHub({ token: 'short' }), /24 characters/);
    const hub = createHub({ token: TOKEN, home, now: () => now });

    assert.equal((await call(hub.otlp, { method: 'POST', url: '/v1/logs', headers: { 'content-type': 'application/x-protobuf' }, body: 'x' })).status, 415);
    const ok = await call(hub.otlp, { method: 'POST', url: '/v1/logs', headers: { 'content-type': 'application/json' }, body: logs('claude-code', [{ attributes: [str('event.name', 'api_request'), str('session.id', 'sess-r'), dbl('cost_usd', 1.5), int('input_tokens', 3)] }]) });
    assert.equal(ok.status, 200);

    assert.equal((await call(hub.api, { url: '/v1/health' })).status, 401);
    assert.equal((await call(hub.api, { url: '/v1/health', headers: { authorization: 'Bearer wrong-token-0123456789abcdefgh' } })).status, 401);
    const health = await call(hub.api, { url: '/v1/health', headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(health.body.otel.sessions, 1);

    const answer = await call(hub.api, { method: 'POST', url: '/v1/sessions', headers: { authorization: `Bearer ${TOKEN}` }, body: { paths: [cwd, 'relative/ignored'], since: now - 3_600_000 } });
    assert.equal(answer.status, 200);
    assert.deepEqual(Object.keys(answer.body.byCwd), [cwd]);
    const [session] = answer.body.byCwd[cwd];
    assert.equal(session.sessionId, 'sess-r');
    assert.equal(session.otel.costUsd, 1.5);

    const root = join(home, 'orca', 'workspaces');
    await mkdir(join(root, 'demo', 'w1'), { recursive: true });
    await mkdir(join(root, 'demo', 'idle'), { recursive: true });
    await writeFile(join(root, 'demo', 'w1', '.git'), 'gitdir: ../.bare/worktrees/w1\n');
    await mkdir(join(root, 'demo', '.bare', 'worktrees', 'w1'), { recursive: true });
    await writeFile(join(root, 'demo', '.bare', 'worktrees', 'w1', 'HEAD'), 'ref: refs/heads/feat/x\n');
    const w1 = join(root, 'demo', 'w1');
    const w1Dir = join(home, '.claude', 'projects', claudeProjectDirNames(w1)[0]);
    await mkdir(w1Dir, { recursive: true });
    await writeFile(join(w1Dir, 'sess-w.jsonl'), [
      claude.user(now - 60_000, 'Review the PR', { cwd: w1, sessionId: 'sess-w' }),
      claude.assistant(now - 50_000, { id: 'm2' }, { cwd: w1, sessionId: 'sess-w' }),
    ].join('\n') + '\n');
    const hubWs = createHub({ token: TOKEN, home, now: () => now, workspacesRoot: root });
    assert.equal((await call(hubWs.api, { url: '/v1/workspaces' })).status, 401);
    const listed = await call(hubWs.api, { url: `/v1/workspaces?since=${now - 3_600_000}`, headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.workspaces.length, 1, 'only workspaces with agent activity are listed');
    assert.deepEqual({ ...listed.body.workspaces[0], lastAt: 0 }, { path: w1, project: 'demo', name: 'w1', branch: 'feat/x', lastAt: 0 });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('github: PR counts, contributors and DORA metrics per window', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  const h = (hours) => new Date(now - hours * 3_600_000).toISOString();
  const prs = [
    { author: { login: 'ana' }, createdAt: h(30), mergedAt: h(10), state: 'MERGED', additions: 100, deletions: 20 },
    { author: { login: 'ana' }, createdAt: h(5), mergedAt: h(1), state: 'MERGED', additions: 10, deletions: 2 },
    { author: { login: 'bot', is_bot: true }, createdAt: h(2), state: 'OPEN' },
    { author: { login: 'leo' }, createdAt: h(100), closedAt: h(3), state: 'CLOSED' },
  ];
  const runs = [
    { status: 'completed', conclusion: 'success', updatedAt: h(20) },
    { status: 'completed', conclusion: 'failure', updatedAt: h(8) },
    { status: 'completed', conclusion: 'success', updatedAt: h(6) },
    { status: 'completed', conclusion: 'cancelled', updatedAt: h(5) },
    { status: 'in_progress', conclusion: '', updatedAt: h(0.1) },
  ];
  const day = summarize({ prs, runs, now, windowMs: 86_400_000 });
  assert.deepEqual(day.prs, { opened: 2, merged: 2, closed: 1, open: 1, additions: 110, deletions: 22 });
  assert.deepEqual(day.authors.map((row) => [row.login, row.opened, row.merged]), [['ana', 1, 2], ['bot', 1, 0]]);
  assert.equal(day.dora.deploys, 2);
  assert.equal(day.dora.failedDeploys, 1);
  assert.equal(day.dora.changeFailureRate, 1 / 3);
  assert.equal(day.dora.timeToRestoreMs, 2 * 3_600_000);
  assert.equal(day.dora.leadTimeMs, (20 + 4) / 2 * 3_600_000);
  const total = combine([day, day], 86_400_000);
  assert.equal(total.prs.merged, 4);
  assert.equal(total.dora.deploys, 4);
  assert.equal(total.dora.deploysPerDay, 4);
  assert.equal(total.authors[0].merged, 4);
  assert.equal(slugOf('git@github.com:Providio/kyc.git'), 'Providio/kyc');
  assert.equal(slugOf('https://github.com/jalarrea2/docspace-web'), 'jalarrea2/docspace-web');
  assert.equal(slugOf('https://gitlab.com/a/b.git'), null);
});

test('hub: /v1/stats answers from the GitHub statistics and validates the project', async () => {
  const asked = [];
  const github = { stats: async ({ project }) => (asked.push(project), { projects: [], total: {} }) };
  const hub = createHub({ token: TOKEN, github });
  const auth = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await call(hub.api, { url: '/v1/stats' })).status, 401);
  assert.equal((await call(hub.api, { url: '/v1/stats?project=kyc', headers: auth })).status, 200);
  await call(hub.api, { url: '/v1/stats?project=../../etc', headers: auth });
  assert.deepEqual(asked, ['kyc', '']);
});

test('hub client: only tailnet URLs, tokens from a file, failures become a notice', async () => {
  assert.ok(allowedHubUrl('https://orca-server.tail1234.ts.net:8443'));
  assert.ok(allowedHubUrl('http://100.101.102.103:7787'));
  assert.ok(!allowedHubUrl('http://orca-server.tail1234.ts.net'), 'plain http on a name');
  assert.ok(!allowedHubUrl('https://example.com'));
  assert.ok(!allowedHubUrl('http://192.168.1.10:7787'));
  assert.ok(!allowedHubUrl('https://user:pw@orca-server.tail1234.ts.net'));
  assert.deepEqual(parseHubs(JSON.stringify([{ url: 'https://a.ts.net', token: 'short', hostIds: ['h'] }])), [], 'short tokens are dropped');

  const home = await mkdtemp(join(tmpdir(), 'agent-trace-hubs-'));
  try {
    await mkdir(join(home, '.config/agent-trace'), { recursive: true });
    await writeFile(join(home, '.config/agent-trace/hubs.json'), JSON.stringify([{ name: 'srv', url: 'https://srv.tail1.ts.net:8443/', token: TOKEN, hostIds: ['env-1'] }]));
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ byCwd: { '/srv/w1': [{ sessionId: 'x' }] } }) };
    };
    const client = createHubClient({ home, fetchImpl });
    assert.equal(await client.hubFor('env-2'), null);
    const hub = await client.hubFor('env-1');
    assert.equal(hub.url, 'https://srv.tail1.ts.net:8443');
    const answer = await client.sessions(hub, ['/srv/w1'], 1000);
    assert.deepEqual(answer.byCwd.get('/srv/w1'), [{ sessionId: 'x' }]);
    assert.equal(seen[0].url, 'https://srv.tail1.ts.net:8443/v1/sessions');
    assert.equal(seen[0].auth, `Bearer ${TOKEN}`);

    const failing = createHubClient({ home, fetchImpl: async () => ({ ok: false, status: 401 }) });
    const failed = await failing.sessions(await failing.hubFor('env-1'), ['/srv/w1'], 1000);
    assert.match(failed.error, /srv did not answer \(HTTP 401\)/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
