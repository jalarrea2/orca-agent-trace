// Orca's orchestration commands, as agents run them in a shell: how one agent starts, messages
// and answers another. Pure: no Node built-ins.
//
//   orca orchestration worker-start --spec "<task>" --worktree … --agent …   coordinator → new worker
//   orca orchestration dispatch --task <task_id> --to <handle>               coordinator → worker
//   orca orchestration send --to dispatch:<id> --subject "…" [--type …]     either way
//   orca orchestration ask … / reply --id <msg_id> --body "…"               worker ⇄ coordinator
//   orca orchestration worker-release --dispatch <id>                        coordinator closes a worker
//
// Agents are addressed by ids (ctx_…, task_…, run_…, msg_…, term_…), and a dispatched worker's
// first prompt carries its task and dispatch ids, so the same id on both sides pairs the agents.
import { safeClip, str } from './shared.mjs';

const COMMAND = /(?:^|[\s;&|(`])(?:orca|orca-dev|orca-ide)\s+orchestration\s+([a-z][a-z-]*)/;
const ID = /\b(?:ctx|task|run|msg|term)_[A-Za-z0-9-]{4,}\b/g;
const QUOTED = (flag) => new RegExp(`--${flag}(?:\\s+|=)(?:"((?:[^"\\\\]|\\\\.){0,400})"|'([^']{0,400})'|(\\S+))`);
const MAX_IDS = 24;
const MAX_COMMAND = 20000;

// The orchestration ids in a text, each once, in order. A word such as `task_id` is not one:
// an id's tail has a digit.
export function orchIds(text, max = MAX_IDS) {
  if (typeof text !== 'string' || text === '') return [];
  const out = [];
  for (const match of text.slice(0, 20000).matchAll(ID)) {
    const id = match[0];
    if (!/\d/.test(id.slice(id.indexOf('_') + 1)) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

// { verb, ids, subject } for a shell command that runs an orchestration command, else null.
// `subject` is the command's --subject, --spec or --body, shortened; '' when labels are off.
export function parseOrchCommand(command, labels = true) {
  // An orchestration command is short; a longer shell text is searched only at its start.
  const text = (Array.isArray(command) ? command.filter((part) => typeof part === 'string').join(' ') : str(command)).slice(0, MAX_COMMAND);
  if (!text) return null;
  const match = COMMAND.exec(text);
  if (!match) return null;
  let verb = match[1];
  const type = QUOTED('type').exec(text);
  const typed = type ? type[1] ?? type[2] ?? type[3] : '';
  if (verb === 'send' && /^[A-Za-z][A-Za-z_-]{0,39}$/.test(typed)) verb = typed.replace(/_/g, '-');
  let subject = '';
  if (labels) {
    for (const flag of ['subject', 'spec', 'body']) {
      const found = QUOTED(flag).exec(text);
      if (!found) continue;
      subject = safeClip(found[1] ?? found[2] ?? found[3] ?? '', 80);
      if (subject) break;
    }
  }
  return { verb, ids: orchIds(text), subject };
}

// The text of a tool result or message content, whatever shape the CLI stored it in.
export function contentText(content, max = 8000) {
  if (typeof content === 'string') return content.slice(0, max);
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block && typeof block.text === 'string') out += `${block.text}\n`;
    else if (typeof block === 'string') out += `${block}\n`;
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}
