# Provider scope

This is the implemented scope of the alpha candidate. Live evidence is separate from adapter
coverage. Detailed agent setup instructions travel with the skill in `skills/golive/references/`.
Built-in adapters use CLI/API transports; users do not need to install provider MCP servers.

## Hosting and database

| Provider | Implemented operations | Limits and evidence |
| --- | --- | --- |
| Vercel | Project selection/creation, env wiring, deployment and supported domain attachment | Vercel + Supabase passed disposable E2E; domain attachment passed separately in the disposable Vercel + Porkbun and Vercel + GoDaddy custom-domain runs. Vercel CLI is required even with token fallback. |
| Netlify | Free-team project selection/creation, env wiring, CLI build/deploy and public-access checks | Netlify + Neon passed disposable E2E. Custom-domain attachment remains guided; project visibility may require an approved UI change. |
| Supabase | Project selection/creation, database output, Auth redirects and read-only access/security checks | Vercel pairing passed with an explicit token. Existing macOS CLI login reuse separately passed read-only checks; fresh-login UX and writes through that credential remain unverified. |
| Neon | Free-organization project selection/creation, Postgres URLs and a read-only connection probe | Netlify pairing passed. No Neon Auth, app migrations, new branches on existing projects or per-target branch creation. |

The two live runs used existing accounts and approved disposable resources. Schema and app-flow
acceptance were separately reviewed work; provisioning does not design or migrate the app's schema.
Cross-pairings have mock coverage, not equivalent live proof. Test resources were removed after
explicit approval; GoLive has no general teardown command.

### Account connection

The usual CLI logins are `vercel login`, `netlify login`, `supabase login` and `neon auth`. The
human completes interactive logins in a separate terminal window. GoLive verifies the selected
account/team/organization and shows the destination before requesting write approval.

If the supported login path needs an API key instead, macOS users can enter it in a native
hidden-input dialog. The local process stores it privately and returns only status metadata to
the agent; the user sees why the key is requested and where it is saved. A private-file editor
flow remains available on other platforms or when the dialog is unavailable. Mac login passwords
belong only in OS/vendor authentication prompts, never in GoLive's API-key dialog.

Supabase native credential reuse currently covers the supported production-profile macOS Keychain
and POSIX private-file formats. Other stores need the explicit token fallback. An explicit token
is not silently replaced with another login after rejection. Netlify verifies that CLI and API
identities match. Neon delegates supported stored-login access to its CLI.

### Framework and access limits

- Neon supplies Postgres connection URLs; it is not a replacement for an app's Supabase SDK or Auth.
- Netlify's current deployment path builds locally. Secret-marked non-development values can be
  masked there. An app needing raw secrets during build needs a separately reviewed remote-build
  flow; GoLive does not weaken secret policy to make the build succeed.
- A private Netlify production URL can need an exact-project visibility handoff. Preserve private
  previews and team defaults. Successful deployment does not imply anonymous access.
- Database connectivity does not prove migrations, user isolation or the deployed app's queries.

## Additional adapters

| Area | Adapter | Scope |
| --- | --- | --- |
| Auth | Supabase Auth | Production Site URL and redirect configuration; not complete signup or email-delivery acceptance |
| Payments | Stripe | Mode-aware key/env wiring and production webhook registration/settings checks; real test payments and signed event delivery still need validation |
| Email | Resend | Sending-domain setup, DNS wiring, key/env wiring and domain-verification checks; inbox delivery and Auth SMTP integration are separate |
| DNS | Cloudflare | Records in an existing authoritative zone; no domain purchase, renewal, transfer or nameserver changes. Live validation pending. |
| DNS | Porkbun, GoDaddy | Same zone-only scope. The Vercel-paired custom-domain journey (attach, approved record writes, ownership verification, HTTPS) passed disposable live runs; other pairings remain open. |

DNS belongs to the authoritative DNS provider, which may differ from the registrar. Domain
registration at GoDaddy or Porkbun alone does not prove the adapter can modify the active zone.
DNS writes require exact-record approval and the additional DNS confirmation gate. Never use a
real production zone as an unreviewed test.

Stripe payment steps require readable account identity, bind it and credential fingerprints to
approval, and check it again before writes. A separate app key must belong to that account.
Account-read denial does not fall back to anonymous webhook-only approval.

## Guided providers

The menu also includes hosting choices such as Cloudflare Workers/Pages, Railway, Render and Fly.io;
databases such as Turso, PlanetScale and Convex; and auth, payment, email and monitoring alternatives.
The conversation also offers **Other**: name a provider even if it is absent from the menu.
Existing dependencies are retained; a hosting choice does not silently replace a Supabase app's
database or Auth. The agent checks compatibility before proposing a path.

Guided means the agent attempts setup using current official documentation. It prefers a suitable
official CLI, can use an available official MCP or API with safe credential handling, and falls back
to step-by-step dashboard guidance. These are capability-based choices, not a requirement to install
every tool or try them all. If no safe documented path is available, the agent explains the blocker
and the next human action. Support and successful deployment are not guaranteed.

External tool operations require a concrete plan and approval for the exact account, project and
changes; the built-in CLI's plan ID does not authorize operations outside that plan. Credentials
must stay out of tool output and chat. When necessary, the human enters them directly into a
destination dashboard without the agent viewing the values.

This path does not add an automated adapter or complete CLI verification. Results distinguish
passing CLI checks, evidence separately verified by the agent, and human-confirmed or unverified
work. Skipped checks remain skipped, and external evidence never rewrites CLI state or reports to
claim a pass. See the skill's `references/guided.md` for the workflow and check limits.

See [VALIDATION.md](VALIDATION.md) for observed live coverage and remaining gaps.
