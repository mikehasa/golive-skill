import type { Ctx, Mode, Value } from '../core/types.js';
import type { Secret } from '../core/secret.js';

/**
 * Provider helpers used by checks, imported lazily: adapters may import the registry, which imports
 * the checks, so a static import here could create a cycle. Also gives tests one seam to mock.
 */
export async function restProbe(ctx: Ctx, ref: string, table: string, schema: string, publishableKey: Value): Promise<{ status: number; rows: number }> {
  const { supabaseRestProbe } = await import('../adapters/supabase.js');
  return supabaseRestProbe(ctx, ref, table, schema, publishableKey);
}

/** The same probe as `restProbe`, carrying a signed-in user's session token instead of anonymity. */
export async function authedRestProbe(
  ctx: Ctx,
  ref: string,
  table: string,
  schema: string,
  publishableKey: Value,
  accessToken: Secret,
): Promise<{ status: number; rows: number; code?: string }> {
  const { supabaseAuthedProbe } = await import('../adapters/supabase.js');
  return supabaseAuthedProbe(ctx, ref, table, schema, publishableKey, accessToken);
}

export async function accountStatus(ctx: Ctx, mode: Mode): Promise<{ chargesEnabled: boolean; detailsSubmitted: boolean }> {
  const { stripeAccountStatus } = await import('../adapters/stripe.js');
  return stripeAccountStatus(ctx, mode);
}
