# Validation scope

Pre-publication validation snapshot, 2026-09-23, for GoLive `0.1.0-alpha.1`. This is a sanitized summary:
no credentials, account inventories, real resource identifiers or private workspace paths.
The live tests exercised the implementation during development; this is not a claim that every
provider combination, first-time account setup or renamed package has had a live deployment.
Public-channel installation acceptance was recorded later the same day; see
[Post-publication acceptance](#post-publication-acceptance). The two auth legs that snapshot could
not exercise were closed by a 2026-09-24 run, also after publication: it is recorded in the auth row
and in [Findings from the auth-legs run](#findings-from-the-auth-legs-run).

## Observed live results

| Test | Observed result | Limits |
| --- | --- | --- |
| Vercel + Supabase | Approved disposable provisioning, environment wiring, deployment, authenticated CRUD, session restoration and access isolation; 22 strict API checks in the agent-observed retest | Existing Vercel login and explicit Supabase token; preconfirmed synthetic users; no signup/email-delivery proof |
| Netlify + Neon | Approved Free resources, environment wiring, deployment, database connection, separately approved schema, 149 two-session API assertions and real browser CRUD with refresh persistence | Postgres app, without an Auth provider; other frameworks and cross-pairings not live-tested |
| Supabase native CLI credential reuse | Existing macOS production-profile login reused with explicit-token input disabled; profile/projects/organizations returned 200; CLI/API project inventories agreed | Read-only; no fresh browser login, project creation, Auth writes or deployment through that credential |
| Vercel + Porkbun custom domain | Approved disposable Vercel project and a disposable subdomain of an existing Porkbun zone: project creation, production deploy, domain attachment, one approved Porkbun CNAME write under `--confirm-dns`, Vercel ownership verification and HTTPS 200 on the subdomain (final report: 4 pass, 0 fail) | Static fixture without app auth or data flows; attachment is Vercel-only (Netlify stays guided); one adapter fix from this run is mock-covered until its next live exercise |
| Vercel + GoDaddy custom domain | Same approved journey on a second disposable subdomain (existing GoDaddy zone): project creation, deploy, attachment, two approved record writes under `--confirm-dns` (CNAME plus the `_vercel` ownership TXT), ownership verification and HTTPS 200 (final report: 4 pass, 0 fail) | Static fixture; the `_vercel` TXT sits at the zone's `_vercel` name; the update-by-ID path and redirects were not exercised |
| Vercel + GoDaddy (CLI transport) | Same journey on a third disposable subdomain with DNS served by the official `gddy` CLI and the user's own OAuth session: one scope consent, both records created through `gddy api call`, inline read-back, ownership verification and HTTPS 200; the v3 update-by-ID (PUT) endpoint separately validated through the same session (status 200, mutation read back) | Static fixture; golive's owned-record update flows and the REST update-by-ID path remain mock-covered |
| Vercel + Resend email | Disposable project and a subdomain of an existing Porkbun zone: Resend domain created through the CLI transport, DKIM/SPF/MX/return-path records written under `--confirm-dns`, domain verified, two sending-scoped keys issued and written into the app env, and a real send using the app's own environment key delivered to a personal inbox (report: 4 pass, 0 fail, 1 warn) | Fresh subdomain without sending history: the message landed in the recipient provider's spam folder (no DMARC, new reputation); Auth SMTP, bounce handling and richer message content not exercised |
| Vercel + Stripe test payments | Disposable project: restricted operator key plus a standard app key, sandbox identity bound into approval; `STRIPE_SECRET_KEY` written and re-checked in both targets; a test-mode webhook endpoint registered and re-checked via the API; the unsigned probe rejected with 400; a real test-card payment delivered `checkout.session.completed`, signature-verified, HTTP 200 (report: 5 pass, 0 fail) | Test mode (sandbox) only; live-mode keys/charges, entitlements, refunds and subscriptions not exercised |
| Supabase Auth policy and signup journey | One approved `init` run created a disposable Free-organization project (`golive-auth-live`) through the reused macOS production-profile CLI login — one project, no hosting, domain, payment or email axis. `auth:settings` wrote the policy and re-read it — `password minimum length: 6 → 12`, with the inline `auth:settings:applied` pass confirming it — and `auth-policy` went from a high-severity failure on the provider default to warn/medium with only the built-in-mailer advisory left; `auth:test-user` seeded one account through the project's own signup endpoint (address and user id recorded; the generated password stayed in that run's memory and state's `secrets` stayed empty), the provider accepted a confirmation email for sending (HTTP 200), and the same address could not sign in before confirming (`email_not_confirmed`, observed in two independent runs). After confirmation, one `apply` passed `auth-signup` (probe signup accepted, its confirmation accepted for sending, the unconfirmed probe refused, the seeded account confirmed and signing in) and `auth-session` (the session token resolved through `GET /auth/v1/user` to the same user id; an anonymous request was refused 401); `handoff` and `status` then ran (`status` exit 0, nothing actionable, the project still readable); a later approved run (2026-09-24, after publication) on a fresh disposable fixture — a static site plus an `api/dashboard.js` Vercel function that answers 401 without a session and otherwise validates the token against the project's own `/auth/v1/user`, `auth.protectedPath: /api/dashboard`, the site deployed at `https://golive-auth-legs.vercel.app`, with one RLS-protected table in the exposed `public` schema created through the Management API SQL path (permissive `select` policy for `authenticated`, one row; an anonymous PostgREST read refused 401/42501, the service key reading the row) — closed both app-side legs inside one `apply`: `anonymous GET https://golive-auth-legs.vercel.app/api/dashboard → HTTP 401: protected without a session` and `probed 1 exposed table(s) as the signed-in user: 1 reachable, 0 denied, 0 undecided`; that fixture's first apply warned on `auth-signup`/`auth-session` while its account was unconfirmed, as designed | Confirmation was applied through the **Auth admin API** (`PUT /auth/v1/admin/users/{id}` with `{"email_confirm": true}`) and re-read, not by clicking the seeded account's own email: the human's click landed on a plus-addressed probe account in the same inbox and did confirm that probe one second after the seeded send, so the emailed-link mechanism itself was observed working; the later run confirmed its account the same way, deliberately, and no inbox action was taken. Inbox delivery stays human-confirmed by design — golive never sees the inbox. Both app-side legs were live-exercised: the declared path answered 401 anonymously and the signed-in probe read that one exposed RLS table, so the signed-in probe's bearer fix is no longer mock-covered. Two things that evidence does not show (both tracked in #30): the table line is a count, not the table names, and the path probe counts any 401/403 — a WAF, edge rule or maintenance page would read the same — so the refusal is not attributed to the app. Cleanup was verified for both disposable projects of that run: the Vercel project through the approved `golive teardown` flow (`teardown:project:hosting:removed` pass; `vercel project inspect` → no such project; the URL 404) and the Supabase project with `supabase projects delete <ref> --yes` (`supabase projects list` has no match; `https://<ref>.supabase.co/auth/v1/user` → 410) — teardown leaves a database project it created to a manual handoff, so that step stays with the human or the provider CLI. A standalone `verify` cannot re-prove the journey without the seeding run's in-memory password (it skips, and the `auth:confirm-email` re-probe was rate-limited); the app-side legs are reachable only inside `plan` + `apply` for the same reason |
| Teardown (approved removal of golive-created resources) | `golive teardown` planned and removed a disposable Vercel project and a disposable Netlify project golive had created and deployed in the same run, plus two GoDaddy and four Porkbun records golive had created, with read-back absence checks on every record: the Netlify site and its URL read 404, the account's site list counted 0 before the run, 1 during it and 0 after, and a second `teardown` planned nothing; separately removed a test-mode Stripe webhook endpoint and revoked two Resend sending keys from recorded state. An apply without `--confirm-destroy` was blocked with nothing deleted — re-checked in the Netlify run, where the project was still present and no teardown had been recorded | Removal covers only resources golive provably created; adopted projects, unowned records and resources of signed-out providers become manual handoffs (Supabase/Neon projects, the Resend sending domain — the Supabase handoff appears even with that CLI's login signed in, see the auth-legs findings); Cloudflare removals and live-mode deletions not exercised |
| Cleanup | Separately approved exact test projects deleted; exact project reads and test URLs returned 404; unaffected scoped resources and login identities stayed unchanged | Normal provider deletion; Neon may retain a recovery window |

Early cleanup used supervised fixture helpers; later runs removed their disposable resources through
the approved `golive teardown` flow (see the teardown row).
Sample application data was removed before project deletion. No domains were purchased and no live
payment or email resources were created in these runs. The custom-domain run created one DNS record
and one host project on approved disposable resources; their cleanup follows the same supervision
and may trail the run that produced the evidence.

## Findings from the auth-legs run

Recorded 2026-09-24, after publication, from a fresh disposable fixture: a deployed Vercel site with
a guarded function (the declared `auth.protectedPath`) and one RLS-protected table read as the
signed-in user. These are limits of that evidence, not defects: the run's own results were correct.

- **The signed-in table evidence is a count, not a list.** The pass line is
  `probed 1 exposed table(s) as the signed-in user: 1 reachable, 0 denied, 0 undecided`
  (`src/checks/auth-session.ts:196`), so nothing in the report says *which* table the session
  reached; with several exposed tables the same line could not be audited back to one. Tracked in
  #30.
- **Any 401 counts as "protected".** The protected-path probe sends one anonymous request, carrying
  no marker beyond `user-agent: golive-verify`, and records `protected without a session` for any
  401/403 (`src/checks/auth-session.ts:117-141`). An edge rule, WAF or maintenance page answering
  401 produces identical evidence, so the line proves the route was not publicly readable but cannot
  attribute the refusal to the app. Tracked in #30.
- **A full teardown always needs a second, manual step.** `golive teardown` planned and removed this
  run's Vercel project (read back absent, `teardown:project:hosting:removed` pass) but emitted a
  manual handoff for the Supabase project it had also created — with the Supabase CLI login signed
  in — so that project was deleted with `supabase projects delete <ref> --yes` and confirmed gone
  (`supabase projects list` has no match; `https://<ref>.supabase.co/auth/v1/user` → 410). The
  handoff is deliberate: deletion is irreversible and stays the human's call. The cleanup evidence
  for a database project is therefore provider-CLI evidence, not golive's.

## Provider mismatches found and repaired

- **Approval destinations and setup:** show the effective account/team/organization and exact
  project before writes; prepare the credentials directory before handing control to an editor;
  distinguish an empty account from an existing database and a scoped-token denial from logout.
- **Vercel diagnostics:** an auxiliary billing command returned a JSONL parse failure. It was not
  an adapter dependency; dashboard usage established Free quota. Currency figures from that CLI
  diagnostic are not proof of remaining free resource units.
- **Neon CLI stdin:** the installed parser rejected separate `--data -`; `--data=-` retained
  secret-safe stdin and succeeded in the subsequent approved apply.
- **Netlify reads and visibility:** bounded read recovery and fixed diagnostics avoid incorrectly
  treating every CLI failure as logout. Original transient read failure cause was not established.
  A successful deployment initially remained private; an approved project-only UI change made
  production public while keeping previews private. GoLive now detects the gate and presents the
  exact project visibility handoff, without inventing an unsupported API.
- **Detection and reporting:** exclude installed skill internals from app scanning and retain
  the provider's actual remediation for Auth advisories instead of suggesting unrelated RLS changes.
- **Porkbun create response (custom-domain run):** the live `/dns/create` response carried an id
  shape the documented mock does not show, while the record itself was written correctly and resolved
  publicly; the adapter refused to confirm it. It now accepts numeric ids and settles an unparseable
  id by re-reading the zone instead of retrying the non-idempotent POST (mocked; the next live
  exercise comes with a later Porkbun write).
- **Native credential dialogs (custom-domain run):** the first real saves through the macOS
  hidden-input dialog worked for both Porkbun keys, but the two prompts of a key pair looked alike
  and the wrong value was entered once. The dialogs now name the variable in the window title and
  open with a description of the expected value ("Porkbun Secret Key (sk1_…) — not the API Key").
  A mismatched pair surfaces as the provider's deliberately vague `INVALID_API_KEYS_002`, which now
  carries a focused hint.
- **Porkbun ping:** a `SUCCESS` `/ping` without the documented `credentialsValid` field is now
  accepted (the getting-started guide's own example shape); only an explicit `false` refuses.
- **GoDaddy live run:** endpoint shapes, PAT scopes, delegation detection, record-ID parsing and
  value formatting all behaved as mocked. A CNAME value without a trailing dot was accepted (the
  provider's troubleshooting page implies one is required), the `_vercel` ownership TXT Vercel asked
  for after attaching was written and verified, and the follow-up run adopted both records as
  `unchanged`.
- **GoDaddy CLI transport (live run):** the first write failed with HTTP 403 because the cached
  `gddy` session had only read scopes and gddy does not prompt for a scope step-up in a
  non-interactive run; after one `gddy auth login -s domains.dns:update`, both creates and a `PUT`
  update-by-ID succeeded through the same session. The adapter's 403 hint now names that command
  for the CLI transport.
- **Wildcard caches vs post-write checks (email run):** right after the sending records were written,
  both public DoH resolvers answered the zone's catch-all wildcard CNAME for the just-created names
  (cached for the record TTL, ten minutes in this run), so the inline `email-dns` check failed on the
  first apply and passed on a re-run once the caches expired. Authoritative nameservers were correct
  the whole time — a fresh write can legitimately disagree with public checks for minutes.
- **Resend CLI transport (email run):** the tracking-disable follow-up added before the run was
  confirmed live — the created domain's record set contained no tracking records — and the scoped
  sending key read from the app's environment produced a delivered real send.
- **Stripe sandbox flow (payments run):** the blocking handoff for a standard app key worked as
  designed (a restricted operator key is never copied into the app); the sandbox identity and
  operator fingerprint were bound into approval. The live `webhook-unsigned` probe received a 400
  from the fixture and passed, and a real test-card payment delivered a signed
  `checkout.session.completed` event that verified and returned 200 (deployment-log evidence).
- **Vercel CLI DELETE guard (teardown run):** `vercel api` refuses DELETE non-interactively without
  `--dangerously-skip-permissions`; the delete capability now passes it for its already-gated call
  (plan approval, creation marker, `--confirm-destroy`).
- **Cross-release resume (teardown run):** the historical-write block refused to resume a failed
  deletion recorded under an older release. Destroy steps are now exempt — a deletion re-checks
  ownership and is idempotent — with a regression covering both directions.
- **Stale forward state (teardown run):** rebuilding the forward plan can fail when state refers to
  resources a human already removed; `apply --plan <teardown id>` no longer depends on forward
  observation, while the original forward error still surfaces when nothing matches.
- **Silent omissions (teardown run):** recorded webhook endpoints or sending keys that cannot be
  removed right now (e.g. a provider that is not signed in) are now explicit manual handoffs instead
  of silently missing from the inventory.
- **Teardown deploy state (Netlify removal run):** removing a project left its `deployed:production`
  marker and its completed `deploy:production` record behind, so a project created again in the same
  repo would have been planned with no deploy at all. Removal now forgets those deploy facts
  (fixed in #21).
- **Host-project delete read-back (Netlify removal run):** the project-delete step reported success
  from the delete response alone, unlike the DNS steps. It now re-reads the host project and fails
  the step if the project still resolves (fixed in #21).
- **Netlify visitor access (Netlify removal run):** that account's team enforces visitor access
  (`sso_login` on every context), so the disposable project's homepage answered 401 to an anonymous
  request even though the production deployment was provider-confirmed ready. GoLive raised its own
  `netlify-public-access` handoff with the dashboard URL and changed no visibility setting; no public
  200 was observed on this account.
- **Supabase session token scheme (auth run):** golive sent the session token on `Authorization`
  without the `Bearer ` scheme — the scheme existed only in the fallback branch that handles the API
  key — so GoTrue read the request as unauthenticated. Live, a password login succeeded and the very
  next `GET /auth/v1/user` answered 401 `no_authorization` for the token the project had just issued,
  which made an authenticated call indistinguishable from an anonymous one. A controlled read-only
  probe on the same host with the same key pinned the header, not the token, the transport or the
  provider: `Bearer <key>` → 200, bare `<key>` → 401. The mock that claimed to check the bearer shape
  asserted the buggy bare value; it now asserts `Bearer <token>`, and the signed-in table probe
  (`supabaseAuthedProbe`) sent the token bare as well and was repaired in the same audit (fixed in
  #25).
- **Cross-release resume of a write step (auth run):** a write step whose intent changes on every plan
  (its hash embeds the previous attempt time) could never resume after a release change — `apply`
  refused it with "historical step auth:test-user belongs to another or unknown release". Live that
  wedged `auth:test-user` permanently: its write had applied (password rotated, account confirmed by
  the provider) but the step was recorded `failed` by the unrelated defect above, and no later run
  could re-execute it. Destroy steps already had a replay exemption; a step can now declare
  `risk.replayable` when it re-observes the provider and golive's own recorded resource before acting
  and is idempotent, and `auth:test-user` is the only step that opts in (fixed in #27). The drift item
  whose remedy pointed at that refused re-run is still open as #26.
- **Supabase auth email throttle (auth run):** the project's `rate_limit_email_sent: 2` did not behave
  as a clean two-per-rolling-hour bucket: two sends at 05:24:45Z and 05:24:46Z expired at 06:24:45Z,
  yet at 06:26 the provider accepted one send and refused the next 25 seconds later. Treat it as
  roughly one accepted send per window and keep the last slot for the run whose evidence matters.
  Twelve refused probes created no account — a live confirmation that a rate-limited signup creates
  nothing.

Provider fixes have offline mocked regressions. These implementation tests never use real accounts.
The repaired behavior was subsequently exercised where described above; this is not blanket live
coverage for every fallback or error condition.

## Candidate release checks

The candidate includes release identity and complete-bundle validation, approval binding across
versions, ownership-aware installation, explicit update/rollback and optional startup update checks.
Independent review found and fixed two additional guards: a script-only symlink must not validate
another bundle's instructions, and `--only` must not use changed historical prerequisite evidence
to authorize a dependent write. Both were rechecked with isolated offline reproductions.

The renamed candidate passed 1,096 mocked tests on Node 24, TypeScript checking and a tagged
release build. The suite includes local update/rollback, interruption, concurrency, pin, external
manager and user-data preservation cases. Skills CLI installed the complete local candidate for
both Codex and Claude Code. A real npm tarball also installed through the own installer. All three
installed copies matched all 20 manifest file hashes and passed help, version, menu, detect and
offline update-check on Node 20: 15 smoke checks with network and provider subprocesses blocked.
Automatic replacement was off in the owned installation.

Gitleaks 8.30.1 reported zero findings for the source export and installable skill. Five earlier
findings were reviewed as mocked test material and replaced with explicit fake-value construction;
no scanner allowlist was added. The affected 265 tests and the full suite passed afterward.
The export also passed a targeted check for private workspace paths and historical account/resource
identifiers. These checks reduce accidental disclosure risk; they are not a security certification.

These checks prove local installation and runtime behavior; they do not prove native discovery in
a new agent session. Publication is not implied by local acceptance. At the time of this snapshot,
anonymous clone, public Skills CLI installation, hosted CI and public release downloads had not
yet been tested; those checks required the published endpoints. They were run after publication
and passed — see [Post-publication acceptance](#post-publication-acceptance).

## Native credential entry and guided-provider follow-up

The native-entry follow-up passed **1,170 mocked tests / 32 files**, TypeScript checking and build after
adding macOS native token entry and expanding the guided-provider instructions. The 73 native
entry/CLI tests cover metadata-only results, secret-containing errors, cancellation, replacement,
concurrent edits, file/link/ACL protections, exact value preservation and cleanup reporting.
Generated English and Chinese AppleScript dialogs compile on macOS. Independent synthetic
filesystem checks reject inherited granting ACLs even with mode 0600 and accept deny-only defaults.
No real token or password was entered and the actual popup interaction remains untested.

An unknown-provider regression preserves an open guided handoff and confirms no provider login,
process, HTTP or automated write is dispatched. An independent instruction dry-run refused an MCP
result that would reveal a credential and an API operation with unknown cost, while retaining the
existing database and a possible approved dashboard path. This is not live provider coverage.

The latest alpha.1 bundle was repacked and installation acceptance repeated after these changes.
Skills CLI installs for Codex and Claude Code and the npm package's own installer each matched all
20 manifest file hashes and passed the 15 Node 20 runtime smoke checks, with network and provider
subprocesses blocked. All 28 npm package files passed a case-insensitive naming audit: no development
codename remains in their paths or contents. Source-only references are confined to the rename
helper, its regression fixtures and the CI guard that rejects old runtime names. This remains
local artifact acceptance; the separate public-installation check was run after publication and
passed (see [Post-publication acceptance](#post-publication-acceptance)).

## Still unverified

Live-mode Stripe payments (charges, refunds, entitlements, subscriptions), Resend Auth SMTP and
bounce handling, and the Cloudflare DNS adapter still need live validation (test-mode checkout →
signed webhook delivery, and a real Resend send → delivery, both passed disposable runs; the Vercel
attachment passed disposable runs with both Porkbun and GoDaddy DNS; Netlify custom-domain
attachment remains guided, and custom-domain redirects and certificate edge cases are not covered).
Cross-provider pairings beyond the tested paths have mocked integration coverage. First-time
account/login UX, other OS credential stores and framework-specific behavior need further coverage.
A native Linux/Windows keyring path is not claimed by the Supabase reuse implementation; the own
updater's Windows filesystem behavior is not a validated alpha channel.
There is no nightly canary or published cross-agent compatibility matrix. Treat skipped and manual
checks as unverified, and functionally test the application flows that matter to its owner.


## Independent pre-publication review

A separate agent reviewed the source and public documentation, then independently reproduced and
rechecked these repairs with mocked providers:

- Payment approval now binds the Stripe account and operator credential fingerprint, rechecks
  before writes, and verifies a separate app key belongs to that account. Account read denial
  blocks payment planning. Captured credentials keep later cleanup in the approved account.
- Partial verification no longer carries checks forward from an older report. Current reports
  explicitly identify selected/omitted checks and do not claim deployment readiness from checks alone.
- Public HTML/JavaScript scans warn when assets cannot be fetched or bounded scan limits are reached.
  Observed credential patterns still fail; clean partial content is not a complete passing scan.
- Public documentation was rewritten around current behavior, observed evidence and a clearly
  labeled roadmap. Internal research notes are excluded from the public source candidate.

Independent rechecks passed 17 report tests, 15 Stripe approval tests and four bundle-scan cases.
The complete post-review suite passed 1,096 tests in 30 files, followed by TypeScript and build.
These are offline source checks. They do not add live Stripe, email, DNS or new-account evidence.

## Lock recovery follow-up

The current source and renamed candidate pass **1,175 tests / 32 files**, TypeScript checking
and build. Five added regressions cover overlapping lock recovery, old-operation cleanup, empty
locks left by interrupted cleanup, explicit empty-lock recovery and refusal of incompatible
fixed-name lock records. A later updater keeps its lock when an earlier recovery or cleanup resumes;
automatic-update opt-out cannot succeed concurrently and then be overwritten by that updater.
Each operation removes only its unique owner record, followed by nonrecursive empty-directory
cleanup. These are offline filesystem and mocked-update checks, not additional provider coverage.

## Post-publication acceptance

Recorded 2026-09-23 after the repository became public, against tag `v0.1.0-alpha.1`
(commit `cfd5ac79443e95027f4cbbfe68d7fe30ef43fec0`, bundle digest
`a527dd3d36f7969c8d597ec30432a1b949fc12acad4e98b309b34ec204e8382b`). Every run used isolated
temporary homes; no real user skill directory, provider account or credential was touched, and
no cloud writes were made.

| Public channel | Observed result |
| --- | --- |
| Anonymous clone | Exact 20-file inventory and all 20 manifest hashes matched; `help`, `version --json`, `menu --json`, `detect --json` and offline `update-check` passed on Node 20 with network and provider subprocesses blocked |
| Skills CLI install (Codex) | Same inventory, hashes and runtime checks passed |
| Skills CLI install (Claude Code) | Same inventory, hashes and runtime checks passed |
| Own installer, tagged download | Same inventory, hashes and runtime checks passed |
| Online update check | One fixed metadata request; the installed release was reported current; no provider subprocesses |
| Global Skills CLI 1.7.0 installs | Codex and Claude Code installs run from outside any Git repository matched the version, all 20 files and the bundle digest; installed copies are real directories, not symlinks |

Hosted CI on the public repository passed for the [initial commit](https://github.com/mikehasa/golive-skill/actions/runs/35868380318)
and the [latest documentation commit](https://github.com/mikehasa/golive-skill/actions/runs/35928911426).

These results cover public installation and runtime identity only. Everything in
[Still unverified](#still-unverified) remains unverified, skill discovery inside a new agent
session has not been tested, and no end user's own global installation has been confirmed.
