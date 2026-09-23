/**
 * Shared test doubles. Adapters/links/checks are tested against these — never against real
 * provider accounts (that's the nightly canary's job).
 */
import { createCtx } from '../src/core/context.js';
import { memoryStateStore } from '../src/core/state.js';
import { silentLogger } from '../src/core/output.js';
import { Secret } from '../src/core/secret.js';
import type { Adapter, Ctx, DetectResult, Exec, ExecOptions, ExecResult, Http, HttpRequest, HttpResponse, ReleaseIdentity, ShipConfig, ShipState } from '../src/core/types.js';

/** Explicit offline identity; tests never infer a live installation or provider account. */
export const TEST_RELEASE: ReleaseIdentity = { schema: 1, name: 'golive', version: '0.1.0-alpha.1', source: { repository: 'https://github.com/mikehasa/golive-skill', ref: null }, node: '>=20', schemas: { config: 1, state: 1, approval: 1 }, bundleDigest: 'a'.repeat(64) };

export interface ExecCall {
  cmd: string;
  args: string[];
  /** Revealed stdin (tests may assert a secret arrived via stdin). */
  stdin?: string;
  opts?: ExecOptions;
}

/**
 * Scripted exec: handlers are matched in order by `cmd + ' ' + args.join(' ')` (string prefix or
 * RegExp). Unmatched calls fail loudly so tests notice unexpected commands.
 */
export function mockExec(handlers: Array<[string | RegExp, Partial<ExecResult> | ((c: ExecCall) => Partial<ExecResult>)]>) {
  const calls: ExecCall[] = [];
  const run: Exec = async (cmd, args, opts) => {
    const stdin = opts?.stdin instanceof Secret ? opts.stdin.reveal() : opts?.stdin;
    const call: ExecCall = { cmd, args, stdin, opts };
    calls.push(call);
    const line = [cmd, ...args].join(' ');
    for (const [m, r] of handlers) {
      if (typeof m === 'string' ? line.startsWith(m) : m.test(line)) {
        const res = typeof r === 'function' ? r(call) : r;
        return { code: 0, stdout: '', stderr: '', ...res };
      }
    }
    throw new Error(`mockExec: unexpected command: ${line}`);
  };
  return { run, calls };
}

export interface HttpCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON body, or form fields, with Secrets revealed (as they'd be on the wire). */
  body: unknown;
}

type Route = [method: string, url: string | RegExp, respond: (c: HttpCall) => { status?: number; json?: unknown; text?: string }];

/** Scripted HTTP. Unmatched requests fail loudly. */
export function mockHttp(routes: Route[]) {
  const calls: HttpCall[] = [];
  const http: Http = async <T>(req: HttpRequest): Promise<HttpResponse<T>> => {
    const method = req.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v instanceof Secret ? v.reveal() : v;
    const reveal = (v: unknown): unknown => (v instanceof Secret ? v.reveal() : Array.isArray(v) ? v.map(reveal) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reveal(x)])) : v);
    const body = req.form ? reveal(req.form) : reveal(req.body);
    const call: HttpCall = { method, url: req.url, headers, body };
    calls.push(call);
    for (const [m, u, respond] of routes) {
      if (m !== method) continue;
      if (typeof u === 'string' ? req.url === u || req.url.startsWith(u + '?') : u.test(req.url)) {
        const r = respond(call);
        const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : '');
        return { status: r.status ?? 200, headers: {}, json: (r.json ?? (text ? safeJson(text) : undefined)) as T, text };
      }
    }
    throw new Error(`mockHttp: unexpected request: ${method} ${req.url}`);
  };
  return { http, calls };
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export function detectFixture(over: Partial<DetectResult> = {}): DetectResult {
  return { root: '/repo', packageManager: 'pnpm', framework: 'next', providers: {}, envRefs: [], configs: {}, webhooks: [], findings: [], notes: [], ...over };
}

export function testCtx(over: {
  exec?: Exec;
  http?: Http;
  config?: Partial<ShipConfig>;
  state?: ShipState;
  detect?: Partial<DetectResult>;
  tokens?: Record<string, string>;
  cwd?: string;
  adapters?: Adapter[];
  env?: Record<string, string>;
  release?: ReleaseIdentity;
} = {}): Ctx & { logs: string[] } {
  const log = silentLogger();
  const ctx = createCtx({
    cwd: over.cwd ?? '/repo',
    release: over.release ?? TEST_RELEASE,
    exec: over.exec ?? mockExec([]).run,
    http: over.http ?? mockHttp([]).http,
    log,
    config: { version: 1, stack: {}, targets: ['preview', 'production'], ...over.config },
    state: memoryStateStore(over.state),
    detect: detectFixture(over.detect),
    adapters: over.adapters ?? [],
    env: (n) => over.env?.[n],
    envToken: (n) => (over.tokens?.[n] ? new Secret(n, over.tokens[n]!) : undefined),
  });
  return Object.assign(ctx, { logs: log.lines });
}
