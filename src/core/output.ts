import type { Logger } from './types.js';
import { redact } from './secret.js';

/**
 * The ONLY place golive writes to stdout/stderr. Everything passes through `redact()`.
 * stdout carries one JSON document per command (for the agent); stderr carries progress for humans.
 */
export function emit(result: unknown, opts: { json: boolean }): void {
  const text = opts.json ? JSON.stringify(result, null, 2) : pretty(result);
  process.stdout.write(redact(text) + '\n');
}

export const logger: Logger = {
  info: (m) => process.stderr.write(redact(`· ${m}`) + '\n'),
  warn: (m) => process.stderr.write(redact(`! ${m}`) + '\n'),
};

export function silentLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(redact(m)), warn: (m) => lines.push(redact(`! ${m}`)) };
}

function pretty(v: unknown, indent = ''): string {
  if (v === null || v === undefined) return `${indent}-`;
  if (typeof v !== 'object') return `${indent}${String(v)}`;
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? pretty(x, indent + '  ') : `${indent}- ${String(x)}`)).join('\n') : `${indent}(none)`;
  return Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => (x !== null && typeof x === 'object' ? `${indent}${k}:\n${pretty(x, indent + '  ')}` : `${indent}${k}: ${String(x)}`))
    .join('\n');
}
