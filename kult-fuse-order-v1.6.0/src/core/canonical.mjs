import crypto from 'node:crypto';

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export function sha256Hex(value) {
  const text = typeof value === 'string' ? value : canonicalize(value);
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function shortHash(hash, n = 8) {
  return hash ? `${hash.slice(0, n)}…${hash.slice(-n)}` : '—';
}
