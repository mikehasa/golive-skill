import type { Check } from '../core/types.js';
import { ALL_CHECKS } from './all.js';

/** Verification checks. Each proves something against live systems (read-only in production). */
export const CHECKS: Check[] = ALL_CHECKS;
