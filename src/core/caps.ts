import type { Adapter, Axis, Capabilities, Ctx } from './types.js';

/**
 * Capability lookup through ctx.adapters. Lives in core (a leaf module) so links and checks can use
 * it without importing registry.ts, which imports them (that would be an import cycle).
 */
export function adapterById(id: string, list: Adapter[]): Adapter | undefined {
  return list.find((a) => a.id === id);
}

/** The adapter chosen for an axis in golive.yaml (undefined if none, or unknown = guided). */
export function adapterFor(ctx: Ctx, axis: Axis): Adapter | undefined {
  const id = ctx.config.stack[axis];
  return id ? adapterById(id, ctx.adapters) : undefined;
}

/** A capability from the adapter chosen for `axis`, if it has it. */
export function cap<K extends keyof Capabilities>(ctx: Ctx, axis: Axis, k: K): Capabilities[K] | undefined {
  return adapterFor(ctx, axis)?.capabilities[k];
}
