// Helpers shared by transcript adapters. Pure: no Node built-ins.

export const MAX_SPANS_PER_AGENT = 3000;
export const MAX_EVENTS_PER_SESSION = 300;

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

export function baseName(path) {
  const parts = String(path ?? '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// A short, non-sensitive label for a tool call: the file name, the command's first words, the host.
// Returns '' when labels are turned off or nothing short describes the call.
export function toolLabel(input, enabled = true) {
  if (!enabled || !isObject(input)) return '';
  const path = str(input.file_path) || str(input.notebook_path) || str(input.path);
  if (path) return baseName(path);
  const command = str(input.command) || str(input.cmd);
  if (command) return clip(command, 60);
  if (Array.isArray(input.command)) return clip(input.command.filter((w) => typeof w === 'string').join(' '), 60);
  const url = str(input.url);
  if (url) {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }
  return clip(str(input.description) || str(input.pattern) || str(input.query), 60);
}
