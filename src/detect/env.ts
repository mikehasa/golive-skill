import { clientPrefix } from '../core/envmap.js';
import type { EnvRef, Finding } from '../core/types.js';
import { EXAMPLE_ENV_FILES, type Repo } from './fs.js';

/**
 * Env var NAMES the app references. Values are never read: real env files are refused by Repo, and
 * values in example files are only used (in memory) to guess the database provider.
 */

export interface Occurrence {
  name: string;
  file: string;
  /** Exposed to the browser at this reference site. */
  exposed: boolean;
}

const NAME = '[A-Z_][A-Z0-9_]*';
const Q = `(['"\`])`;
/** Vite/Astro built-ins on import.meta.env that are not env vars. */
const META_BUILTINS = new Set(['MODE', 'BASE_URL', 'PROD', 'DEV', 'SSR', 'SITE', 'ASSETS_PREFIX']);

const PATTERNS: Array<{ re: RegExp; group: number; kind: 'node' | 'meta' | 'deno' }> = [
  { re: new RegExp(`process\\.env\\??\\.(${NAME})\\b`, 'g'), group: 1, kind: 'node' },
  { re: new RegExp(`process\\.env\\??\\.?\\[\\s*${Q}(${NAME})\\1\\s*\\]`, 'g'), group: 2, kind: 'node' },
  { re: new RegExp(`import\\.meta\\.env\\??\\.(${NAME})\\b`, 'g'), group: 1, kind: 'meta' },
  { re: new RegExp(`import\\.meta\\.env\\??\\.?\\[\\s*${Q}(${NAME})\\1\\s*\\]`, 'g'), group: 2, kind: 'meta' },
  { re: new RegExp(`Bun\\.env\\.(${NAME})\\b`, 'g'), group: 1, kind: 'node' },
  { re: new RegExp(`Deno\\.env\\.get\\(\\s*${Q}([A-Za-z_][A-Za-z0-9_]*)\\1\\s*\\)`, 'g'), group: 2, kind: 'deno' },
];

const isName = (s: string): boolean => new RegExp(`^${NAME}$`).test(s);

/** `{ A, B as C, type D }` → [{ imported: 'A', local: 'A' }, { imported: 'B', local: 'C' }]. */
export function parseNamedImports(list: string): Array<{ imported: string; local: string }> {
  return list
    .split(',')
    .map((s) => s.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((s) => {
      const [imported = '', local] = s.split(/\s+as\s+/);
      return { imported: imported.trim(), local: (local ?? imported).trim() };
    });
}

export function scanSource(file: string, text: string): { occ: Occurrence[]; dynamic: boolean } {
  const occ: Occurrence[] = [];
  const add = (name: string, exposed: boolean): void => {
    occ.push({ name, file, exposed });
  };
  const inEdgeFn = file.startsWith('supabase/functions/');

  for (const { re, group, kind } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const name = m[group]!;
      if (kind === 'meta' && META_BUILTINS.has(name)) continue;
      // Supabase injects SUPABASE_* into every Edge Function; the host never needs to provide them.
      if (kind === 'deno' && inEdgeFn && name.startsWith('SUPABASE_')) continue;
      add(name, kind !== 'deno' && clientPrefix(name) !== null);
    }
  }

  // const { A, B: b } = process.env
  for (const m of text.matchAll(/\{([^{}]*)\}\s*=\s*process\.env\b/g)) {
    for (const part of m[1]!.split(',')) {
      const key = part.split(/[:=]/)[0]!.trim();
      if (isName(key)) add(key, clientPrefix(key) !== null);
    }
  }

  scanSvelteKit(text, add);
  scanAstroEnv(text, add);
  scanNuxtRuntimeConfig(text, add);

  const dynamic = /process\.env\[\s*[a-zA-Z_$]/.test(text);
  return { occ, dynamic };
}

function scanSvelteKit(text: string, add: (name: string, exposed: boolean) => void): void {
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\$env\/static\/(private|public)['"]/g)) {
    for (const { imported } of parseNamedImports(m[1]!)) if (isName(imported)) add(imported, m[2] === 'public');
  }
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\$env\/dynamic\/(private|public)['"]/g)) {
    const binding = parseNamedImports(m[1]!).find((i) => i.imported === 'env')?.local;
    if (!binding || !/^[A-Za-z_$][\w$]*$/.test(binding)) continue;
    for (const r of text.matchAll(new RegExp(`\\b${binding.replace(/\$/g, '\\$')}\\.(${NAME})\\b`, 'g'))) add(r[1]!, m[2] === 'public');
  }
}

function scanAstroEnv(text: string, add: (name: string, exposed: boolean) => void): void {
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]astro:env\/(client|server)['"]/g)) {
    for (const { imported } of parseNamedImports(m[1]!)) if (isName(imported)) add(imported, m[2] === 'client');
  }
  for (const m of text.matchAll(new RegExp(`\\bgetSecret\\(\\s*${Q}(${NAME})\\1\\s*\\)`, 'g'))) add(m[2]!, false);
}

