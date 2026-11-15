// Codex rollout lines (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) to a normalized session.
// Pure: no Node built-ins.
//
// Format facts this relies on (verify against your Codex version; it is not a stable contract):
//   - every line is { timestamp, type, payload }
//   - `session_meta` gives the session id and cwd; `turn_context` gives the model
//   - `event_msg` with payload.type `token_count` gives info.last_token_usage and total_token_usage
//   - `response_item` function_call / custom_tool_call opens a call (call_id);
//     function_call_output / custom_tool_call_output closes it
import { contentText, orchIds, parseOrchCommand } from './orch.mjs';
import {
  addUsage, clip, count, createAgent, isObject, parseJsonObject, pushEvent, pushFlow, pushSpan, safeClip, str, toolLabel, touch,
} from './shared.mjs';

const CALL_KINDS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);
const OUTPUT_KINDS = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output']);
const MAX_NAME = 100; // model and tool names are identifiers: anything longer is cut

export function createCodexParser({ sessionId = '', cost = () => null, toolLabels = true } = {}) {
  const main = createAgent('');
  const openTools = new Map();
  const events = [];
  const prompts = [];
  const orch = [];
  const orchCalls = new Map();
  let inboundIds = null;
  let sid = sessionId;
  let cwd = '';
  let title = '';
  let model = '';
  let lastTs = null;
  let llm = null; // the LLM span still growing, until a tool output or a user message ends it
  let lastTotal = '';

  function grow(ts) {
    if (llm) llm.end = Math.max(llm.end, ts);
    else llm = pushSpan(main, { kind: 'llm', name: model || 'model', start: Math.min(lastTs ?? ts, ts), end: ts });
  }

  function responseItem(payload, ts) {
    if (CALL_KINDS.has(payload.type)) {
      grow(ts);
      const name = clip(str(payload.name), MAX_NAME) || (payload.type === 'local_shell_call' ? 'shell' : 'tool');
      const args = parseArgs(payload.arguments ?? payload.action);
      const span = pushSpan(main, { kind: 'tool', name, label: toolLabel(args, toolLabels), start: ts, end: null, error: false });
      main.toolCount += 1;
      const id = str(payload.call_id) || str(payload.id);
      if (id) openTools.set(id, span);
      const command = parseOrchCommand(args.command ?? args.cmd, toolLabels);
      if (command) {
        span.orch = true;
        const record = { ts, agentKey: '', verb: command.verb, ids: command.ids, subject: command.subject, error: false };
        pushFlow(orch, record);
        if (id) orchCalls.set(id, record);
      }
    } else if (OUTPUT_KINDS.has(payload.type)) {
      const id = str(payload.call_id) || str(payload.id);
      const span = id ? openTools.get(id) : null;
      if (span) {
        span.end = Math.max(span.start, ts);
        openTools.delete(id);
      }
      const record = id ? orchCalls.get(id) : null;
      if (record) {
        const output = typeof payload.output === 'string' ? payload.output.slice(0, 8000) : contentText(payload.output?.content ?? payload.output);
        for (const found of orchIds(output)) if (!record.ids.includes(found) && record.ids.length < 24) record.ids.push(found);
        orchCalls.delete(id);
      }
      llm = null;
    } else if (payload.type === 'reasoning') {
      grow(ts);
    } else if (payload.type === 'message') {
      if (payload.role === 'assistant') grow(ts);
      else if (payload.role === 'user') {
        llm = null;
        const full = firstText(payload.content);
        const text = safeClip(full, 140);
        // Codex puts AGENTS.md and tagged context in user messages before the first prompt.
        if (text && !text.startsWith('<') && !text.startsWith('# AGENTS.md')) {
          const ids = orchIds(full);
          if (inboundIds === null) inboundIds = ids;
          if (!title) title = clip(text, 80);
          pushFlow(prompts, { ts, agentKey: '', text: toolLabels ? clip(text, 100) : '', ids });
          pushEvent(events, { ts, agentKey: '', level: 'info', text: `Prompt: ${text}` });
        }
      }
    }
  }

  function tokenCount(payload) {
    const info = isObject(payload.info) ? payload.info : {};
    const last = info.last_token_usage;
    if (!isObject(last)) return;
    // Codex repeats a token_count whose running total has not moved; a repeat adds no usage.
    const total = isObject(info.total_token_usage) ? JSON.stringify(info.total_token_usage) : '';
    if (total && total === lastTotal) return;
    lastTotal = total;
    const usage = codexUsage(last);
    addUsage(main.usage, usage);
    main.requests += 1;
    const usd = cost(model, usage);
    if (usd === null) main.unpriced = true;
    else main.cost += usd;
  }

  return {
    push(line) {
      const obj = parseJsonObject(line);
      if (!obj) return;
      const payload = isObject(obj.payload) ? obj.payload : {};
      const ts = Date.parse(obj.timestamp);
      if (obj.type === 'session_meta') {
        if (str(payload.id) && !sid) sid = payload.id;
        if (str(payload.cwd)) cwd = payload.cwd;
      } else if (obj.type === 'turn_context') {
        if (str(payload.model)) model = main.model = clip(payload.model, MAX_NAME);
        if (str(payload.cwd)) cwd = payload.cwd;
      }
      if (!Number.isFinite(ts)) return;
      if (obj.type === 'event_msg' && payload.type === 'token_count') tokenCount(payload);
      else if (obj.type === 'response_item') responseItem(payload, ts);
      else if (obj.type === 'compacted') pushEvent(events, { ts, agentKey: '', level: 'info', text: 'Context compacted' });
      else if (obj.type === 'event_msg' && (payload.type === 'error' || payload.type === 'stream_error')) {
        main.errorCount += 1;
        pushEvent(events, { ts, agentKey: '', level: 'error', text: safeClip(str(payload.message) || 'Error', 140) });
      } else if (obj.type !== 'session_meta' && obj.type !== 'turn_context') return;
      touch(main, ts);
      lastTs = ts;
    },

    result() {
      main.name = title || 'Session';
      return {
        agentKind: 'codex', sessionId: sid, cwd, title, agents: [main], events: [...events],
        prompts: [...prompts], orch: [...orch], inboundIds: inboundIds ?? [], openTools: openTools.size,
      };
    },
  };
}

// Codex counts cached input inside input_tokens, so input is the uncached part.
export function codexUsage(last) {
  const cacheRead = count(last.cached_input_tokens);
  return {
    input: Math.max(0, count(last.input_tokens) - cacheRead),
    output: count(last.output_tokens),
    cacheRead,
    cacheWrite: count(last.cache_write_input_tokens),
    cacheWrite1h: 0,
  };
}

function parseArgs(value) {
  const parsed = typeof value === 'string' ? parseJsonObject(value) : value;
  return isObject(parsed) ? parsed : {};
}

function firstText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const block = content.find((item) => isObject(item) && typeof item.text === 'string');
  return block ? block.text : '';
}
