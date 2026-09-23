/**
 * Where adapters, links and checks are registered. Adding a provider = add an adapter file and list
 * it here; links and checks pick it up through capabilities.
 */
import type { Adapter, Check } from './core/types.js';
import { adapterById as byId, adapterFor, cap } from './core/caps.js';
import type { Link } from './core/plan.js';
import { ADAPTERS } from './adapters/index.js';
import { LINKS } from './links/index.js';
import { CHECKS } from './checks/index.js';

export { ADAPTERS, LINKS, CHECKS, adapterFor, cap };

export function adapterById(id: string, list: Adapter[] = ADAPTERS): Adapter | undefined {
  return byId(id, list);
}


export function checkMap(): Map<string, Check> {
  return new Map(CHECKS.map((c) => [c.id, c]));
}

export function linkList(): Link[] {
  return LINKS;
}
