// Claude Code transcript lines (~/.claude/projects/<dir>/<session>.jsonl and its subagents) to a
// normalized session: agents, LLM and tool spans, usage, cost. Pure: no Node built-ins.
//
// Format facts this relies on (verify against your Claude Code version; it is not a stable contract):
//   - every line has `type`, `timestamp`, `sessionId`, `cwd`; subagent lines also carry `agentId`
//   - `assistant` lines hold `message.{id,model,usage,content[]}`; one message may span several lines
//   - a `tool_use` block opens a call; a `tool_result` block in a later `user` line closes it
//   - the `user` line closing an Agent/Task call may carry `toolUseResult.agentId`
import {
  addUsage, clip, count, createAgent, isObject, parseJsonObject, pushEvent, pushSpan, str, toolLabel, touch,
} from './shared.mjs';

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const SEEN_MAX = 20000;

export function createClaudeParser({ sessionId = '', cost = () => null, toolLabels = true } = {}) {
  const agents = new Map([['', createAgent('')]]);
  const seenUsage = new Set();
  const openTools = new Map(); // tool_use id → span
  const agentCalls = new Map(); // tool_use id of an Agent/Task call → { ownerKey, name, type, start, end, agentKey }
  const lastTs = new Map(); // agent key → timestamp of its previous line
  const lastLlm = new Map(); // agent key → { span, messageId }
  const events = [];
  let sid = sessionId;
  let cwd = '';
  let title = '';

  function agentFor(obj) {
    const key = str(obj.agentId) || (obj.isSidechain === true ? 'sidechain' : '');
    let agent = agents.get(key);
    if (!agent) {
      agent = createAgent(key);
      agents.set(key, agent);
    }
    return agent;
  }

  function assistant(obj, agent, ts) {
    const message = isObject(obj.message) ? obj.message : {};
    const model = str(message.model);
    const synthetic = model === '<synthetic>';
    if (model && !synthetic) agent.model = model;

    // One LLM span per message id: from the line that triggered it to its last content line.
    const messageId = str(message.id);
    const previous = lastLlm.get(agent.key);
    if (previous && messageId && previous.messageId === messageId) {
      previous.span.end = Math.max(previous.span.end, ts);
    } else if (!synthetic) {
      const start = Math.min(lastTs.get(agent.key) ?? ts, ts);
      const span = pushSpan(agent, { kind: 'llm', name: model || 'model', start, end: ts });
      lastLlm.set(agent.key, { span, messageId });
    }

    if (isObject(message.usage) && !synthetic) {
      const key = messageId ? `${messageId}:${str(obj.requestId)}` : '';
      if (!key || !seenUsage.has(key)) {
        if (key) {
          seenUsage.add(key);
          if (seenUsage.size > SEEN_MAX) seenUsage.delete(seenUsage.values().next().value);
        }
        const usage = claudeUsage(message.usage);
        addUsage(agent.usage, usage);
        agent.requests += 1;
        const usd = cost(model, usage);
        if (usd === null) agent.unpriced = true;
        else agent.cost += usd;
      }
    }

    for (const block of blocksOf(message.content)) {
      if (block.type !== 'tool_use') continue;
      const id = str(block.id);
      const name = str(block.name) || 'tool';
      const input = isObject(block.input) ? block.input : {};
      const span = pushSpan(agent, { kind: 'tool', name, label: toolLabel(input, toolLabels), start: ts, end: null, error: false });
      agent.toolCount += 1;
      if (id) openTools.set(id, span);
      if (id && SUBAGENT_TOOLS.has(name)) {
        agentCalls.set(id, {
          ownerKey: agent.key,
          name: clip(str(input.description) || str(input.subagent_type) || 'Subagent', 80),
          type: str(input.subagent_type),
          start: ts,
          end: null,
          agentKey: null,
        });
      }
    }
  }

  function user(obj, agent, ts) {
    const message = isObject(obj.message) ? obj.message : {};
    const rest = [];
    for (const block of blocksOf(message.content)) {
      if (block.type !== 'tool_result') {
        rest.push(block);
        continue;
      }
      const id = str(block.tool_use_id);
      const span = id ? openTools.get(id) : null;
      if (span) {
        span.end = Math.max(span.start, ts);
        span.error = block.is_error === true;
        if (span.error) {
          agent.errorCount += 1;
          pushEvent(events, { ts, agentKey: agent.key, level: 'error', text: `${span.name} failed${span.label ? `: ${span.label}` : ''}` });
        }
        openTools.delete(id);
      }
      const call = id ? agentCalls.get(id) : null;
      if (call) {
        call.end = ts;
        const linked = isObject(obj.toolUseResult) ? str(obj.toolUseResult.agentId) : '';
        if (linked) call.agentKey = linked;
      }
    }
    if (rest.length === 0 || obj.isMeta === true) return;
    if (obj.isCompactSummary === true) {
      pushEvent(events, { ts, agentKey: agent.key, level: 'info', text: 'Context compacted' });
      return;
    }
    const text = clip(rest.map((block) => (typeof block.text === 'string' ? block.text : '')).join(' '), 140);
    if (!text || text.startsWith('<')) return; // command output and injected context, not a prompt
    if (agent.key === '' && !title) title = clip(text, 80);
    if (agent.key === '') pushEvent(events, { ts, agentKey: '', level: 'info', text: `Prompt: ${text}` });
  }

  return {
    push(line) {
      const obj = parseJsonObject(line);
      if (!obj) return;
      if (obj.type === 'summary' && str(obj.summary)) {
        title = clip(obj.summary, 80);
        return;
      }
      if (str(obj.cwd)) cwd = obj.cwd;
      if (str(obj.sessionId) && !sid) sid = obj.sessionId;
      const ts = Date.parse(obj.timestamp);
      if (!Number.isFinite(ts)) return;
      const agent = agentFor(obj);
      if (obj.type === 'assistant') assistant(obj, agent, ts);
      else if (obj.type === 'user') user(obj, agent, ts);
      else if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
        pushEvent(events, { ts, agentKey: agent.key, level: 'info', text: 'Context compacted' });
      } else if (obj.type === 'system' && (obj.level === 'error' || obj.subtype === 'api_error')) {
        pushEvent(events, { ts, agentKey: agent.key, level: 'error', text: clip(str(obj.content) || 'API error', 140) });
      } else return;
      touch(agent, ts);
      lastTs.set(agent.key, ts);
    },

    // The session as it stands. Subagents are named and parented from the Agent/Task call that
    // started them: by `toolUseResult.agentId` when the transcript has it, else by start order.
    result() {
      const subagents = [...agents.values()].filter((agent) => agent.key !== '');
      const calls = [...agentCalls.values()];
      const claimed = new Set(calls.map((call) => call.agentKey).filter(Boolean));
      const unlinkedAgents = subagents.filter((agent) => !claimed.has(agent.key)).sort((a, b) => (a.firstAt ?? 0) - (b.firstAt ?? 0));
      const links = new Map(calls.filter((call) => call.agentKey).map((call) => [call.agentKey, call]));
      const unlinkedCalls = calls.filter((call) => !call.agentKey).sort((a, b) => a.start - b.start);
      for (const agent of unlinkedAgents) {
        // The earliest unclaimed call that began before this subagent's first line.
        const index = unlinkedCalls.findIndex((call) => agent.firstAt === null || call.start <= agent.firstAt + 1000);
        if (index < 0) continue;
        links.set(agent.key, unlinkedCalls[index]);
        unlinkedCalls.splice(index, 1);
      }
      for (const agent of subagents) {
        const call = links.get(agent.key);
        agent.parentKey = call ? call.ownerKey : '';
        agent.name = call?.name || 'Subagent';
        agent.type = call?.type || '';
        agent.done = Boolean(call && call.end !== null);
      }
      const main = agents.get('');
      main.name = title || 'Session';
      return {
        agentKind: 'claude',
        sessionId: sid,
        cwd,
        title,
        agents: [...agents.values()],
        events: [...events],
        openTools: openTools.size,
      };
    },
  };
}

// cacheWrite1h is the part of cacheWrite billed at the 1-hour rate.
export function claudeUsage(usage) {
  const cacheWrite = count(usage.cache_creation_input_tokens);
  return {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite,
    cacheWrite1h: Math.min(cacheWrite, count(usage.cache_creation?.ephemeral_1h_input_tokens)),
  };
}

function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter(isObject) : [];
}
