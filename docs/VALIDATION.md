# Validation scope

Pre-publication validation snapshot, 2026-09-23, for GoLive `0.1.0-alpha.1`. This is a sanitized summary:
no credentials, account inventories, real resource identifiers or private workspace paths.
The live tests exercised the implementation during development; this is not a claim that every
provider combination, first-time account setup or renamed package has had a live deployment.
Public-channel installation acceptance was recorded later the same day; see
[Post-publication acceptance](#post-publication-acceptance). The two auth legs that snapshot could
not exercise were closed by a 2026-09-24 run, also after publication: it is recorded in the auth row
and in [Findings from the auth-legs run](#findings-from-the-auth-legs-run). The password-recovery
journey and the custom-SMTP write were closed later the same day by a second run on a fresh disposable
project — see the recovery row and [Findings from the password-recovery run](#findings-from-the-password-recovery-run).

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
| Supabase Auth policy and signup journey | One approved `init` run created a disposable Free-organization project through the reused macOS production-profile CLI login — one project, no hosting, domain, payment or email axis. `auth:settings` wrote the policy and re-read it — `password minimum length: 6 → 12`, with the inline `auth:settings:applied` pass confirming it — and `auth-policy` went from a high-severity failure on the provider default to warn/medium with only the built-in-mailer advisory left; `auth:test-user` seeded one account through the project's own signup endpoint (address and user id recorded; the generated password stayed in that run's memory and state's `secrets` stayed empty), the provider accepted a confirmation email for sending (HTTP 200), and the same address could not sign in before confirming (`email_not_confirmed`, observed in two independent runs). After confirmation, one `apply` passed `auth-signup` (probe signup accepted, its confirmation accepted for sending, the unconfirmed probe refused, the seeded account confirmed and signing in) and `auth-session` (the session token resolved through `GET /auth/v1/user` to the same user id; an anonymous request was refused 401); `handoff` and `status` then ran (`status` exit 0, nothing actionable, the project still readable); a later approved run (2026-09-24, after publication) on a fresh disposable fixture — a static site plus an `api/dashboard.js` Vercel function that answers 401 without a session and otherwise validates the token against the project's own `/auth/v1/user`, `auth.protectedPath: /api/dashboard`, the site deployed at `https://<fixture>.vercel.app`, with one RLS-protected table in the exposed `public` schema created through the Management API SQL path (permissive `select` policy for `authenticated`, one row; an anonymous PostgREST read refused 401/42501, the service key reading the row) — closed both app-side legs inside one `apply`: `anonymous GET https://<fixture>.vercel.app/api/dashboard → HTTP 401: protected without a session` and `probed 1 exposed table(s) as the signed-in user: 1 reachable, 0 denied, 0 undecided`; that fixture's first apply warned on `auth-signup`/`auth-session` while its account was unconfirmed, as designed | Confirmation was applied through the **Auth admin API** (`PUT /auth/v1/admin/users/{id}` with `{"email_confirm": true}`) and re-read, not by clicking the seeded account's own email: the human's click landed on a plus-addressed probe account in the same inbox and did confirm that probe one second after the seeded send, so the emailed-link mechanism itself was observed working; the later run confirmed its account the same way, deliberately, and no inbox action was taken. Inbox delivery stays human-confirmed by design — golive never sees the inbox. Both app-side legs were live-exercised: the declared path answered 401 anonymously and the signed-in probe read that one exposed RLS table, so the signed-in probe's bearer fix is no longer mock-covered. Two things that evidence does not show (both addressed afterwards by the change tracked as #30, mock-covered and not re-run live): the table line is a count, not the table names, and the path probe counts any 401/403 — a WAF, edge rule or maintenance page would read the same — so the refusal is not attributed to the app. Cleanup was verified for both disposable projects of that run: the Vercel project through the approved `golive teardown` flow (`teardown:project:hosting:removed` pass; `vercel project inspect` → no such project; the URL 404) and the Supabase project with `supabase projects delete <ref> --yes` (`supabase projects list` has no match; `https://<ref>.supabase.co/auth/v1/user` → 410) — teardown leaves a database project it created to a manual handoff, so that step stays with the human or the provider CLI. A standalone `verify` cannot re-prove the journey without the seeding run's in-memory password (it skips, and the `auth:confirm-email` re-probe was rate-limited); the app-side legs are reachable only inside `plan` + `apply` for the same reason |
| `handoff --write` ownership document | A disposable Vercel-only fixture (one project golive created, one production deployment, no db/auth/payment/email/domain axis) ran `handoff --write`, and both artifacts were written and audited: `GOLIVE_HANDOVER.md` and `.golive/handover.json`. Every claim row outside the Provenance section carried a provenance tag — 4 data rows (accounts, resources, costs, retirement), 0 untagged, checked programmatically — and the same check over `handover.json` found no row missing a valid `provenance.kind`. The created resource named its ownership proof (state's creation marker `vercel.createdProjectId` names the project, `[verified by golive]`), the login route named the CLI login and the team scope being written to, the retirement row named the `golive teardown` → `apply --confirm-destroy` gate, and the document and its JSON twin agreed on `generatedAt`. A credential-pattern scan of the document, its JSON twin, `.golive/state.json` and `golive.yaml` — the repo's own `src/checks/bundle.ts` patterns (Stripe, webhook secret, Supabase, Resend, AWS, PEM, service-role JWT) plus `Bearer `, `sb_`, `vcp_` and a generic ≥24-character run detector — reported no credential-shaped value outside the known-public allowlist: the only long strings were the public release digest, provider ids, the fixture path, the public repo URL and the production URL, and no scanned file contained a literal `sk_`/`re_`/`sb_`/`Bearer `. The project was then removed through the approved teardown flow (`apply --plan <id> --yes --confirm-destroy`, check `teardown:project:hosting:removed` pass) and confirmed gone by independent provider reads: `vercel project inspect` reported no such project, `/v9/projects/…` and `/v13/deployments/…` answered 404, and the project list no longer contained it | The stack is host-only, so the manual/recurring section is the empty-state line (`"manual": 0`, "Nothing is outstanding") — the handoff and recurring rows exist only for other axes. A URL fetch is not deletion evidence: right after the delete the production alias still answered **HTTP 200** from a stale edge entry (`x-vercel-cache: HIT`, `age: 87`) while the provider already reported the project gone; roughly 40 s later (and immediately with `Cache-Control: no-cache`) it returned 404 `DEPLOYMENT_NOT_FOUND`. Three defects this run found in the document — an empty account cell for Vercel, a Netlify check named in a Vercel runbook, and a DNS provenance sentence on a stack with no DNS axis — are fixed with mocked regressions and have not been re-exercised live |
| Production response headers (`site-headers`) | Read-only `verify --only site-headers` against the live deployment of the same disposable Vercel fixture: the check resolved the provider-reported production alias, made one GET of it (`HTTP 200`) and reported **warn / medium** — `strict-transport-security` present, `x-content-type-options`, `content-security-policy`, `referrer-policy`, `permissions-policy` and clickjacking protection absent — with a fix naming the `headers` block of `vercel.json` (or the framework's `next.config` headers) and Netlify's `netlify.toml`/`_headers`. A raw `curl -sSI` at the same instant returned exactly the same headers, so the evidence lines and the verdict matched the deployment | An unconfigured static fixture, so this shows the check reading and reporting a deployment's own response headers — not a configured app passing. The skip and warn branches that protect the verdict from a response that is not the app's own (401/403 behind visitor access, an unfollowed redirect, a non-2xx page) are mocked-only |
| Teardown (approved removal of golive-created resources) | `golive teardown` planned and removed a disposable Vercel project and a disposable Netlify project golive had created and deployed in the same run, plus two GoDaddy and four Porkbun records golive had created, with read-back absence checks on every record: the Netlify site and its URL read 404, the account's site list counted 0 before the run, 1 during it and 0 after, and a second `teardown` planned nothing; separately removed a test-mode Stripe webhook endpoint and revoked two Resend sending keys from recorded state. An apply without `--confirm-destroy` was blocked with nothing deleted — re-checked in the Netlify run, where the project was still present and no teardown had been recorded | Removal covers only resources golive provably created; adopted projects, unowned records and resources of signed-out providers become manual handoffs (Supabase/Neon projects, the Resend sending domain — the Supabase handoff appears even with that CLI's login signed in, see the auth-legs findings); Cloudflare removals and live-mode deletions not exercised |
| Cleanup | Separately approved exact test projects deleted; exact project reads and test URLs returned 404; unaffected scoped resources and login identities stayed unchanged | Normal provider deletion; Neon may retain a recovery window |
| Supabase Auth password recovery and the custom-SMTP write | One approved `apply` on a fresh disposable Supabase project (reused CLI login, `americas`, no hosting axis) with `auth.smtp: resend`, `auth.e2e` and `auth.recovery`. `auth:smtp` wrote the project's custom SMTP and read it back — `SMTP host: (not set) → smtp.resend.com`, `SMTP port: (not set) → 465`, `SMTP user: (not set) → resend`, `sender address: (not set) → auth@mail.trytofu.xyz`, `auth email rate limit: 2 → 30 per hour` — issuing one sending key for SMTP alone (recorded in state as `resend.keyId@smtp` by id and fingerprint only, revoked in that run's teardown); `auth-policy` then read `custom SMTP via Resend (smtp.resend.com)`, sender `auth@mail.trytofu.xyz` and `rate limit: 30 auth emails/hour`. `auth:recovery` rotated the seeded account through the recovery path: the request was accepted for sending (HTTP 200), the admin-minted link was exchanged for a session, the new password was set with it and the replaced password refused. The `auth-recovery` check **passed** all five legs: accepted request, an unknown address answered identically (HTTP 200 both, no account enumeration), the spent token refused on replay (403 `otp_expired`), the new password signing in, the old one refused (`invalid_credentials`), plus the provider's 3600 s OTP window. `auth-signup` and `auth-session` both **passed** in the same apply, after the account read back confirmed | The account's confirmation came through the **Auth admin API** (`PUT /auth/v1/admin/users/{id}` with `{"email_confirm": true}`) exactly as in the earlier auth runs: the owner's click was not used, no inbox was read, and that provenance is what the passing `auth-signup`/`auth-session` legs rest on. Inbox delivery stays human-confirmed by design — golive never sees an inbox, so every HTTP 200 here is provider acceptance, not a delivered message (and the stale-verified finding below makes delivery doubtful on that sending domain). The SMTP password is write-only (the provider answers a hash), so the write is proven for host/port/user/sender and the rate limit only; the step reports the password itself as `not confirmed`, and the one full proof — a real auth email arriving — stays with the human. A standalone `verify` skips `auth-recovery`/`auth-session` because the run vault is process-local (`src/core/secret.ts`), so their pass evidence is the inline one from the apply that carried the rotation. Cleanup verified: the disposable project deleted (`supabase projects list` has no match; its auth endpoint answered 410), the run's Resend SMTP key revoked and absent from the key list, and the owner's real sending domains untouched (`resend domains list` still showed both verified; no DNS record was written or removed anywhere in the run). Two defects this run's output contained are fixed in this PR and the third finding is filed as [#52](https://github.com/mikehasa/golive-skill/issues/52) |

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
  reached; with several exposed tables the same line could not be audited back to one. Addressed in
  #30: the probe now names its tables, schema-qualified and grouped by verdict, capped per line with
  `+N more`. That change is mock-covered; no live run has printed the new line yet.
- **Any 401 counts as "protected".** The protected-path probe sends one anonymous request, carrying
  no marker beyond `user-agent: golive-verify`, and records `protected without a session` for any
  401/403 (`src/checks/auth-session.ts:117-141`). An edge rule, WAF or maintenance page answering
  401 produces identical evidence, so the line proves the route was not publicly readable but cannot
  attribute the refusal to the app. Addressed in #30: the check now corroborates a 401/403 with one
  more anonymous GET of the production root, keeps the pass only when that public route answers
  normally, and reports an origin-wide wall as an **inconclusive** warn instead of protection. That
  change is mock-covered; no live run has made the comparison yet.
- **A full teardown always needs a second, manual step.** `golive teardown` planned and removed this
  run's Vercel project (read back absent, `teardown:project:hosting:removed` pass) but emitted a
  manual handoff for the Supabase project it had also created — with the Supabase CLI login signed
  in — so that project was deleted with `supabase projects delete <ref> --yes` and confirmed gone
  (`supabase projects list` has no match; `https://<ref>.supabase.co/auth/v1/user` → 410). The
  handoff is deliberate: deletion is irreversible and stays the human's call. The cleanup evidence
  for a database project is therefore provider-CLI evidence, not golive's.

## Findings from the password-recovery run

Recorded 2026-09-24, after publication, from a fresh disposable Supabase project whose sending domain
was a subdomain of an existing Porkbun zone, with `auth.smtp: resend`, `auth.e2e` and `auth.recovery`
on. The run's own results were correct — every step it planned completed and the `auth-recovery`
check passed — but two of its outputs contained defects, both fixed in this PR, and it exposed a
provider behaviour filed as [#52](https://github.com/mikehasa/golive-skill/issues/52).

- **A teardown handoff claimed golive created the owner's sending domain (defect, fixed here).** The
  Resend sending-domain spec in the inventory declared `createdBy: []`, and `[].every(...)` is `true`,
  so *every* recorded sending domain read as golive-created — even the one this run only adopted
  (`state` held `resend.domainId` alone, and the run's own log said `adopting existing Resend domain`).
  `teardown` printed "the Resend sending domain … **was created by golive**, and deleting it needs the
  Resend dashboard", and the ownership document reported the same row as `ownership: created` with a
  proof sentence saying state recorded it as a domain golive made: a human following either could have
  deleted a domain that belonged to the account before the run. An empty/absent
  `createdBy` now means "not proven", the Resend spec carries a real creation marker
  (`resend.createdDomainId`, recorded by the email link only when the provider reports that this call
  created the domain), and an adopted resource is reported as recorded-but-not-provable — never offered
  as golive's to delete. The other inventory specs (Supabase `supabase.createdByGolive`, Neon
  `neon.createdProjectId`) were audited and already required a marker that names the exact resource.
  A state file written before this fix records no Resend marker at all, so such a domain now reads as
  adopted too: the claim disappears rather than staying wrong, and nothing is deleted on a guess.
- **A handoff's evidence could read as if the recovery never ran (defect, fixed here).** After the
  rotation, `handoff --json` reported `auth:recovery-email` as `done: null` and used the standalone
  `verify` **skip** text as its evidence — honest about that invocation, but it contradicted the same
  state file, where the `auth:recovery` step is recorded done. A handoff whose check skips now names the
  recorded outcome of the plan step that check verifies (and a failed step's recorded error), so the
  evidence can no longer disagree with `.golive/state.json`. The check itself stays unrunnable in a
  plain `verify`: the token and passwords exist only in the rotating run's memory.
- **Resend's `verified` flag is stale, and nothing corroborates it ([#52](https://github.com/mikehasa/golive-skill/issues/52)).**
  `email:verify` reported `mail.trytofu.xyz: verified` and `email-verified` passed, while the four
  records the provider itself returns were absent from the zone's authoritative nameserver: `dig
  @salvador.ns.porkbun.com` answered the zone wildcard (`pixie.porkbun.com.`) for
  `resend._domainkey`, `send` (TXT and MX) and `rsend` (CNAME), and for a random nonexistent name under
  the domain too — so those records are gone, not cached (contrast "Wildcard caches vs post-write
  checks" below, where the authoritative answer was correct throughout). The earlier phase's `email:dns`
  handoff had reported exactly that, and it disappeared in the next phase because the link stops
  planning DNS work once the domain reads verified. Sends were still accepted, so a shipped app could
  carry a "verified" domain with no SPF/DKIM in DNS and no golive output saying so. Filed, not fixed
  here: the check should corroborate the provider's own record list against public DNS before passing.
- **The flag is corroborated now ([#52](https://github.com/mikehasa/golive-skill/issues/52), fixed after
  this run).** `email-verified` reads the records the provider itself lists for the recorded sending
  domain and resolves exactly those over the repo's DoH path, comparing values the way `email-dns`
  does (TXT equality, a merged SPF that keeps every mechanism the provider needs; MX/CNAME by host). A
  domain the provider still calls `verified` whose records do not resolve **fails**, with a fix naming
  the records and `apply --confirm-dns` as the way to write them; a record golive itself wrote inside
  the 48 h propagation window only **warns** (the window `domain-live` already allows and drift applies
  per record); a provider that cannot list its records, and a lookup that failed, **skip or warn** —
  never a pass. The email link no longer drops the DNS work behind a verified flag: when the provider's
  records do not resolve, the `email:dns` step (or the blocking handoff when golive cannot write DNS)
  stays in the plan, and the step's intent carries the unresolved records so `apply` re-writes them
  instead of skipping a step it recorded done when they matched. Mocked coverage only: no live re-run
  has re-read `mail.trytofu.xyz` or any domain in this state, so what the failing evidence looks like
  live — as opposed to the `email-dns` lines this run did print — remains to be observed.
- **Provenance and limits this run cannot escape.** The confirmation was applied through the Auth admin
  API (`PUT /auth/v1/admin/users/{id}`, `email_confirm: true`) and read back — as in both earlier auth
  runs — so the passing `auth-signup`/`auth-session` legs rest on that provenance, not on the owner's
  click, and no inbox was read. The SMTP password can only be accepted, never read back (the provider
  answers a hash), so the write is proven for the settings and the rate limit; a real auth email
  arriving remains the only full proof, and it stays with a human. A standalone `verify` outside the
  rotating run skips `auth-recovery`/`auth-session` by design (the run vault is a process-local `Map`).

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
- **Empty account cell in the handover document (handoff run):** the login table printed `—` for the
  hosting axis while the same run's plan read had named the team, because `vercelProject.current()`
  returned only `{id, name}`. The project read now reports the owning team/account — the logged-in
  CLI's own team name when it is the same team, otherwise the `GET /v2/teams/{id}` read the creation
  target already makes, cached for the run — and the document prints it in the account column; a
  provider that named none is printed as such instead of a blank cell (mocked; the next live
  `handoff --write` is this fix's first live exercise).
- **Another host's check in the handover runbook (handoff run):** the document told the owner of a
  Vercel app to run `verify --only domain-live,env-parity,netlify-public-access,bundle-secrets`. The
  runbook now asks each registered check's own `applies()` whether it runs on this stack and names
  only those, so a Vercel stack never lists the Netlify visibility check and a Netlify stack still
  does; when nothing applies, the note says whether nothing is registered for that axis or nothing
  applies here (mocked).
- **DNS provenance on a stack with no DNS axis (handoff run):** the Provenance table said the
  "Resources created" rows came from "the DNS provider's owned-record read (this run)" on a fixture
  with no DNS axis, naming a read that never happened. The sentence is now assembled from the rows
  the run actually produced, so it claims a DNS read only when a DNS row carried one (mocked).
- **Stale edge cache vs. deletion proof (handoff run):** immediately after the approved teardown, the
  production alias still answered HTTP 200 from a stale CDN entry (`x-vercel-cache: HIT`, `age: 87`)
  while the provider already reported the project gone, so a URL check would have contradicted the
  deletion. Nothing in the removal path relied on it — the host and DNS steps confirm a removal by
  re-reading the resource at the provider — and the handover's retirement section now states that
  explicitly, so a reader does not take a cached 200 as a surviving resource (mocked).

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
codename remains in their paths or contents. The source-only carriers that audit found — the rename
helper's default old name, its regression fixtures and the CI guard that rejected old runtime names —
have since been given neutral names or removed, so no file in the tree names it now. This remains
local artifact acceptance; the separate public-installation check was run after publication and
passed (see [Post-publication acceptance](#post-publication-acceptance)).

## Still unverified

Live-mode Stripe payments (charges, refunds, entitlements, subscriptions), Resend bounce handling,
inbox delivery for the auth journeys (human-confirmed by design) and the Cloudflare DNS adapter still
need live validation (test-mode checkout →
signed webhook delivery, and a real Resend send → delivery, both passed disposable runs; the Vercel
attachment passed disposable runs with both Porkbun and GoDaddy DNS; Netlify custom-domain
attachment remains guided, and custom-domain redirects and certificate edge cases are not covered).
The custom-SMTP write and the password-recovery rotation are live-validated now — with the write-only
password and the admin-API confirmation limits recorded in their row — but what an auth email actually
delivering looks like is still not, and the stale-verified finding above ([#52](https://github.com/mikehasa/golive-skill/issues/52))
is fixed with mocked coverage: a domain the provider calls verified now fails `email-verified` unless
the records it lists resolve, so a pass means the records are published — which is still not proof
that a message arrives.
Cross-provider pairings beyond the tested paths have mocked integration coverage. The ownership
document is live-validated on a host-only Vercel stack only: its DNS, database, email and payment
rows, its open-handoff rows and its recurring jobs are covered by mocked tests, and the account-column
and runbook repairs made after that run have not been re-exercised live — the ownership-claim and
handoff-evidence repairs made after the recovery run are mocked too. Teardown's later read-back and
state hygiene are mocked as well, with no live teardown since: a removal is confirmed by re-reading the
provider (the webhook endpoint from its own endpoint list, the DNS record from the zone's
golive-owned list, the host project from its own read), a revoked sending key — which no provider read
can re-check — is reported unverified rather than as a pass, a resource a teardown provably removed
loses its recorded baseline, endpoint id or key id so `golive status` reports no drift for golive's
own teardown, and a zone or linked host project the run could not read or remove is named as an
explicit handoff with its reason and its fix. `golive credentials --remove NAME --yes` (one stored
entry deleted, metadata-only result) is mock-covered and has not been run against a real credentials
file. The opt-in promotion and rollback re-points remain implemented and mock-covered, not
live-validated, and Supabase and Neon database projects and the Resend sending domain still expose no
delete capability to golive, so a teardown always hands them back for manual removal. First-time
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
