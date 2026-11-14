// Estimated cost from a local price table. Pure: no Node built-ins.
import { PRICES } from './prices-data.mjs';

const BY_ID = new Map(PRICES.map((row) => [row.id, row]));
const IDS_LONGEST_FIRST = [...BY_ID.keys()].sort((a, b) => b.length - a.length);
const memo = new Map();

// 'anthropic/claude-opus-5-5-20261001[1m]' → 'claude-opus-5-5'
export function normalizeModel(model) {
  if (typeof model !== 'string') return '';
  let id = model.trim().toLowerCase();
  id = id.slice(id.lastIndexOf('/') + 1);
  id = id.replace(/\[[^\]]*\]$/, '').replace(/@.*$/, '').replace(/-\d{8}$/, '').replace(/-latest$/, '');
  return id;
}

// The price row for a model id, or null when the table has none. A dated or suffixed id falls back
// to the longest table id it starts with.
export function resolvePrice(model) {
  const id = normalizeModel(model);
  if (!id) return null;
  if (memo.has(id)) return memo.get(id);
  let row = BY_ID.get(id) ?? null;
  if (!row) {
    const prefix = IDS_LONGEST_FIRST.find((known) => id.startsWith(`${known}-`));
    row = prefix ? BY_ID.get(prefix) : null;
  }
  memo.set(id, row);
  return row;
}

// USD for one request, or null when the model is not in the table.
// usage: { input, output, cacheRead, cacheWrite, cacheWrite1h } with cacheWrite1h a part of cacheWrite.
export function requestCost(model, usage) {
  const row = resolvePrice(model);
  if (!row || !usage) return null;
  const input = num(usage.input);
  const output = num(usage.output);
  const cacheRead = num(usage.cacheRead);
  const cacheWrite = num(usage.cacheWrite);
  const write1h = Math.min(cacheWrite, num(usage.cacheWrite1h));
  let rate = row;
  if (Array.isArray(row.tiers)) {
    const prompt = input + cacheRead + cacheWrite;
    for (const tier of row.tiers) if (prompt > tier.above && tier.above >= (rate.above ?? -1)) rate = tier;
  }
  return (
    input * rate.input +
    output * rate.output +
    cacheRead * rate.cacheRead +
    (cacheWrite - write1h) * rate.cacheWrite +
    write1h * (rate.cacheWrite1h ?? rate.cacheWrite)
  ) / 1e6;
}

function num(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
