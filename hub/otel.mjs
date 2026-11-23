// OTLP/HTTP JSON receiver state: folds the log records Claude Code and Codex export into one
// usage row per agent session. Only numbers, names and ids are kept: prompt text, tool input and
// response bodies are never stored, even when an agent is configured to send them.
const KEEP_MS = 7 * 86_400_000;
const MAX_SESSIONS = 5000;
const MAX_SHAPES = 200;

// OTLP AnyValue → plain JS value.
export function anyValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('stringValue' in value) return value.stringValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('boolValue' in value) return Boolean(value.boolValue);
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(anyValue);
  if ('kvlistValue' in value) return attributes(value.kvlistValue.values);
  return null;
}

export function attributes(list) {
  const out = {};
  for (const item of Array.isArray(list) ? list : []) if (item && typeof item.key === 'string') out[item.key] = anyValue(item.value);
  return out;
}

const pickNumber = (attrs, ...keys) => {
  for (const key of keys) {
    const value = Number(attrs[key]);
    if (attrs[key] !== undefined && attrs[key] !== null && Number.isFinite(value)) return value;
  }
  return null;
};
const pickString = (attrs, ...keys) => {
  for (const key of keys) if (typeof attrs[key] === 'string' && attrs[key]) return attrs[key];
  return '';
};

// The event name, without the agent prefix: "claude_code.api_request" and "codex.api_request"
// both become "api_request".
function eventName(record, attrs) {
  const raw = pickString(attrs, 'event.name') || (typeof anyValue(record.body) === 'string' ? anyValue(record.body) : '');
  return raw.replace(/^(claude_code|codex)\./, '');
}

export function createOtelStore({ now = () => Date.now() } = {}) {
  const sessions = new Map(); // session id → usage row
  const shapes = new Map(); // `${service}:${event}` → attribute keys seen (no values), for tuning
  let records = 0;

  function row(id, service) {
    let item = sessions.get(id);
    if (!item) {
      item = {
        sessionId: id, service, model: '', costUsd: 0, priced: false, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        requests: 0, apiErrors: 0, tools: 0, toolErrors: 0, firstAt: null, lastAt: null,
      };
      sessions.set(id, item);
      if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    }
    return item;
  }

  function addRecord(record, resourceAttrs) {
    records += 1;
    const attrs = { ...resourceAttrs, ...attributes(record.attributes) };
    const service = pickString(attrs, 'service.name') || 'unknown';
    const name = eventName(record, attrs);
    const shapeKey = `${service}:${name}`;
    if (!shapes.has(shapeKey) && shapes.size < MAX_SHAPES) shapes.set(shapeKey, Object.keys(attrs).sort());
    const id = pickString(attrs, 'session.id', 'conversation.id', 'thread.id', 'thread_id', 'session_id');
    if (!id) return;
    const at = Number(record.timeUnixNano) / 1e6 || Number(record.observedTimeUnixNano) / 1e6 || now();
    const item = row(id, service);
    item.firstAt = item.firstAt === null ? at : Math.min(item.firstAt, at);
    item.lastAt = item.lastAt === null ? at : Math.max(item.lastAt, at);
    const model = pickString(attrs, 'model', 'gen_ai.request.model', 'model_name');
    if (name === 'api_request' || name === 'response.completed' || /token/.test(name)) {
      const input = pickNumber(attrs, 'input_tokens', 'input_token_count', 'gen_ai.usage.input_tokens');
      const output = pickNumber(attrs, 'output_tokens', 'output_token_count', 'gen_ai.usage.output_tokens');
      const cacheRead = pickNumber(attrs, 'cache_read_tokens', 'cached_token_count', 'cached_input_token_count');
      const cacheWrite = pickNumber(attrs, 'cache_creation_tokens');
      const cost = pickNumber(attrs, 'cost_usd', 'cost');
      if (input === null && output === null && cost === null) return;
      item.requests += 1;
      item.input += input ?? 0;
      item.output += output ?? 0;
      item.cacheRead += cacheRead ?? 0;
      item.cacheWrite += cacheWrite ?? 0;
      if (cost !== null) {
        item.costUsd += cost;
        item.priced = true;
      }
      if (model) item.model = model;
    } else if (name === 'api_error') {
      item.apiErrors += 1;
    } else if (name === 'tool_result') {
      item.tools += 1;
      const ok = attrs.success;
      if (ok === false || ok === 'false') item.toolErrors += 1;
    }
  }

  return {
    // An OTLP ExportLogsServiceRequest in its JSON encoding.
    ingestLogs(body) {
      for (const resourceLogs of Array.isArray(body?.resourceLogs) ? body.resourceLogs : []) {
        const resourceAttrs = attributes(resourceLogs.resource?.attributes);
        for (const scope of resourceLogs.scopeLogs ?? []) for (const record of scope.logRecords ?? []) addRecord(record, resourceAttrs);
      }
    },
    prune() {
      const cutoff = now() - KEEP_MS;
      for (const [id, item] of sessions) if ((item.lastAt ?? 0) < cutoff) sessions.delete(id);
    },
    get(id) {
      return sessions.get(id) ?? null;
    },
    stats() {
      return { records, sessions: sessions.size, shapes: Object.fromEntries(shapes) };
    },
    serialize() {
      return { version: 1, sessions: [...sessions.values()] };
    },
    restore(data) {
      if (data?.version !== 1 || !Array.isArray(data.sessions)) return;
      for (const item of data.sessions) if (item && typeof item.sessionId === 'string') sessions.set(item.sessionId, item);
    },
  };
}
