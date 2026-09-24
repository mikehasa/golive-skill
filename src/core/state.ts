import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReleaseIdentity, ShipState, StateStore } from './types.js';
import { assertReleaseSchemas, validateReleaseIdentity } from './release.js';

export const STATE_FILE = '.golive/state.json';

export function emptyState(): ShipState {
  return { version: 1, resources: {}, secrets: {}, steps: {} };
}

/** Read-only validation: never migrate, clear progress or rewrite evidence to make approval pass. */
export function assertCompatibleState(state: ShipState, release: ReleaseIdentity): void {
  assertReleaseSchemas(release);
  if (state.version !== release.schemas.state) throw new Error(`${STATE_FILE}: incompatible state schema; preserve this file and use a compatible release before generating a new plan.`);
  const identities = [state.release, ...Object.values(state.steps).map((r) => r.release)].filter((r) => r !== undefined);
  for (const prior of identities) {
    validateReleaseIdentity(prior);
    if (prior.name !== release.name || prior.source.repository !== release.source.repository
      || prior.schemas.config !== release.schemas.config || prior.schemas.state !== release.schemas.state || prior.schemas.approval !== release.schemas.approval) {
      throw new Error(`${STATE_FILE}: incompatible release identity or schemas; preserve resource IDs, fingerprints and step evidence. Re-observe with a compatible release before planning; no automatic migration or write replay.`);
    }
  }
}

/**
 * `.golive/state.json` — resource ids, secret FINGERPRINTS, and step progress. Never secret values,
 * so it is safe to commit (and committing it lets teammates / CI resume and verify).
 * Writes are atomic (write temp + rename) so a crash mid-run can't corrupt it.
 */
export function fileStateStore(cwd: string): StateStore {
  const path = join(cwd, STATE_FILE);
  let state: ShipState = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ShipState) : emptyState();
  if (state.version !== 1) throw new Error(`${STATE_FILE}: unsupported version ${String(state.version)}`);
  return {
    get: () => state,
    resource: (k) => state.resources[k],
    save(mutator) {
      const next = structuredClone(state);
      mutator(next);
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
      renameSync(tmp, path);
      state = next;
    },
  };
}

export function memoryStateStore(initial: ShipState = emptyState()): StateStore {
  let state = structuredClone(initial);
  return {
    get: () => state,
    resource: (k) => state.resources[k],
    save(mutator) {
      const next = structuredClone(state);
      mutator(next);
      state = next;
    },
  };
}

/**
 * A view that reads state and drops every write. Read-only commands use it: adapters cache ids they
 * resolve (a zone id, a project ref) through `save`, and a `status` run must leave
 * `.golive/state.json` exactly as it was. A dropped save is only a cache the next read re-derives.
 */
export function readOnlyStateStore(store: StateStore): StateStore {
  return { get: () => store.get(), resource: (k) => store.resource(k), save: () => {} };
}
