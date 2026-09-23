import type { Axis } from '../core/types.js';

/**
 * Well-known providers golive doesn't automate (yet). They appear in the menu so the choice stays
 * neutral and wide; picking one means the agent guides the human through it (references/guided.md)
 * and golive still verifies the result from outside. Contributors promote an entry to automated by
 * writing an adapter. Alphabetical within each axis — no ranking.
 */
export interface GuidedProvider {
  id: string;
  title: string;
  axes: Axis[];
}

export const GUIDED: GuidedProvider[] = [
  // hosting
  { id: 'aws-amplify', title: 'AWS Amplify', axes: ['hosting'] },
  { id: 'cloudflare-workers', title: 'Cloudflare Workers / Pages', axes: ['hosting'] },
  { id: 'fly', title: 'Fly.io', axes: ['hosting'] },
  { id: 'gcp-cloud-run', title: 'Google Cloud Run', axes: ['hosting'] },
  { id: 'railway', title: 'Railway', axes: ['hosting', 'db'] },
  { id: 'render', title: 'Render', axes: ['hosting', 'db'] },
  // database
  { id: 'convex', title: 'Convex', axes: ['db'] },
  { id: 'firebase', title: 'Firebase', axes: ['db', 'auth'] },
  { id: 'mongodb', title: 'MongoDB Atlas', axes: ['db'] },
  { id: 'planetscale', title: 'PlanetScale', axes: ['db'] },
  { id: 'turso', title: 'Turso', axes: ['db'] },
  // auth
  { id: 'auth0', title: 'Auth0', axes: ['auth'] },
  { id: 'authjs', title: 'Auth.js (NextAuth)', axes: ['auth'] },
  { id: 'better-auth', title: 'Better Auth (library, no extra account)', axes: ['auth'] },
  { id: 'clerk', title: 'Clerk', axes: ['auth'] },
  { id: 'workos', title: 'WorkOS', axes: ['auth'] },
  // payments
  { id: 'lemonsqueezy', title: 'Lemon Squeezy', axes: ['payments'] },
  { id: 'paddle', title: 'Paddle', axes: ['payments'] },
  { id: 'polar', title: 'Polar', axes: ['payments'] },
  // email
  { id: 'postmark', title: 'Postmark', axes: ['email'] },
  { id: 'sendgrid', title: 'SendGrid', axes: ['email'] },
  { id: 'ses', title: 'Amazon SES', axes: ['email'] },
  // dns
  { id: 'namecheap', title: 'Namecheap', axes: ['dns'] },
  { id: 'vercel-dns', title: 'Vercel DNS', axes: ['dns'] },
  // monitoring
  { id: 'posthog', title: 'PostHog', axes: ['monitoring'] },
  { id: 'sentry', title: 'Sentry', axes: ['monitoring'] },
];
