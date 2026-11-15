// Helpers shared by transcript adapters. Pure: no Node built-ins.

export const MAX_SPANS_PER_AGENT = 3000;
export const MAX_EVENTS_PER_SESSION = 300;
export const MAX_FLOW_PER_SESSION = 300;

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
}

export function addUsage(total, usage) {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.cacheWrite1h += usage.cacheWrite1h;
}

// One agent inside a session: the main agent (key '') or a subagent.
export function createAgent(key) {
  return {
    key,
    parentKey: key === '' ? null : '',
    name: '',
    type: '',
    model: '',
    usage: emptyUsage(),
    cost: 0,
    unpriced: false,
    requests: 0,
    toolCount: 0,
    errorCount: 0,
    firstAt: null,
    lastAt: null,
    // A subagent whose starting call has returned.
    done: false,
    spans: [],
    droppedSpans: 0,
  };
}

export function touch(agent, ts) {
  if (!Number.isFinite(ts)) return;
  if (agent.firstAt === null || ts < agent.firstAt) agent.firstAt = ts;
  if (agent.lastAt === null || ts > agent.lastAt) agent.lastAt = ts;
}

export function pushSpan(agent, span) {
  agent.spans.push(span);
  if (agent.spans.length > MAX_SPANS_PER_AGENT) {
    agent.spans.shift();
    agent.droppedSpans += 1;
  }
  return span;
}

// Prompts and orchestration commands, newest kept.
export function pushFlow(list, item) {
  list.push(item);
  if (list.length > MAX_FLOW_PER_SESSION) list.shift();
}

export function pushEvent(events, event) {
  events.push(event);
  if (events.length > MAX_EVENTS_PER_SESSION) events.shift();
}

export function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : '';
}

export function count(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function clip(text, max = 120) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Best-effort masking of secrets before a text is shown or stored: credentials in URLs, bearer
// tokens, well-known key shapes, and values of flags or variables named like a secret. It runs on
// the text before it is shortened, so a cut-off key cannot slip past its pattern.
const SECRET_NAME = '(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|authorization|session[_-]?id|cookie)';
const REDACTIONS = [
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/:@]{1,200}:[^\s/@]{1,200}@/gi, '$1***@'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/g, '$1 ***'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{16,}|\bxox[abeprs]-[A-Za-z0-9-]{10,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\bnpm_[A-Za-z0-9]{30,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '***'],
  [/(\s(?:-u|--user)\s+)[^\s:]{1,200}:\S+/g, '$1***'],
  [/(\b(?:docker\s+login|podman\s+login|mysql|mysqldump|mariadb|sshpass)\b[^|;&\n]{0,200}?\s-p\s?)(\S+)/g, '$1***'],
  [new RegExp(`(\\b[A-Za-z0-9_.-]{0,40}${SECRET_NAME}[A-Za-z0-9_.-]{0,40}\\s+)(?=[A-Za-z0-9+\\/=_-]*\\d)[A-Za-z0-9+\\/=_-]{16,}`, 'gi'), '$1***'],
  [new RegExp(`(--?[A-Za-z0-9-]{0,40}${SECRET_NAME}[A-Za-z0-9-]{0,40}(?:\\s+|=))("[^"]*"|'[^']*'|[^\\s"']+)`, 'gi'), '$1***'],
  [new RegExp(`(\\b[A-Za-z0-9_.]{0,40}${SECRET_NAME}[A-Za-z0-9_.]{0,40}\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s"'&|;,]+)`, 'gi'), '$1***'],
];
const REDACT_MAX = 4000;

export function redact(text) {
  let out = String(text ?? '').slice(0, REDACT_MAX);
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

// redact, then clip: what every text taken from a prompt, a command or an error goes through.
export function safeClip(text, max = 120) {
  return clip(redact(text), max);
}

export function baseName(path) {
  const parts = String(path ?? '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// A short label for a tool call: the file name, the command's first words (secrets masked, see
// redact), the host. Returns '' when labels are turned off or nothing short describes the call.
export function toolLabel(input, enabled = true) {
  if (!enabled || !isObject(input)) return '';
  const path = str(input.file_path) || str(input.notebook_path) || str(input.path);
  if (path) return baseName(path);
  const command = str(input.command) || str(input.cmd);
  if (command) return safeClip(command, 60);
  if (Array.isArray(input.command)) return safeClip(input.command.filter((w) => typeof w === 'string').join(' '), 60);
  const url = str(input.url);
  if (url) {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }
  return safeClip(str(input.description) || str(input.pattern) || str(input.query), 60);
}
