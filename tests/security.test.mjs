// Hostile and malformed input: what a prompt-injected agent, a broken transcript or tampered
// stored state could put in front of the plugin.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClaudeParser } from '../src/core/adapters/claude.mjs';
import { parseOrchCommand } from '../src/core/adapters/orch.mjs';
import { redact, toolLabel } from '../src/core/adapters/shared.mjs';
import { createLiveStore } from '../src/core/live.mjs';
import { agentLabel } from '../src/core/snapshot.mjs';
import { claudeProjectDirNames, createTranscriptReader, resolveRoot } from '../src/node/transcripts.mjs';
import { buildSequence, sequenceHtml } from '../view/sequence.js';
import { claude, codex } from './fixtures.mjs';

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const MARKUP = `"><img src=x onerror=alert(1)>'<script>alert(1)</script>`;
// Made-up values in the shape of real keys, assembled here so that no key-shaped literal sits in
// the repository for a secret scanner to trip on.
const fake = (prefix, length) => prefix + 'a1B2'.repeat(Math.ceil(length / 4)).slice(0, length);
const KEY = { openai: fake('sk-' + 'proj-', 24), github: fake('gh' + 'p_', 36), aws: fake('AK' + 'IA', 16).toUpperCase(), jwt: [fake('ey' + 'J', 20), fake('ey' + 'J', 24), fake('', 10)].join('.') };

test('redact: secrets are masked before a label is cut, and plain text is left alone', () => {
  const masked = [
    ['curl -H "Authorization: Bearer abcdEFGH12345678" https://api.example.com', 'abcdEFGH12345678'],
    [`export OPENAI_API_KEY=${KEY.openai} && node run.js`, KEY.openai.slice(0, 10)],
    ['git clone https://leo:hunter2@github.com/acme/repo.git', 'hunter2'],
    ['mysql --password=S3cret! -u root db', 'S3cret'],
    ['psql --password "my pass" -h db', 'my pass'],
    ['DB_PASSWORD: "p@ss word" other=1', 'p@ss'],
    [`gh auth login --with-token ${KEY.github}`, KEY.github.slice(0, 8)],
    [`aws configure set aws_secret_access_key ${fake('w/', 40)}`, fake('w/', 12)],
    ['curl -u admin:pw https://x', 'admin:pw'],
    ['docker login -u me -p hunter2hunter2', 'hunter2'],
    [`jwt ${KEY.jwt}`, KEY.jwt.slice(0, 12)],
    [`use ${KEY.aws} here`, KEY.aws],
  ];
  for (const [text, secret] of masked) {
    assert.ok(!redact(text).includes(secret), text);
    assert.ok(redact(text).includes('***'), text);
  }
  for (const text of ['token usage report for the author: Leonardo', 'rg "toFixed" src/invoices', 'pnpm test --filter tokens', 'git commit -m "rotate token handling"']) {
    assert.equal(redact(text), text);
  }
  // A key that starts inside the first 60 characters and ends after them is masked whole.
  const label = toolLabel({ command: `deploy --region us-east-1 --env production --api-key ${'k'.repeat(80)}` });
  assert.ok(!label.includes('kkkk') && label.includes('***'));
  assert.equal(parseOrchCommand('orca orchestration send --to dispatch:ctx_12ab --subject "token=abc123secretvalue done"').subject, 'token=*** done');
  // Long inputs stay cheap.
  const started = Date.now();
  for (const text of [`${'a'.repeat(100_000)}password`, `--${'a-'.repeat(50_000)}`, 'token '.repeat(20_000)]) redact(text);
  assert.ok(Date.now() - started < 500);
});

test('adapters: names are cut to a sane length and prompts are masked', () => {
  const parser = createClaudeParser({});
  const extra = { sessionId: 's1', cwd: '/work/a' };
  parser.push(claude.user(NOW - 5000, `deploy with API_KEY=${KEY.openai} please`, extra));
  parser.push(claude.assistant(NOW - 4000, { id: 'm1', model: `claude-${'['.repeat(50_000)}`, tools: [{ id: 't1', name: 'x'.repeat(5000), input: {} }] }, extra));
  const session = parser.result();
  const main = session.agents[0];
  assert.ok(main.model.length <= 100);
  assert.ok(main.spans.every((span) => span.name.length <= 100));
  assert.ok(!JSON.stringify(session).includes(KEY.openai.slice(0, 10)));
});

test('settings: a transcript folder must be absolute; ~ is the home folder', () => {
  assert.equal(resolveRoot('', '/home/u'), null);
  assert.equal(resolveRoot('relative/dir', '/home/u'), null);
  assert.equal(resolveRoot('../../etc', '/home/u'), null);
  assert.equal(resolveRoot('/abs/../x\0y', '/home/u'), null);
  assert.equal(resolveRoot('~', '/home/u'), '/home/u');
  assert.equal(resolveRoot('~/.claude-work', '/home/u'), '/home/u/.claude-work');
  assert.equal(resolveRoot('/opt/claude/../claude2', '/home/u'), '/opt/claude2');
});

