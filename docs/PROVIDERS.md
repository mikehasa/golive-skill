# Provider scope

This is the implemented scope of the alpha candidate. Live evidence is separate from adapter
coverage. Detailed agent setup instructions travel with the skill in `skills/golive/references/`.
Built-in adapters use CLI/API transports; users do not need to install provider MCP servers.

## Hosting and database

| Provider | Implemented operations | Limits and evidence |
| --- | --- | --- |
| Vercel | Project selection/creation, env wiring, deployment and supported domain attachment | Vercel + Supabase passed disposable E2E; domain attachment passed separately in the disposable Vercel + Porkbun and Vercel + GoDaddy custom-domain runs. Vercel CLI is required even with token fallback. |
| Netlify | Free-team project selection/creation, env wiring, CLI build/deploy and public-access checks | Netlify + Neon passed disposable E2E. Custom-domain attachment remains guided; project visibility may require an approved UI change. |
| Supabase | Project selection/creation, database output, Auth policy and redirect settings, read-only access/security checks | Vercel pairing passed with an explicit token. Existing macOS CLI login reuse separately passed read-only checks, and the auth validation then created one project and wrote its auth policy through that same reused login (no token, no Keychain prompt); fresh-login UX remains unverified. The Auth policy settings (signup, email confirmation, minimum password length, mailer) passed that disposable live run: the policy write was confirmed by the read-back (`password minimum length: 6 → 12`) and `auth-policy` ended with the built-in-mailer advisory as its only finding. |
| Neon | Free-organization project selection/creation, Postgres URLs and a read-only connection probe | Netlify pairing passed. No Neon Auth, app migrations, new branches on existing projects or per-target branch creation. |

The two live runs used existing accounts and approved disposable resources. Schema and app-flow
acceptance were separately reviewed work; provisioning does not design or migrate the app's schema.
Cross-pairings have mock coverage, not equivalent live proof. Test resources were removed after
explicit approval — earlier runs with supervised fixture helpers, later ones through the approved
`golive teardown` flow.

### Opt-in preview deployments

With `release.preview: true` in `golive.yaml` (and `preview` in `targets`), `plan` also deploys a
preview and gates it: `preview:deploy` records the provider's own deployment identity as
`deployed:preview:id`, and `release:check` re-reads that deployment and scans the bundle it serves
(see [architecture](ARCHITECTURE.md)). **Implemented and mock-covered, not live-validated.** What each
host can confirm differs, and golive reports the difference instead of guessing:

- **Netlify** re-reads the deployment through the deploy API, so `preview-deploy` can confirm it is
  ready, belongs to the linked site and is not the published production deployment. A member-only or
  otherwise protected preview makes `preview-bundle` skip rather than fail.
- **Vercel** exposes no per-deployment read golive could use for this (its CLI/API path reports the
  deployment only at deploy time, and preview URLs are protected by default), so both release checks
  skip with that reason: the preview deploy is supported and its identity recorded, its confirmation is
  left to the human in Vercel's own dashboard or CLI.
