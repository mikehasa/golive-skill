# Provider scope

This is the implemented scope of the alpha candidate. Live evidence is separate from adapter
coverage. Detailed agent setup instructions travel with the skill in `skills/golive/references/`.
Built-in adapters use CLI/API transports; users do not need to install provider MCP servers.

## Hosting and database

| Provider | Implemented operations | Limits and evidence |
| --- | --- | --- |
| Vercel | Project selection/creation, env wiring, deployment and supported domain attachment | Vercel + Supabase passed disposable E2E; domain attachment passed separately in the disposable Vercel + Porkbun and Vercel + GoDaddy custom-domain runs. Vercel CLI is required even with token fallback. No read of what production serves and no promote/rollback call, so the opt-in promotion and rollback steps are not supported here (see below). |
| Netlify | Free-team project selection/creation, env wiring, CLI build/deploy, public-access checks and (opt-in) production re-points | Netlify + Neon passed disposable E2E. Custom-domain attachment remains guided; project visibility may require an approved UI change. |
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

### Opt-in promotion and rollback

`release.promote: true` (with `release.preview: true`) releases by promotion; `release.rollback: true`
asks for a rollback and needs no preview opt-in. Both are **implemented and mock-covered, not
live-validated**, and both need a host that can re-read what production serves — golive refuses rather
than acting blind. What each host supports, from the code:

| Host | What production serves (read) | Re-point an earlier deployment | Promotion / rollback |
| --- | --- | --- | --- |
| Netlify | Yes: the site read's `published_deploy.id`, re-read through the deploy API over HTTPS (`src/adapters/netlify.ts`) | Yes: `POST /sites/{site_id}/deploys/{deploy_id}/restore`, Netlify's documented "restore deploy (rollback)", through the same HTTPS transport the adapter already writes env with. No rebuild and no env change | Supported: `promote:production` and `release:rollback` re-read the target deployment and production before the write, re-point, then re-read production and record what it serves |
| Vercel | No: the adapter reads project aliases, not which deployment production currently serves (`src/adapters/vercel.ts`) | No call golive has exercised | Not supported: with `release.promote` set, golive plans no promotion and says so — Vercel's preview steps still run. Reviewing or rolling back production stays with Vercel's own dashboard/CLI |

