import type { Link } from '../core/plan.js';
import { ALL_LINKS } from './all.js';

/** Cross-provider glue, written once against capabilities. Order = plan order (deps still win). */
export const LINKS: Link[] = ALL_LINKS;
