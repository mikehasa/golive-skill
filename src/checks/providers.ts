import type { Ctx, Mode, Value } from '../core/types.js';

/**
 * Provider helpers used by checks, imported lazily: adapters may import the registry, which imports
 * the checks, so a static import here could create a cycle. Also gives tests one seam to mock.
 */
export async function restProbe(ctx: Ctx, ref: string, table: string, schema: string, publishableKey: Value): Promise<{ status: number; rows: number }> {
  const { supabaseRestProbe } = await import('../adapters/supabase.js');
  return supabaseRestProbe(ctx, ref, table, schema, publishableKey);
}

export async function accountStatus(ctx: Ctx, mode: Mode): Promise<{ chargesEnabled: boolean; detailsSubmitted: boolean }> {
  const { stripeAccountStatus } = await import('../adapters/stripe.js');
  return stripeAccountStatus(ctx, mode);
}