test('reader: a broken rollout or an endless line does not take the other sessions down', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-trace-sec-'));
  try {
    const cwd = '/work/a';
    const now = Date.now();
    const day = new Date(now);
    const dayDir = join(home, '.codex', 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    await mkdir(dayDir, { recursive: true });
    // A first line that is not JSON and whose cwd is not a JSON string either.
    await writeFile(join(dayDir, 'rollout-bad.jsonl'), `{"type":"session_meta","payload":{"cwd":"/work/\\x41","id":"bad"\n`);
    await writeFile(join(dayDir, 'rollout-good.jsonl'), [
      codex.meta(now - 5000, 'good', cwd), codex.turn(now - 5000, 'gpt-6-sol'), codex.user(now - 4000, 'hello'), codex.assistant(now - 3000, 'hi'),
    ].join('\n') + '\n');
    const project = join(home, '.claude', 'projects', claudeProjectDirNames(cwd)[0]);
    await mkdir(project, { recursive: true });
    const extra = { sessionId: 'big', cwd };
    await writeFile(join(project, 'big.jsonl'), [
      claude.user(now - 5000, 'before', extra),
      'x'.repeat(40 * 1024 * 1024), // a 40 MiB line with no newline until here
      claude.assistant(now - 3000, { id: 'm1', text: 'after' }, extra),
    ].join('\n') + '\n');
    const reader = createTranscriptReader({ home });
    const sessions = await reader.sessionsFor(cwd, now - 60_000);
    assert.deepEqual(sessions.map((session) => session.sessionId).sort(), ['big', 'good']);
    const big = sessions.find((session) => session.sessionId === 'big');
    assert.equal(big.title, 'before');
    assert.equal(big.agents[0].requests, 1, 'the line after the oversized one was read');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('live: stored state of the wrong shape is rebuilt as plain strings and numbers', () => {
  const store = createLiveStore();
  store.restore({ v: 1, panes: [{ key: 'p1', terminalId: { a: 1 }, title: [MARKUP], agent: { toString: () => MARKUP }, transitions: [{ at: NOW, state: 'working', outcome: { x: 1 } }, { at: 'soon', state: 'done' }, { at: NOW, state: MARKUP }], tools: [{ at: NOW, tool: { name: MARKUP }, label: [MARKUP] }, { at: 'x' }] }] });
  const [pane] = store.panes();
  assert.equal(pane.title, '');
  assert.equal(pane.agent, '');
  assert.deepEqual(pane.transitions, [{ at: NOW, state: 'working' }]);
  assert.deepEqual(pane.tools, [{ at: NOW, tool: 'tool', label: '' }]);
  for (const kind of ['constructor', '__proto__', 'toString']) assert.equal(typeof agentLabel(kind), 'string');
  assert.equal(agentLabel({}), 'Agent');
});

test('sequence: markup in any field comes out as text', () => {
  const node = (fields) => ({ parentId: null, depth: 1, kind: 'agent', group: MARKUP, agent: MARKUP, name: MARKUP, task: MARKUP, model: MARKUP, state: MARKUP, startedAt: NOW - 9000, endedAt: null, ...fields });
  const snapshot = {
    scope: 'fleet',
    nodes: [node({ id: 'root', kind: 'fleet' }), node({ id: 'w:1', kind: 'workspace', parentId: 'root' }), node({ id: `s:${MARKUP}`, parentId: 'w:1' }), node({ id: 'k:1', kind: 'subagent', parentId: `s:${MARKUP}`, endedAt: NOW - 1000 })],
    spans: [{ nodeId: `s:${MARKUP}`, kind: 'tool', name: `mcp__${MARKUP}__${MARKUP}`, label: MARKUP, start: NOW - 8000, end: NOW - 7000, error: true }, { nodeId: `s:${MARKUP}`, kind: 'tool', name: MARKUP, label: MARKUP, start: NOW - 6000, end: NOW - 5000 }],
    events: [],
    messages: [{ ts: NOW - 8500, from: 'you', to: `s:${MARKUP}`, kind: MARKUP, verb: MARKUP, label: MARKUP, error: false }, { ts: NOW - 4000, from: `s:${MARKUP}`, to: 'orca', kind: 'orch', verb: MARKUP, label: '', error: true }],
  };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const html = sequenceHtml(buildSequence(snapshot, { now: NOW }), { esc, glyph: () => '' });
  assert.ok(html.includes('&#60;img'), 'the payload is there, escaped');
  assert.ok(!/<img|<script|onerror=alert\(1\)>'/.test(html.replace(/&#\d+;/g, '')) && !html.includes('<img') && !html.includes('<script'));
  // No attribute value is left open by a quote from the data.
  for (const match of html.matchAll(/class="([^"]*)"/g)) assert.ok(/^[A-Za-z0-9 -]*$/.test(match[1]), match[1]);
});