/** useRuntimeConfig().apiSecret → NUXT_API_SECRET; useRuntimeConfig().public.apiBase → NUXT_PUBLIC_API_BASE. */
function scanNuxtRuntimeConfig(text: string, add: (name: string, exposed: boolean) => void): void {
  for (const m of text.matchAll(/useRuntimeConfig\(\s*\)\s*\.\s*(public\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const pub = Boolean(m[1]);
    const key = m[2]!;
    if (!pub && (key === 'public' || key === 'app')) continue;
    add(nuxtEnvName(key, pub), pub);
  }
}

export function nuxtEnvName(key: string, pub: boolean): string {
  const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toUpperCase();
  return `NUXT_${pub ? 'PUBLIC_' : ''}${snake}`;
}

/** Keys declared in nuxt.config `runtimeConfig` (the source of truth for Nuxt env names). */
export function nuxtConfigNames(text: string): Array<{ name: string; exposed: boolean }> {
  const m = /runtimeConfig\s*:\s*\{/.exec(text);
  if (!m) return [];
  const out: Array<{ name: string; exposed: boolean }> = [];
  for (const { key, objectAt } of objectKeys(text, m.index + m[0].length - 1)) {
    if (key === 'public' && objectAt !== null) {
      for (const pk of objectKeys(text, objectAt)) out.push({ name: nuxtEnvName(pk.key, true), exposed: true });
    } else if (key !== 'app') {
      out.push({ name: nuxtEnvName(key, false), exposed: false });
    }
  }
  return out;
}

/** One entry of an object literal: `key: value`, shorthand `key`, or spread `...value` (key null). */
export interface ObjectEntry {
  key: string | null;
  spread: boolean;
  /** Source text of the value (trimmed); for shorthand, the identifier itself. */
  value: string;
  /** Index of the `{` when the value is itself an object literal. */
  objectAt: number | null;
}

/**
 * Top-level entries of the object literal whose `{` is at `open`. Small scanner: skips strings,
 * comments and nested brackets. Method shorthand (`foo() {}`) is skipped.
 */
export function objectEntries(src: string, open: number): ObjectEntry[] {
  const entries: ObjectEntry[] = [];
  let depth = 0;
  let expectKey = true;
  let cur: { key: string | null; spread: boolean; start: number } | null = null;
  const close = (end: number): void => {
    if (!cur) return;
    const raw = src.slice(cur.start, end);
    const lead = raw.length - raw.trimStart().length;
    const value = raw.trim();
    entries.push({ key: cur.key, spread: cur.spread, value, objectAt: value.startsWith('{') ? cur.start + lead : null });
    cur = null;
  };
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const end = src[i + 1] === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2) + 1;
      if (end <= 0) break;
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let end = i + 1;
      while (end < src.length && src[end] !== c) end += src[end] === '\\' ? 2 : 1;
      if (end >= src.length) break;
      if (depth === 1 && expectKey && /^\s*:/.test(src.slice(end + 1))) startKey(src.slice(i + 1, end), end + 1);
      i = end;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) {
        close(i);
        break;
      }
    } else if (depth === 1 && c === ',') {
      close(i);
      expectKey = true;
    } else if (depth === 1 && expectKey && src.startsWith('...', i)) {
      cur = { key: null, spread: true, start: i + 3 };
      expectKey = false;
      i += 2;
    } else if (depth === 1 && expectKey && /[A-Za-z_$]/.test(c)) {
      const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))![0];
      const after = i + id.length;
      const rest = src.slice(after);
      if (/^\s*:/.test(rest)) startKey(id, after);
      else if (/^\s*[,}]/.test(rest)) cur = { key: id, spread: false, start: i }; // shorthand
      else expectKey = false; // method shorthand, get/set, async: not a data key
      i = after - 1;
    }
  }
  return entries;

  function startKey(key: string, after: number): void {
    const v = /^\s*:\s*/.exec(src.slice(after))!;
    cur = { key, spread: false, start: after + v[0].length };
    expectKey = false;
  }
}

