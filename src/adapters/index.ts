import type { Adapter } from '../core/types.js';
import { vercelAdapter } from './vercel.js';
import { supabaseAdapter } from './supabase.js';
import { stripeAdapter } from './stripe.js';
import { resendAdapter } from './resend.js';
import { cloudflareAdapter } from './cloudflare.js';
import { godaddyAdapter } from './godaddy.js';
import { porkbunAdapter } from './porkbun.js';
import { netlifyAdapter } from './netlify.js';
import { neonAdapter } from './neon.js';

export { GUIDED } from './guided.js';

/** Automated provider adapters. The menu sorts neutrally; this order carries no preference. */
export const ADAPTERS: Adapter[] = [cloudflareAdapter, godaddyAdapter, neonAdapter, netlifyAdapter, porkbunAdapter, resendAdapter, stripeAdapter, supabaseAdapter, vercelAdapter];
