export function formatNum(v, digits = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

export function formatPercent(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(Math.max(0, Math.min(100, n))) : 0;
}

export function formatYUp(v, digits = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

export function formatErrorMessage(error) {
  const raw = String(error?.message || error || '').trim();
  if (!raw) return '未知错误';
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.error) return String(parsed.error);
  } catch (_) {}
  return raw;
}