/** Top-level keys of the object literal whose `{` is at `open`, with nested object positions. */
function objectKeys(src: string, open: number): Array<{ key: string; objectAt: number | null }> {
  return objectEntries(src, open)
    .filter((e): e is ObjectEntry & { key: string } => e.key !== null)
    .map((e) => ({ key: e.key, objectAt: e.objectAt }));
}

// ── Framework config that inlines env into the browser ──────────────────────────────────────────

/**
 * What a framework config makes public beyond the default client prefixes:
 * - `names`: inlined individually (next.config `env: {}` keys, Vite/Astro `define` of process.env.X /
 *   import.meta.env.X, or env reads inside a define/env value).
 * - `prefixes`: extra public prefixes (Vite/Astro `envPrefix`, SvelteKit `kit.env.publicPrefix`).
 * - `all`: causes that inline EVERY env var (define of the whole process.env / import.meta.env, an
 *   empty public prefix, ...).
 */
export interface ConfigExposure {
  names: Array<{ name: string; file: string; via: string }>;
  prefixes: Array<{ prefix: string; file: string; via: string }>;
  all: Array<{ file: string; via: string }>;
  /** Things we could not resolve statically (human-readable, secret-free). */
  unresolved: string[];
}

const CONFIG_EXT = '\\.(?:[cm]?[jt]s)$';
const NEXT_CONFIG = new RegExp(`^next\\.config${CONFIG_EXT}`);
const VITE_LIKE_CONFIG = new RegExp(`^(?:vite|astro)\\.config${CONFIG_EXT}`);
const SVELTE_CONFIG = new RegExp(`^svelte\\.config${CONFIG_EXT}`);
const WEBPACK_CONFIG = new RegExp(`^webpack\\.config${CONFIG_EXT}`);
const ENV_OBJ = '(?:process\\.env|import\\.meta\\.env)';
/** `process.env` / `import.meta.env` used as a whole object (not a member read). */
const WHOLE_ENV = new RegExp(`\\b${ENV_OBJ}\\b(?!\\s*(?:\\?\\.|\\.|\\[))`);
/** `'process.env.' + k` / `` `process.env.${k}` ``: every name mapped programmatically. */
const COMPUTED_ENV_KEY = new RegExp(`(['"\`])${ENV_OBJ}\\.\\1\\s*\\+|\`${ENV_OBJ}\\.\\$\\{`);
const ENV_MEMBER = new RegExp(`\\b${ENV_OBJ}(?:\\??\\.(${NAME})\\b|(?:\\?\\.)?\\[\\s*${Q}(${NAME})\\2\\s*\\])`, 'g');