- Both hosts deploy the **current working tree**, not a commit; the plan names the branch when local
  `git` can report one.

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
| Auth | Supabase Auth | Production Site URL and redirect configuration, plus the auth policy from golive.yaml; custom SMTP stays a manual dashboard step. The opt-in signup journey (`auth.e2e: true`) adds one approved step that seeds a real test account (`auth:test-user`, `--confirm-live`), the human's click in their inbox (`auth:confirm-email`) and the `auth-signup`/`auth-session` checks (confirmation email, enforced confirmation, session, declared protected path). Live-validated once on a disposable project: the policy write was confirmed by the read-back (`password minimum length: 6 → 12`), and the journey passed `auth-signup` and `auth-session` (probe signup, enforced confirmation, confirmed login, session token accepted, anonymous request refused). The confirmation came through the Auth admin API rather than the seeded email click. A later disposable run with a deployed Vercel fixture exercised both app-side legs: an anonymous GET of the declared protected path answered 401 and the signed-in probe read the project's one exposed RLS table as the authenticated user, so that probe is no longer mock-covered (the table line is a count, not a name; any 401 counts as protected — tracked in #30). Password recovery (`auth.recovery: true`) adds the `auth:recovery` step (`--confirm-live`, rotating that same recorded test account's password through the provider's own recovery calls), the human's inbox click (`auth:recovery-email`) and the `auth-recovery` check (accepted request, an unknown address answered the same way, the spent token refused on replay, the new password signing in and the replaced one refused). **Implemented and mock-covered, not live-validated yet**: its live run comes separately. |
| Payments | Stripe | Test-mode env wiring, webhook registration and signed-event acceptance passed a disposable run; live-mode payments, refunds, entitlements and subscriptions remain open |
| Email | Resend | Sending-domain setup, DNS wiring, scoped-key issuance and a real send through the app's environment key passed a disposable run (delivered; spam folder on a fresh subdomain); Auth SMTP and bounce handling remain open |
| DNS | Cloudflare | Records in an existing authoritative zone; no domain purchase, renewal, transfer or nameserver changes. Live validation pending. |
| DNS | Porkbun, GoDaddy | Same zone-only scope. The Vercel-paired custom-domain journey (attach, approved record writes, ownership verification, HTTPS) passed disposable live runs; other pairings remain open. |

DNS belongs to the authoritative DNS provider, which may differ from the registrar. Domain
registration at GoDaddy or Porkbun alone does not prove the adapter can modify the active zone.
DNS writes require exact-record approval and the additional DNS confirmation gate. Never use a
real production zone as an unreviewed test.

Stripe payment steps require readable account identity, bind it and credential fingerprints to
approval, and check it again before writes. A separate app key must belong to that account.
Account-read denial does not fall back to anonymous webhook-only approval.

Supabase auth settings are written from `auth` in golive.yaml: the `auth:settings` step opens or
closes signup, requires email confirmation and sets the minimum password length, and `auth:redirects`
does the site URL and allowlist. Only settings the endpoint is known to return are read or written,
every write is followed by re-reading them, and a field the provider does not report back is named
as unconfirmed instead of assumed. The `auth-policy` and `auth-redirects` checks carry that evidence.
The opt-in signup journey (`auth.e2e: true` with `auth.testEmail`, and `auth.protectedPath` for an app
route) now exercises the user surface itself: `auth:test-user` creates one real test account through
the project's own signup endpoint (needs `--confirm-live`; the generated password stays in that run's
memory and only the user id and address are recorded), the `auth:confirm-email` handoff leaves the
inbox click with the human, and the `auth-signup`/`auth-session` checks require a confirmation email,
an immediate login refusal for the unconfirmed address, the `email_confirmed_at` of the confirmed
account, a working session, a refused anonymous request and a declared protected path that is not
publicly readable. golive cannot read an inbox, so delivery and the click always stay human-confirmed.
That journey passed a disposable live run: the probe signup and its confirmation request were
accepted, the unconfirmed address was refused a login (`email_not_confirmed`), the seeded account
signed in, its session token resolved back to the same user, and an anonymous request was refused
401. Two limits stay with that evidence: the confirmation was applied through the Auth admin API
(`email_confirm`) rather than the seeded account's own email click — the human's click landed on the
plus-addressed probe in the shared inbox — and that run had no app route or exposed table to probe.
A later disposable run supplied both: a deployed Vercel fixture whose declared `auth.protectedPath`
answered 401 anonymously, and one RLS-protected table the signed-in probe read as the authenticated
user. The provider's auth email throttle and captcha settings can still block the
journey, and the built-in mailer allowed roughly one accepted send per window in that run.

Password recovery (`auth.recovery: true`, after `auth.e2e: true` has seeded the test account) turns
that same account's password over through the provider's own recovery path: the `auth:recovery` step
(`--confirm-live`, only ever on the recorded test account, only once it reads back confirmed) asks the
provider to send a real recovery email, mints the link with the admin API, exchanges the token for a
session and sets the new password with that session — the same calls the app's own recovery page
makes — then stores the new password under the key `auth.e2e` uses, so `auth-signup`/`auth-session`
keep working in the same run. The generated password, the one it replaced and the spent token live in
that run's memory only. `auth-recovery` proves the outcome: the request is accepted for sending, an
address with no account gets the **same** answer (a different answer is account enumeration, a failing
finding), the spent token is refused on replay, the new password signs in and the replaced one is
refused, and the token's window is named from `otpExpirySeconds` when the provider reports it. A 429
only warns — the provider's mail throttle decides what a run can prove — and the inbox click and a
captcha stay human steps (`auth:recovery-email`). This is **implemented and mock-covered, not
live-validated yet**; account isolation is the next slice.

## Guided providers

The menu also includes hosting choices such as Cloudflare Workers/Pages, Railway, Render and Fly.io;
databases such as Turso, PlanetScale and Convex; and auth, payment, email and monitoring alternatives.
The conversation also offers **Other**: name a provider even if it is absent from the menu.
Existing dependencies are retained; a hosting choice does not silently replace a Supabase app's
database or Auth. The agent checks compatibility before proposing a path.

Monitoring is **guided-only on purpose**, not accidentally unfinished: there is no automated adapter
for that axis (Sentry and PostHog are guided menu entries), `plan` has no monitoring step, and the
handover document's monitoring row names no check to run and sends the owner to the provider
dashboard. golive therefore claims no monitoring setup or verification for this alpha; adding one
would mean writing an adapter, not filling a gap in this one.

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