Both hosts deploy what is on disk, so a promotion re-points production at an already-built deployment:
it does not rebuild, and the deployment keeps the env it was built with. A deployment Vercel or Netlify
built from a Git push, a pull request or its dashboard is never a promotion or rollback target; golive
names it as a handoff instead of touching it.

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
| Monitoring | PostHog | The analytics project for this app, its PUBLIC ingestion token and the region's ingestion host written into the host env (`POSTHOG_KEY`/`POSTHOG_HOST`, or the framework's client-prefixed spelling), then the `posthog-ingest` check: one synthetic event, read back through the provider's own HogQL count. **Live-validated in part on 2026-09-30**: on a disposable fixture and the owner's free US-Cloud account, the personal key and its single organization were accepted, a free-plan create was refused live (HTTP 403 `permission_denied`, "maximum limit of allowed projects for your current plan") and mapped to reuse/delete/upgrade with nothing created, the account's existing project was adopted through `projects.monitoring` with a zero-write pin recorded in state and no creation marker, `posthog-ingest` passed twice by reading one synthetic event back through HogQL (22 s and 23 s), and teardown left the adopted project as an explicit manual handoff. Still unverified: the create **and delete** path of a golive-created project, the host env write, the EU region and the app's own event flows. `analytics:project` pins the linked project, selects `projects.monitoring`, or — when nothing is linked or configured — creates one named from the repository (the creation marker records golive's own project, so teardown may delete it: PostHog schedules that deletion and the provider's `is_pending_deletion` read is what confirms it). A free account allows one project, so a refused create is mapped to reuse/delete/upgrade instead of retrying. The app-code half (initialize the SDK) is the non-blocking `analytics:snippet` handoff; the check passes only on the read-back, warns while ingestion has not shown up inside its ~180 s window, and never treats the capture endpoint's 2xx as proof. The `phc_` project token is public by design — it ships in the browser bundle — so golive writes it as a non-sensitive value and `bundle-secrets` treats it like the Supabase anon key. |
| Monitoring | Sentry | The error-tracking project for this app, its PUBLIC DSN written into the host env, and the `sentry-ingest` check. **Implemented and mock-covered, not live-validated yet**: no Sentry account has run this adapter. `sentry:project` pins the linked project, selects `projects.monitoring` (id, slug or name), or — when nothing is linked or configured — creates one named from the repository in the approved team. The token must see exactly one organization; a token that sees several is refused with the list rather than guessed. A create needs a team: with one team golive uses it, with several it creates nothing and the plan carries a handoff naming the teams until `sentry.team: <slug>` in golive.yaml names one. A created project records `sentry.createdProjectId`, so teardown may delete it (the API needs the token's `project:admin` scope, and Sentry deletes asynchronously — `pending_deletion` or a 404 are the confirmations); an adopted project, or one golive cannot reach, becomes a manual handoff naming the Sentry dashboard. `sentry:env:<target>` writes the project's public DSN (client key) non-sensitively — the DSN ships in the browser bundle, like the Supabase anon key, so the bundle scan must not flag it. `sentry-ingest` sends one synthetic event through the project's DSN Store endpoint and reads that exact event back by id through Sentry's own API (`event:read`); the Store 2xx is acceptance, never proof, and a read-back golive cannot read — including a missing scope — warns with the fix instead of failing the app's monitoring. `sentry.region` picks the regional API host (US `us.sentry.io`, EU `de.sentry.io`). The app-code half (initialize the SDK with `SENTRY_DSN` or its client-prefixed spelling) is the non-blocking `sentry:snippet` handoff. Every live path — create/delete, env write, event read-back, both regions — stays mock-covered only. |
| Monitoring | UptimeRobot | The HTTP monitor that watches this app's production URL from outside, and the `uptime-monitor` check. **Implemented and mock-covered, not live-validated yet**: no UptimeRobot account has run this adapter. `uptimerobot:monitor` pins the monitor this repo is linked to, selects `projects.monitoring` (id or friendly name), adopts a monitor that already watches the production URL (or the one named like the repository; a name several monitors carry becomes a handoff naming them, never a guess), or — when nothing matches and a production URL is known (the configured `domain`, or the host's own URL once golive has recorded a production deploy) — creates one named from the repository; with no such URL the link plans nothing and says to deploy (or set `domain`) and re-plan. A created monitor records `uptimerobot.createdMonitorId`, so teardown may delete it and the provider's own monitor read confirms the removal (UptimeRobot deletes at once); an adopted monitor, or one golive cannot reach, becomes a manual handoff naming the UptimeRobot dashboard. The key types are the docs': a **read-only** key is enough for the monitoring reads, a **monitor-specific** key only allows `getMonitors` for its one monitor, and the account's **main** (account-specific) key is what create and delete require — `doctor` names that least privilege. golive sends no `alert_contacts` on create, so the account's own alert-contact rules decide who is notified; it never adds, removes or redirects an alert recipient. `uptime-monitor` is read-only: it passes only when the linked monitor watches the production URL golive names and the provider reports it **up**; paused, not checked yet, seems-down or down (high), or watching another URL, all **warn** with the provider's own status and latest log line (a downtime reason included); an unusable key skips as `blocked by: login:uptimerobot`, no linked monitor as `blocked by: uptimerobot:monitor`, and an unreadable provider or unknown production URL skips rather than failing. There is no app-code half: an external monitor needs no SDK, env or DNS change. Free plans have been observed refusing `newMonitor` with `access_denied` (an independent measurement on 2026-08-16; the v2 docs publish no such limit), mapped to reuse/adopt/upgrade with nothing created. Every live path stays mock-covered only. |
| Auth | Supabase Auth | Production Site URL and redirect configuration, plus the auth policy from golive.yaml. With `auth.smtp: resend` the `auth:smtp` step points the project's auth emails at Resend's SMTP (`smtp.resend.com:465`, user `resend`, the sender `email.from` names), sets the SMTP password to a sending key golive issued (the email journey's key, or one it issues for SMTP alone), and raises the project's own auth email rate limit (`rate_limit_email_sent`, 30 per hour or `auth.emailRateLimitPerHour`) in the same write, because the provider keeps that limit with custom SMTP in place — the write-only field the provider never returns, so the read-back confirms the settings and a real auth email is the only full proof. **Live-validated on 2026-09-24**: an approved apply on a disposable project wrote the custom SMTP and read it back — `smtp.resend.com`, port 465, user `resend`, sender `auth@mail.trytofu.xyz` — together with `auth email rate limit: 2 → 30 per hour`, issuing the SMTP key for that purpose alone and recording it as `resend.keyId@smtp`; `auth-policy` then read `custom SMTP via Resend` with 30 auth emails/hour. What stays unproven is the write-only password itself (the provider answers a hash) and delivery: a real auth email arriving is the only full proof, and this run's sending domain was the subject of [#52](https://github.com/mikehasa/golive-skill/issues/52). The opt-in signup journey (`auth.e2e: true`) adds one approved step that seeds a real test account (`auth:test-user`, `--confirm-live`), the human's click in their inbox (`auth:confirm-email`) and the `auth-signup`/`auth-session` checks (confirmation email, enforced confirmation, session, declared protected path). Live-validated once on a disposable project: the policy write was confirmed by the read-back (`password minimum length: 6 → 12`), and the journey passed `auth-signup` and `auth-session` (probe signup, enforced confirmation, confirmed login, session token accepted, anonymous request refused). The confirmation came through the Auth admin API rather than the seeded email click. A later disposable run with a deployed Vercel fixture exercised both app-side legs: an anonymous GET of the declared protected path answered 401 and the signed-in probe read the project's one exposed RLS table as the authenticated user, so that probe is no longer mock-covered (that run's table line was a count rather than the table's name, and its 401 counted as protection without naming what else could have answered; both evidence texts were fixed afterwards by the change tracked as #30 — the probe names the tables it read and corroborates a refusal against the public root, with mocked coverage and no live re-run yet). Password recovery (`auth.recovery: true`) adds the `auth:recovery` step (`--confirm-live`, rotating that same recorded test account's password through the provider's own recovery calls), the human's inbox click (`auth:recovery-email`) and the `auth-recovery` check (accepted request, an unknown address answered the same way, the spent token refused on replay, the new password signing in and the replaced one refused). **Live-validated on 2026-09-24**: one approved apply carried the SMTP write above and the rotation, and `auth-recovery` passed all five legs against the seeded account — accepted request, an identical answer for an unknown address (no enumeration), the spent token refused on replay (403 `otp_expired`), the new password signing in and the replaced one refused (`invalid_credentials`), with the provider's 3600 s OTP window named. The confirmation came through the Auth admin API, not the owner's click (the same provenance as the journey above); inbox delivery stays human-confirmed by design, so those HTTP 200s are acceptance, not delivery (and see [#52](https://github.com/mikehasa/golive-skill/issues/52) about this run's sending domain). A standalone `verify` still skips `auth-recovery`/`auth-session` (the run vault is process-local), and one wording defect the run exposed — the `auth:recovery-email` handoff printing a skip as its evidence while state recorded the step done — is fixed with mocked coverage. Account isolation (`auth.isolation: true` with `auth.identityPath`/`auth.isolationPath`) adds the `auth:isolation` step (`--confirm-live`, seeding and admin-confirming a SECOND test account, recorded as `supabase.isolationUserId`/`supabase.isolationUserEmail`) and the `auth-isolation` check (two sessions, both declared routes refused anonymously, each account's own id and own marker row and never the other's; an anonymous 200, a crossed id or another account's row fails critical). The app-side contract is the two routes plus the `Authorization: Bearer <token>` session header; when they are not declared, the non-blocking `auth:isolation-routes` handoff carries the app-code task. **Implemented and mock-covered, not live-validated yet**. |
| Payments | Stripe | Test-mode env wiring, webhook registration and signed-event acceptance passed a disposable run; live-mode payments, refunds, entitlements and subscriptions remain open. The read-only `stripe-live-payment` check (the most recent succeeded live PaymentIntent, the live endpoint subscribed to `payment_intent.succeeded`, its delivery event and any refund) is implemented and mock-covered, with no live run yet |
| Email | Resend | Sending-domain setup, DNS wiring, scoped-key issuance and a real send through the app's environment key passed a disposable run (delivered; spam folder on a fresh subdomain); bounce handling remains open, and the `auth:smtp` custom-SMTP write above is live-validated now (settings and rate limit read back; the password is write-only) |
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
captcha stay human steps (`auth:recovery-email`). This is **live-validated on 2026-09-24**: the whole
rotation ran on a disposable project's seeded account and `auth-recovery` passed every leg (accepted
request, identical answer for an address with no account, the spent token refused on replay, the new
password signing in and the replaced one refused). What stays unproven is the human half — delivery to
an inbox and the click — plus the value of the SMTP password in the mailer this journey may run behind
(write-only by provider design), and a standalone `verify` cannot re-run the check because the token
and both passwords live only in the rotating run's memory.

Account isolation (`auth.isolation: true`, with `auth.identityPath` and `auth.isolationPath`) is the
half that needs TWO accounts: the `auth:isolation` step seeds a second one (the address derived from
`auth.testEmail`, `you+gl-isolation@example.com`) with the same signup call `auth:test-user` uses, and
confirms it through `PUT /auth/v1/admin/users/{id}` with `email_confirm` — deliberately not a second
inbox leg, since the journey's subject is the app's data, not delivery — then re-reads it before the
step reports done. Only the user id and the address are recorded; the password lives in that run's
memory under the same per-user key as the first account's. `auth-isolation` then signs in as both and
reads the app's OWN routes on the host-confirmed production URL: both must refuse an anonymous caller
(a 200 is a critical finding), each account's `auth.identityPath` must answer with its own user id and
never the other's, and `auth.isolationPath` must return only the caller's own rows — proven by one
unique marker row the check stores **through that route** with each account's session and then reads
back (an answer carrying the other account's marker is a cross-account read and fails critically).
Both routes are read with the account's session in an `Authorization: Bearer <token>` header, the same
token the app already has. When either route is not declared, the non-blocking `auth:isolation-routes`
handoff hands the app-code task over; a 404, a route that refuses the session, or a rate limit skips
with that task named, never as a pass. It never probes a table anonymously — that stays `rls-probe`'s
job. This is **implemented and mock-covered, not live-validated yet**.

## Guided providers

The menu also includes hosting choices such as Cloudflare Workers/Pages, Railway, Render and Fly.io;
databases such as Turso, PlanetScale and Convex; and auth, payment and email alternatives. Monitoring
is automated for PostHog, Sentry and UptimeRobot (above). The conversation also offers **Other**: name a provider
even if it is absent from the menu.
Existing dependencies are retained; a hosting choice does not silently replace a Supabase app's
database or Auth. The agent checks compatibility before proposing a path.

Monitoring is **implemented for PostHog, and live-validated in part**: the automated adapter links the
app's analytics project (adopting the linked project, else selecting `projects.monitoring`, else
creating one named from the repository), writes the project's **public** ingestion token and the
region's ingestion host into the host env, and leaves the app-code half (initialize the SDK) to the
non-blocking `analytics:snippet` handoff. `posthog-ingest` then proves the wiring from outside: one
synthetic event, read back through PostHog's own HogQL count, passing only on that read-back and
warning — never passing — while ingestion has not appeared inside its ~180 s window. A 2026-09-30 run
on a disposable fixture and the owner's free US-Cloud account closed part of that live: the personal
key and the account's single organization were accepted; a free-plan create was seen refused live
(HTTP 403 `permission_denied`, "maximum limit of allowed projects for your current plan") and mapped
to reuse/delete/upgrade with nothing created; the account's existing project was adopted through
`projects.monitoring` — a zero-write pin recorded in state, no creation marker — and the check
**passed twice**, one `golive_ingest_check` event each read back through HogQL after 22 s and 23 s;
teardown then left the adopted project as an explicit manual handoff naming the dashboard. What that
run could not show, and what stays mock-covered or unverified: the create **and delete** path of a
golive-created project (the free plan's one-project limit blocked the create), the host env write
(that fixture had no host and no mapped env names), the EU region and the app's own event flows (no
app code existed), so `posthog-ingest` proves ingest of one synthetic event, not the app's own
analytics. The `phc_` project token is public by design (it ships in the browser bundle, like the
Supabase anon key), so golive writes it as a non-sensitive value and the bundle scan must not flag it.

Monitoring also **implements Sentry, mock-covered with no live run yet**: `sentry:project` adopts the
project this repo is linked to, selects `projects.monitoring` (id, slug or name), or creates one named
from the repository; the link `sentry:env:<target>` writes the project's **public DSN** into the host
env and the non-blocking `sentry:snippet` handoff carries the app-code half (initialize the SDK).
The token must see exactly one organization — a token that can see several is refused with the list
rather than guessed — and a create needs a team the organization itself makes unambiguous: one team
is used, several without `sentry.team` in golive.yaml become a handoff naming them, never a guess.
`sentry-ingest` proves the wiring from outside: one synthetic event through the project's DSN Store
endpoint, read back by event id through Sentry's own API, passing only on that read-back and
warning — never passing — while the event has not appeared inside its ~180 s window; the Store 2xx is
acceptance, never proof, and a read-back golive cannot read (usually a missing `event:read` scope)
warns with the scope fix instead of failing the app's monitoring. Teardown deletes a project carrying
golive's creation marker through the API — which needs the token's `project:admin` scope — and
confirms the asynchronous deletion with the provider's own read; an adopted project, or one golive
cannot reach, becomes a handoff naming the dashboard. `sentry.region` selects the regional API host
(US `us.sentry.io`, EU `de.sentry.io`); the DSN carries its own ingest host. What is unverified:
every live path. No Sentry account has run this adapter, so the create/delete paths, the host env
write, the Store call, the event read-back and both region hosts are mock-covered only, and the DSN's
public-by-design status means `bundle-secrets` must treat it like the Supabase anon key.

Monitoring also **implements UptimeRobot, mock-covered with no live run yet**: `uptimerobot:monitor`
adopts the monitor this repo is linked to, selects `projects.monitoring` (id or friendly name), adopts
a monitor that already watches the production URL, or the one named like the repository, or creates one
named from the repository for the production URL golive can name — the configured `domain`, or the
host's own URL once golive has recorded a production deploy. With no such URL the link plans nothing
and says to deploy (or set `domain`) and re-plan. A created monitor records
`uptimerobot.createdMonitorId`, so teardown deletes it through the API and the provider's own monitor
read confirms the removal; an adopted monitor, or one golive cannot reach, becomes a handoff naming
the dashboard. The key types are the docs': a read-only key is enough for the monitoring reads, a
monitor-specific key only allows `getMonitors` for its one monitor, and the account's main key is what
create and delete require. golive sends no `alert_contacts` on create — the account's own
alert-contact rules decide who is notified, and golive never adds, removes or redirects a recipient.
`uptime-monitor` is read-only and passes only when the linked monitor watches the production URL and
the provider reports it up; paused, not checked yet, seems-down or down (high) and a different watched
URL all warn with the provider's own status and latest log line, while an unusable login, no linked
monitor, an unreadable provider or an unknown production URL skip rather than fail. There is no
app-code half — an external monitor needs no SDK, env or DNS change. Free plans have been observed
refusing `newMonitor` with `access_denied` (an independent measurement on 2026-08-16; the v2 docs
publish no such limit), mapped to reuse/adopt/upgrade with nothing created. What is unverified: every live path — the account read, the
monitor create **and delete**, the status and log reads, the check's verdicts and the rate-limit
handling are mock-covered only, and the encoded surface is UptimeRobot's v2 API (the vendor marks it
as no longer receiving features while it documents a v3 API).

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
