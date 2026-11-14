// Number and name formatting for the view. Pure.

// 412 → "<1s", 7100 → "7.1s", 41000 → "41s", 65000 → "1m 05s", 8040000 → "2h 14m".
// `axis` drops the padding and zero parts, for tick labels: 60000 → "1m", 5400000 → "1h 30m".
export function fmtDuration(ms, axis = false) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return axis ? `${Math.round(ms)}ms` : '<1s';
  const seconds = ms / 1000;
  if (seconds < 10 && !axis) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const totalMinutes = Math.floor(seconds / 60);
  const restSeconds = Math.floor(seconds % 60);
  if (totalMinutes < 60) {
    if (axis) return restSeconds ? `${totalMinutes}m ${restSeconds}s` : `${totalMinutes}m`;
    return `${totalMinutes}m ${String(restSeconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 48) return axis && !minutes ? `${hours}h` : `${hours}h ${String(minutes).padStart(axis ? 1 : 2, '0')}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

// 583300 → "583.3K", 1240000 → "1.24M".
export function fmtTokens(count) {
  if (!Number.isFinite(count)) return '';
  if (count < 1000) return String(Math.round(count));
  if (count < 1e6) return `${(count / 1e3).toFixed(count < 1e5 ? 1 : 0)}K`;
  if (count < 1e9) return `${(count / 1e6).toFixed(2)}M`;
  return `${(count / 1e9).toFixed(2)}B`;
}

export function fmtCost(usd) {
  if (!Number.isFinite(usd)) return '';
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

export function fmtClock(ts) {
  const date = new Date(ts);
  const two = (value) => String(value).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

// 'claude-opus-5-5-20261001' → 'Opus 5.5'; 'gpt-6-sol' → 'GPT-6 Sol'; anything else stays as it is.
export function prettyModel(model) {
  if (typeof model !== 'string' || !model) return '';
  let id = model.slice(model.lastIndexOf('/') + 1).replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id);
  if (claude) return `${cap(claude[1])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(id);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${gpt[2].split('-').map(cap).join(' ')}` : ''}`;
  const gemini = /^gemini-([\d.]+)-(.+)$/.exec(id);
  if (gemini) return `Gemini ${gemini[1]} ${gemini[2].split('-').map(cap).join(' ')}`;
  return id;
}

function cap(word) {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : '';
}

const STEPS = [
  1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
  3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000, 172_800_000,
];

// The smallest round step that is at least `ms`.
export function niceStep(ms) {
  return STEPS.find((step) => step >= ms) ?? STEPS[STEPS.length - 1];
}