/** Scans the framework config files among `sources` (repo root only) for env it inlines into the browser. */
export function configExposure(sources: Map<string, string>): ConfigExposure {
  const out: ConfigExposure = { names: [], prefixes: [], all: [], unresolved: [] };
  const files = [...sources.keys()].filter((f) => NEXT_CONFIG.test(f) || VITE_LIKE_CONFIG.test(f) || SVELTE_CONFIG.test(f) || WEBPACK_CONFIG.test(f)).sort();
  for (const file of files) {
    const text = sources.get(file)!;
    const ctx: ScanCtx = { file, text, loadEnvAll: loadEnvBindings(text), out, seen: new Set() };
    const blocks: Array<{ kind: 'env' | 'define'; open: number; via: string }> = [];
    // Values that are not an object literal: an identifier, a call, shorthand (`{ define }`), ...
    const exprs: Array<{ kind: 'env' | 'define'; at: number; via: string; expr: string }> = [];
    const addExpr = (kind: 'env' | 'define', via: string, at: number): void => {
      const expr = readExpr(text, at);
      if (expr) exprs.push({ kind, at, via, expr });
    };
    if (NEXT_CONFIG.test(file)) {
      for (const m of text.matchAll(/(?<![.\w$])env\s*:\s*\{/g)) blocks.push({ kind: 'env', open: m.index! + m[0].length - 1, via: 'env' });
      for (const m of text.matchAll(/(?<![.\w$])env\s*:\s*(?![\s{])/g)) addExpr('env', 'env', m.index! + m[0].length);
      for (const m of text.matchAll(/(?<=[{,]\s*)env(?=\s*[,}])/g)) addExpr('env', 'env', m.index!);
    }
    if (!SVELTE_CONFIG.test(file)) {
      for (const m of text.matchAll(/(?<![.\w$])define\s*:\s*\{/g)) blocks.push({ kind: 'define', open: m.index! + m[0].length - 1, via: 'define' });
      for (const m of text.matchAll(/(?<![.\w$])define\s*:\s*(?![\s{])/g)) addExpr('define', 'define', m.index! + m[0].length);
      for (const m of text.matchAll(/(?<=[{,]\s*)define(?=\s*[,}])/g)) addExpr('define', 'define', m.index!);
      for (const m of text.matchAll(/\bDefinePlugin\s*\(\s*\{/g)) blocks.push({ kind: 'define', open: m.index! + m[0].length - 1, via: 'DefinePlugin' });
      for (const m of text.matchAll(/\bDefinePlugin\s*\(\s*(?![\s{)])/g)) addExpr('define', 'DefinePlugin', m.index! + m[0].length);
    }
    for (const b of blocks) scanInlineBlock(ctx, b);
    for (const e of exprs) scanExpr(ctx, e, 0);

    if (VITE_LIKE_CONFIG.test(file)) {
      for (const m of text.matchAll(/\benvPrefix\s*:\s*(\[[^\]]*\]|(['"`])[^'"`]*\2)/g)) {
        for (const s of m[1]!.matchAll(/(['"`])([^'"`]*)\1/g)) addPrefix(s[2]!, file, 'envPrefix', out);
      }
    }
    if (SVELTE_CONFIG.test(file)) {
      for (const m of text.matchAll(/\bpublicPrefix\s*:\s*(['"`])([^'"`]*)\1/g)) addPrefix(m[2]!, file, 'kit.env.publicPrefix', out);
    }
  }
  return out;
}

function addPrefix(prefix: string, file: string, via: string, out: ConfigExposure): void {
  if (prefix === '') out.all.push({ file, via: `${via} is '' (every env var is public)` });
  else out.prefixes.push({ prefix, file, via });
}

/**
 * Identifiers bound to `loadEnv(mode, dir, prefixes)` with a non-default prefix argument: such an
 * object holds every env var (prefix '') or every var with those prefixes, not just VITE_ ones.
 */
function loadEnvBindings(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*loadEnv\s*\(/g)) {
    const args = callArgs(text, m.index! + m[0].length - 1);
    if (args.length >= 3 && !/^(['"`])VITE_\1$/.test(args[2]!)) out.add(m[1]!);
  }
  return out;
}

/** Top-level, trimmed argument texts of the call whose `(` is at `open`. */
function callArgs(src: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') {
      let end = i + 1;
      while (end < src.length && src[end] !== c) end += src[end] === '\\' ? 2 : 1;
      i = end;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) {
        args.push(src.slice(start, i).trim());
        break;
      }
    } else if (c === ',' && depth === 1) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args.filter(Boolean);
}

interface ScanCtx {
  file: string;
  text: string;
  /** Identifiers bound to a loadEnv() result that holds non-public names. */
  loadEnvAll: Set<string>;
  out: ConfigExposure;
  /** Object literals already scanned (by `{` index), so a shared declaration is reported once. */
  seen: Set<number>;
}

const escId = (id: string): string => id.replace(/\$/g, '\\$');
/** A loadEnvAll binding used as a whole object (`env`, `Object.entries(env)`), not a member read. */
const wholeBinding = (ctx: ScanCtx, v: string): boolean => [...ctx.loadEnvAll].some((id) => new RegExp(`(?<![\\w$.])${escId(id)}\\b(?!\\s*(?:\\?\\.|\\.|\\[))`).test(v));
/** Env names read one by one inside `v` (process.env.X, import.meta.env.X, env.X of a loadEnvAll binding). */
function envReads(ctx: ScanCtx, v: string): string[] {
  const names: string[] = [];
  for (const m of v.matchAll(ENV_MEMBER)) names.push((m[1] ?? m[3])!);
  for (const id of ctx.loadEnvAll) {
    for (const m of v.matchAll(new RegExp(`(?<![\\w$.])${escId(id)}\\??\\.(${NAME})\\b`, 'g'))) names.push(m[1]!);
  }
  return names;
}

/** Why `v` inlines every env var, or null. */
function wholeEnvCause(ctx: ScanCtx, kind: 'env' | 'define', v: string): string | null {
  if (WHOLE_ENV.test(v) || wholeBinding(ctx, v)) return 'inlines the whole env object';
  if (kind === 'define' && COMPUTED_ENV_KEY.test(v)) return 'maps every env var to process.env.* keys';
  return null;
}

const LITERAL_VALUE = /^(?:true|false|null|undefined|void 0|-?\d[\d_.eE+-]*|(['"`])(?:(?!\1)[^\\]|\\.)*\1)$/;
const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Source text of the expression starting at `start`: up to the next top-level `,` `;` `)` `]` `}`,
 * or a line break that ends the statement. Skips strings, comments and nested brackets.
 */
export function readExpr(src: string, start: number): string {
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const end = src[i + 1] === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2) + 1;
      if (end <= 0) {
        i = src.length;
        break;
      }
      if (src[i + 1] === '/') {
        i = end - 1; // let the newline be seen below
        continue;
      }
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let end = i + 1;
      while (end < src.length && src[end] !== c) end += src[end] === '\\' ? 2 : 1;
      i = end;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === ',' || c === ';')) break;
    else if (depth === 0 && c === '\n') {
      const before = src.slice(start, i).replace(/\/\/[^\n]*$/, '').trimEnd();
      const after = src.slice(i + 1).trimStart();
      const continues = /[=+\-*/%(,?:&|!<>.]$/.test(before) || (/^[.?:+\-*/%&|=<>]/.test(after) && !/^\/[/*]/.test(after));
      if (before && !continues) break;
    }
  }
  return src.slice(start, i).trim();
}

/** Nearest `const|let|var id = ...` before `at` (else the first after it): where its initializer starts. */
function findDecl(text: string, id: string, at: number): number | null {
  let best: number | null = null;
  for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+${escId(id)}\\s*(?::[^=;]+?)?=(?![=>])\\s*`, 'g'))) {
    const init = m.index! + m[0].length;
    if (m.index! < at || best === null) best = init;
    if (m.index! >= at) break;
  }
  return best;
}

/** A non-literal define / next.config env value: resolve a local declaration, else fail closed or note it. */
function scanExpr(ctx: ScanCtx, e: { kind: 'env' | 'define'; at: number; via: string; expr: string }, depth: number): void {
  const { file, text, out } = ctx;
  const expr = e.expr.replace(/\s+(?:as\s+const|satisfies\s+[\w$.<>, ]+)$/, '');
  if (LITERAL_VALUE.test(expr)) return;
  const cause = wholeEnvCause(ctx, e.kind, expr);
  if (cause) {
    out.all.push({ file, via: `${e.via} ${cause}` });
    return;
  }
  if (IDENT.test(expr) && depth < 4) {
    const init = findDecl(text, expr, e.at);
    if (init !== null) {
      const via = `${e.via} (${expr})`;
      if (text[init] === '{') {
        if (!ctx.seen.has(init)) {
          ctx.seen.add(init);
          scanInlineBlock(ctx, { kind: e.kind, open: init, via });
        }
      } else {
        const initExpr = readExpr(text, init);
        // loadEnv() with the default (VITE_) prefix only holds public names.
        if (!/^loadEnv\s*\(/.test(initExpr)) scanExpr(ctx, { kind: e.kind, at: init, via, expr: initExpr }, depth + 1);
      }
      scanMutations(ctx, e.kind, expr, via);
      return;
    }
  }
  for (const n of envReads(ctx, expr)) out.names.push({ name: n, file, via: `${e.via} value` });
  out.unresolved.push(`${file} ${e.via} is set from an expression golive cannot read; make sure it holds no server secrets`);
}

/** `defs['process.env.X'] = ...`, `defs.X = ...`, `Object.assign(defs, ...)` after the declaration. */
function scanMutations(ctx: ScanCtx, kind: 'env' | 'define', id: string, via: string): void {
  const { file, text, out } = ctx;
  const re = new RegExp(`(?<![\\w$.])${escId(id)}\\s*(?:\\[[^\\]\\n]*\\]|\\.[\\w$]+)\\s*=(?![=>])|\\bObject\\.assign\\s*\\(\\s*${escId(id)}\\b`, 'g');
  for (const m of text.matchAll(re)) {
    const stmt = readExpr(text, m.index!);
    const cause = wholeEnvCause(ctx, kind, stmt);
    if (cause) {
      out.all.push({ file, via: `${via} ${cause}` });
      continue;
    }
    for (const n of envReads(ctx, stmt)) out.names.push({ name: n, file, via: `${via} value` });
    const whole = new RegExp(`^[^=]*\\[\\s*(['"\`])${ENV_OBJ}\\1\\s*\\]\\s*=\\s*([\\s\\S]*)$`).exec(stmt);
    if (whole && !/^(?:\{\s*\}|(['"`])\{\s*\}\1|JSON\.stringify\(\s*\{\s*\}\s*\))$/.test(whole[2]!.trim())) {
      out.unresolved.push(`${file} ${via} sets 'process.env' from an expression golive cannot read; make sure it holds no server secrets`);
    }
  }
}

function scanInlineBlock(ctx: ScanCtx, b: { kind: 'env' | 'define'; open: number; via: string }): void {
  const { file, text, out } = ctx;
  const addName = (name: string, how: string): void => {
    out.names.push({ name, file, via: `${b.via} ${how}` });
  };
  const valueReads = (v: string): void => {
    for (const n of envReads(ctx, v)) addName(n, 'value');
  };

  for (const e of objectEntries(text, b.open)) {
    if (WHOLE_ENV.test(e.value) || wholeBinding(ctx, e.value)) {
      const what = e.spread ? `spreads the whole env` : `${e.key ?? ''}: inlines the whole env object`;
      out.all.push({ file, via: `${b.via} ${what}`.replace(/\s+/g, ' ') });
      continue;
    }
    if (e.spread) {
      if (b.kind === 'define' && COMPUTED_ENV_KEY.test(e.value)) out.all.push({ file, via: `${b.via} maps every env var to process.env.* keys` });
      else if (IDENT.test(e.value)) scanExpr(ctx, { kind: b.kind, at: b.open, via: `${b.via} ...`, expr: e.value }, 1);
      else valueReads(e.value);
      continue;
    }
    const key = e.key!.replace(/\s+/g, '');
    if (b.kind === 'env') {
      if (isName(key)) addName(key, 'key');
    } else if (key === 'process.env' || key === 'import.meta.env') {
      if (e.objectAt !== null) {
        for (const k of objectEntries(text, e.objectAt)) if (k.key && isName(k.key)) addName(k.key, `${key}.${k.key}`);
      } else if (!/^(?:\{\s*\}|(['"`])\{\s*\}\1|JSON\.stringify\(\s*\{\s*\}\s*\))$/.test(e.value)) {
        out.unresolved.push(`${file} ${b.via} sets '${key}' from an expression golive cannot read; make sure it holds no server secrets`);
      }
    } else {
      const m = new RegExp(`^${ENV_OBJ}\\.(${NAME})$`).exec(key);
      if (m) addName(m[1]!, 'key');
    }
    valueReads(e.value);
  }
}

const SECRET_LOOKING = /SECRET|PRIVATE|PASSWORD|PASSWD|SERVICE_ROLE|TOKEN|CREDENTIAL|(^|_)(API_)?KEY$|DATABASE_URL|DB_URL|POSTGRES_URL|DIRECT_URL/;
const NOT_SECRET = /PUBLISHABLE|ANON_KEY|PUBLIC_KEY|(^|_)PUBLIC_/;
/** Name shape of a server secret (heuristic, used only to word findings). */
export const secretLooking = (name: string): boolean => SECRET_LOOKING.test(name) && !NOT_SECRET.test(name);

// ── .env.example ────────────────────────────────────────────────────────────────────────────────

export interface EnvExamples {
  /** name → example files declaring it. */
  names: Map<string, string[]>;
  /** Database provider ids hinted by placeholder values (host names, URL schemes). */
  dbHints: Set<string>;
  files: string[];
}

const DB_HINTS: Array<[RegExp, string]> = [
  [/neon\.tech/i, 'neon'],
  [/psdb\.cloud/i, 'planetscale'],
  [/^['"]?libsql:\/\//i, 'turso'],
  [/\.supabase\.(co|com)\b|pooler\.supabase\.com/i, 'supabase'],
  [/^['"]?mongodb(\+srv)?:\/\//i, 'mongodb'],
  [/prisma\+postgres:\/\/|db\.prisma\.io/i, 'prisma-postgres'],
  [/\.convex\.cloud/i, 'convex'],
];

export async function readEnvExamples(repo: Repo): Promise<EnvExamples> {
  const out: EnvExamples = { names: new Map(), dbHints: new Set(), files: [] };
  for (const file of EXAMPLE_ENV_FILES) {
    const text = await repo.read(file);
    if (text === null) continue;
    out.files.push(file);
    for (const { name, value } of parseDotenv(text)) {
      out.names.set(name, [...(out.names.get(name) ?? []), file]);
      for (const [re, id] of DB_HINTS) if (re.test(value)) out.dbHints.add(id);
    }
  }
  return out;
}

/** Minimal dotenv parser (KEY=value, `export`, comments, multi-line double quotes). */
export function parseDotenv(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    let value = m[2]!;
    if (value.startsWith('"') && !/^"(?:[^"\\]|\\.)*"/.test(value)) {
      // Multi-line value: skip continuation lines up to the closing quote.
      while (i + 1 < lines.length) {
        i++;
        if (lines[i]!.includes('"')) break;
      }
      value = '';
    }
    out.push({ name: m[1]!, value });
  }
  return out;
}

// ── Aggregation ─────────────────────────────────────────────────────────────────────────────────

export function collectEnvRefs(sources: Map<string, string>, examples: EnvExamples, notes: string[], findings: Finding[] = []): EnvRef[] {
  const occ: Occurrence[] = [];
  const dynamicFiles: string[] = [];
  for (const [file, text] of sources) {
    const r = scanSource(file, text);
    occ.push(...r.occ);
    if (r.dynamic) dynamicFiles.push(file);
  }
  const nuxtFile = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'].find((f) => sources.has(f));
  if (nuxtFile) for (const n of nuxtConfigNames(sources.get(nuxtFile)!)) occ.push({ ...n, file: nuxtFile });
  for (const [name, files] of examples.names) for (const file of files) occ.push({ name, file, exposed: clientPrefix(name) !== null });
  applyConfigExposure(configExposure(sources), occ, notes, findings);

  if (dynamicFiles.length) {
    notes.push(`Dynamic env access (process.env[someVar]) in ${dynamicFiles.slice(0, 5).join(', ')}: those names cannot be found statically; check them by hand.`);
  }
  noteEdgeFunctionSecrets(occ, notes);
  noteExampleDrift(occ, examples, notes);
  return aggregate(occ);
}

/**
 * Marks names the framework config inlines into the browser as exposed, so mapEnv refuses to fill a
 * server secret into them. Supabase Edge Function reads are not part of the web build and are left alone.
 */
function applyConfigExposure(x: ConfigExposure, occ: Occurrence[], notes: string[], findings: Finding[]): void {
  const web = (o: Occurrence): boolean => !o.file.startsWith('supabase/functions/');
  for (const n of x.names) occ.push({ name: n.name, file: n.file, exposed: true });
  for (const p of x.prefixes) for (const o of occ) if (web(o) && o.name.startsWith(p.prefix)) o.exposed = true;
  if (x.all.length) for (const o of occ) if (web(o)) o.exposed = true;

  const byFile = new Map<string, Set<string>>();
  for (const n of x.names) byFile.set(n.file, (byFile.get(n.file) ?? new Set<string>()).add(n.name));
  for (const [file, set] of [...byFile].sort(([a], [b]) => (a < b ? -1 : 1))) {
    notes.push(`${file} inlines ${[...set].sort().join(', ')} into the browser bundle: treat them as public.`);
  }
  for (const p of x.prefixes) notes.push(`${p.file} ${p.via} makes every name starting with ${p.prefix} public.`);
  for (const u of x.unresolved) notes.push(u + '.');

  if (x.all.length) {
    const exposedSecrets = [...new Set(occ.filter((o) => web(o) && secretLooking(o.name)).map((o) => o.name))].sort();
    findings.push({
      id: 'config-inlines-all-env',
      severity: 'critical',
      title: 'Framework config inlines every env var into the browser',
      evidence: [
        ...x.all.map((a) => `${a.file}: ${a.via}`),
        ...(exposedSecrets.length ? [`server secrets that would ship in the JavaScript bundle: ${exposedSecrets.slice(0, 10).join(', ')}${exposedSecrets.length > 10 ? `, +${exposedSecrets.length - 10} more` : ''}`] : []),
      ],
      fix: 'Remove the whole-env define/spread and inline only the public names you need (e.g. define: { "import.meta.env.VITE_X": JSON.stringify(env.VITE_X) }), or use the framework\'s public prefix. Until then golive will not write any server secret to this app\'s host.',
    });
  }
}

function aggregate(occ: Occurrence[]): EnvRef[] {
  const byName = new Map<string, { files: Set<string>; exposed: boolean }>();
  for (const o of occ) {
    const e = byName.get(o.name) ?? { files: new Set<string>(), exposed: false };
    e.files.add(o.file);
    e.exposed ||= o.exposed;
    byName.set(o.name, e);
  }
  return [...byName.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, e]) => ({ name, files: [...e.files].sort(), clientExposed: e.exposed }));
}

function noteEdgeFunctionSecrets(occ: Occurrence[], notes: string[]): void {
  const fnOnly = new Map<string, boolean>();
  for (const o of occ) {
    const inFn = o.file.startsWith('supabase/functions/');
    fnOnly.set(o.name, (fnOnly.get(o.name) ?? true) && inFn);
  }
  const names = [...fnOnly].filter(([, only]) => only).map(([n]) => n).sort();
  if (names.length) {
    notes.push(`Supabase Edge Functions read ${names.join(', ')}: these belong in Supabase function secrets, not the web host's env.`);
  }
}

function noteExampleDrift(occ: Occurrence[], examples: EnvExamples, notes: string[]): void {
  if (!examples.files.length) return;
  const declared = new Set(examples.names.keys());
  const missing = [...new Set(occ.filter((o) => !examples.files.includes(o.file) && !o.file.startsWith('supabase/functions/')).map((o) => o.name))]
    .filter((n) => !declared.has(n) && n !== 'NODE_ENV')
    .sort();
  if (missing.length) {
    const shown = missing.slice(0, 10).join(', ') + (missing.length > 10 ? `, +${missing.length - 10} more` : '');
    notes.push(`${missing.length} env name(s) used in code are missing from ${examples.files[0]}: ${shown}.`);
  }
}
