# GoLive

**Take your agent-built product live: hosting, database, auth, domain, email, payments — on your own accounts. Then hand it over, or tear it all down.**

Your coding agent can build an app in minutes. Getting it to real users still means accounts,
hosting, databases, domains, secrets and connected services. GoLive is the open-source Agent Skill
for that work: it **detects what your app needs, plans the exact changes, asks for your approval,
applies them with your own logins, and verifies what actually works** — then records what it
created, re-checks it for drift on demand, and can remove it again.

Automate the parts providers expose. Guide you through the parts that need a human. Verify what
can be observed, and make unfinished work clear. No GoLive account, hosted backend or product telemetry.

> **Early alpha · 0.1.0-alpha.3**
> Disposable live tests now cover six journeys: **hosting** (Vercel, Netlify), **database**
> (Supabase, Neon), **custom-domain DNS** (Porkbun, GoDaddy), **transactional email** (Resend),
> **test-mode payments** (Stripe) and **Supabase authentication**, plus the `teardown` uninstall
> path. The ownership document and the on-demand `golive status` drift check are implemented
> with test coverage (`golive status` also ran read-only in a live validation), while the broader
> [roadmap](#the-full-go-live-checklist-and-roadmap) is our direction, not a claim that it is all built.

[Install](#install) · [Use GoLive](#use-golive) · [See the workflow](#what-a-run-looks-like) · [Alpha scope](#what-this-alpha-supports) · [Roadmap](#the-full-go-live-checklist-and-roadmap) · [Contribute](CONTRIBUTING.md)

## Install

You need **Node.js 20+**, npm/npx, Git, and a coding agent that can load skills and run commands.
Installation has been checked for Codex and Claude Code; other clients are unverified.

**Install once for all your projects.** Run this from any directory:

```bash
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global
```

Select your agent when prompted: use the arrow keys to move, Space to select, and Enter to
confirm. That screen is waiting for input; installation continues after you confirm.

To skip the agent picker, use the command for your agent:

```bash
# Codex
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global --agent codex --yes

# Claude Code
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global --agent claude-code --yes
```

For installation in just one project, run from that project's repository and omit `--global`.

**Or paste this into your coding agent:**

```text
Install the GoLive skill globally so I can use it across projects:
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global

Target the agent I'm using: add --agent codex --yes for Codex, or
--agent claude-code --yes for Claude Code. Keep --global.
If the agent isn't clear, ask me which one.

Verify the installation with:
node <installed-skill-dir>/scripts/golive.mjs version --json
Tell me if I need to reload skills or start a new session.
Stop after installation; don't connect accounts or deploy yet.
```

The install includes the instructions, provider references and prebuilt runtime. It does not
connect accounts or deploy anything. See [installation and updates](docs/DISTRIBUTION.md) for
noninteractive agent flags, runtime verification and the optional own installer.

### Install from npm

The same skill is published to npm as `golive@0.1.0-alpha.3` (dist-tags `alpha` and `latest`), which
installs it offline, with no Git or Skills CLI involved:

```bash
# Codex
npx golive@alpha install --agent codex

# Claude Code
npx golive@alpha install --agent claude
```

Add `--global` to install into your home directory (`~/.agents/skills/golive` or
`~/.claude/skills/golive`) instead of the current project. The installer copies the complete skill
the package ships with, refuses an existing destination, and never connects provider accounts.

**Both channels carry the same release.** The npm package publishes the version in this repository,
including the standalone installer helpers, so an npm installation is an owned copy that updates in
place. The earlier `0.1.0-alpha.0` snapshot has no updater: remove that copy and reinstall, or use
the GitHub channel, which manages its own installs.
The npm package also exposes the terminal CLI: `npx golive@alpha help`, `version`, `detect`, `menu`,
`plan`, `apply`, `verify`, `handoff` — `apply` needs the approved plan ID and explicit confirmation.
See [installation and updates](docs/DISTRIBUTION.md#alternative-installation-the-npm-package) for
the channel's exact limits.

## Use GoLive

Open your app repository in your coding agent. After installation, reload skills or start a new
session if GoLive does not appear. The skill's name is **`golive`**. For the standalone installation
above, type one of these **in your agent's chat**:

| Agent | Example prompt |
| --- | --- |
| [Codex](https://learn.chatgpt.com/docs/build-skills#how-chatgpt-and-codex-use-skills) | `$golive Help me take this app live.` |
| [Claude Code](https://code.claude.com/docs/en/skills) | `/golive Help me take this app live.` |

You can also ask in plain language:

```text
Use the golive skill to take this app live. Keep the providers it already uses.
Show me the destination accounts and plan before changing anything.
```

GoLive inspects the app, asks about missing providers, and presents the destination accounts and
plan for your approval before making provider changes.

These are chat prompts. `golive skill` is not a command. Installing through `npx skills add` does
not add a `golive` command to your terminal; the agent runs the included CLI from the installed
skill directory. The [npm package](#install-from-npm) can also install the skill offline and exposes
that CLI as `npx golive@alpha <command>`; its terminal commands run individual operations rather
than the conversational skill workflow.

## What a run looks like

An illustrative conversation for an app that already uses Supabase:

> **You:** Use golive to take this app live. Use test resources for now.
>
> **Agent:** This app uses Supabase. Where would you like to host it?
>
> 1. **Vercel** — built-in hosting workflow; live-tested with Supabase.
> 2. **Netlify** — built-in hosting workflow; the live-tested pairing is Netlify + Neon.
> 3. **Other** — tell me your provider; I'll try a guided setup using its official tools and docs.
>
> **You:** Vercel.
>
> **Agent:** We'll keep Supabase. Does this app already have a Supabase project,
> or should we create a new test project?
>
> **You:** Create a new one.
>
> **Agent:** Run `vercel login` and `supabase login` in a separate terminal window.
> I'll check which account and organization are connected when you're done.
>
> **You:** Done.
>
> **Agent:** Here's the plan: create a new test frontend project in your selected Vercel team,
> create its database in your selected Supabase organization, transfer the required environment
> values, and deploy. I'll show the actual destination names and IDs, resource settings and cost
> information with the plan. Approve before I apply it.
>
> **You:** Approved.
>
> **Agent:** The deployment is live. Here is the URL, the verification report, and anything still
> unverified. Next we'll test the app's own signup and data flows. When you're done with this test
> project, `golive teardown` plans its removal for your approval before anything is deleted.

GoLive keeps the provider choices already in your app and asks about missing pieces. You handle
signups, browser logins, identity checks and purchases. If an API key is needed on macOS, a native
hidden-input dialog explains why it is asking and where the key will be saved. Its value goes
directly to the local credentials file, never to chat or command output. Other platforms use your
own editor as a fallback. A later change to the plan needs
another approval; connecting auth or a domain may require a follow-up after the first deploy.

**Using another provider?** The skill has a general guided flow: check the provider's official
CLI, an available official MCP integration or API, then guide you through its dashboard if needed.
The agent still shows the destination, changes and cost before asking for approval, and checks
what it can afterward. This is **best-effort guidance**, with no guarantee of completion or the
same verification coverage as a built-in adapter. If a step cannot be completed or verified,
you get the specific blocker and next action. See [guided provider scope](docs/PROVIDERS.md#guided-providers).

## What this alpha supports

**Two hosting choices: Vercel and Netlify. Two database choices: Supabase and Neon.**

| Live-tested path | What was exercised |
| --- | --- |
| **Vercel + Supabase** | Provisioning, environment wiring, deployment, authenticated CRUD and access isolation |
| **Netlify + Neon** | Provisioning, environment wiring, deployment, Postgres connectivity, two-session API checks and browser CRUD |
| **Vercel + Porkbun (custom domain)** | Domain attachment, an approved DNS record write under `--confirm-dns`, ownership verification and HTTPS serving on a disposable subdomain |
| **Vercel + GoDaddy (custom domain)** | The same journey on a second subdomain, including the ownership TXT challenge Vercel requested after attaching |
| **Vercel + Resend (email)** | Sending-domain setup, DNS records, domain verification and a real send through the app's own environment key (delivered; the fresh subdomain landed in spam) |
| **Vercel + Stripe (test payments)** | Test-mode keys and webhook registration, an unsigned-request rejection, and a real test-card payment delivered as a signature-verified event |

These were approved disposable runs on existing accounts; completed test resources were deleted
afterward, and recent runs' disposable projects and records are cleaned up under the same
supervision. Cross-pairings have mocked coverage, not equivalent live proof. Supabase CLI-login
reuse separately passed read-only verification; the complete deployment test used an explicit
token. A new user's first-account setup and every application framework have not been validated.

The lifecycle commands have their own evidence: `golive teardown` was live-exercised on a disposable
Netlify project (blocked without `--confirm-destroy`, then removed, the account's site list unchanged
apart from it) and earlier runs removed the GoDaddy and Porkbun records golive had written, revoked the
Resend sending keys it had issued and removed the Stripe test-mode endpoint it had registered.
`golive status` ran read-only against a live project; `golive handoff --write` ran on a disposable
Vercel-only fixture: both artifacts were written and audited (a provenance tag on every claim row, the
ownership proof and the teardown gate named, no credential-shaped value in the document, its JSON twin,
state or config), and the project was removed afterwards through the approved teardown flow — the stack
was host-only, so the document's other-provider rows remain mock-covered. See
[observed validation](docs/VALIDATION.md) for the evidence.

Experimental adapters also exist for Supabase Auth configuration, the Supabase Auth signup journey,
its password recovery and account isolation, and Cloudflare DNS. Supabase Auth settings — signup, email confirmation, minimum password length, the
mailer it uses, plus the site URL and redirect allowlist — are automated through an approved plan and
re-read for evidence, and that path passed a disposable live run: the policy write held in the
read-back (`password minimum length: 6 → 12`) and `auth-policy` ended with the built-in-mailer
advisory as its only finding. The opt-in signup journey (`auth.e2e`) passed the same run: one approved
step seeded a real test account (`auth:test-user`, needs `--confirm-live`), the address could not sign
in before confirming (`email_not_confirmed`), and the `auth-signup`/`auth-session` checks proved the
signup email, the enforced confirmation, the confirmed login, the session token and the anonymous
refusal. Two limits stay: the confirmation was applied through the Auth admin API rather than the
seeded account's own email click, and inbox delivery is human-confirmed by design — golive never sees
the inbox. A later approved run on a disposable fixture (a deployed Vercel site whose declared route
answers 401 without a session, plus one RLS-protected table) exercised both app-side legs: an
anonymous GET of `auth.protectedPath` answered 401 and the signed-in probe read that table as the
authenticated user, so the probe's bearer fix is no longer mock-covered. What that evidence cannot
show: that run's table line is a count rather than table names, and any 401 counted as protected — a
WAF or maintenance page would read the same; both were fixed afterwards (issue #30: the probe names
the tables it read, and a refused protected path is corroborated against the public root, with mocked
coverage and no live re-run yet). Password recovery is **implemented
on the same provider and not live-validated yet**: `auth.recovery: true` adds one approved step
(`auth:recovery`, needs `--confirm-live`) that rotates that recorded test account's password through
the provider's own recovery calls — request the email, mint the link with the admin API, exchange it
for a session, set the new password with that session — and the `auth-recovery` check proves the
outcome: the request is accepted, an address with no account gets the same answer (no account
enumeration), the spent token is refused on replay, the new password signs in and the one it replaced
does not. The inbox click and any captcha stay with the human (the `auth:recovery-email` handoff says
so); the live run that exercises it comes separately. Account isolation is implemented on the same
provider too: `auth.isolation: true` with `auth.identityPath` and `auth.isolationPath` adds one
approved step (`auth:isolation`, needs `--confirm-live`) that seeds a
**second** real test account — the address derived from `auth.testEmail`, the password again only in
that run's memory — and confirms it through the provider's admin API (no second inbox click: the
journey is about the app's data, not delivery). The `auth-isolation` check then signs in as both
accounts and reads the app's own two declared routes on the production URL: both must refuse an
anonymous caller (a 200 is a critical finding), each account's identity route must answer with its
own user id and never the other's, and the rows route must return only the caller's own rows —
checked with one unique marker row per account written **through that route** with the account's
session and read back, so another account's marker in the answer is a cross-account read and fails
critically. When the routes are not declared, the non-blocking `auth:isolation-routes` handoff hands
the app-code task over; a 404 or a refused session skips with that task named, never as a pass.
Both are **implemented and mock-covered, not live-validated yet** — their live runs come separately.
The DNS, email and test-mode payment paths listed above are the tested ones, with the custom-domain
runs using Porkbun and GoDaddy record writes; **Cloudflare DNS specifically is not a validated alpha
path yet**, and other auth providers stay guided. See [provider scope](docs/PROVIDERS.md) and
[observed validation](docs/VALIDATION.md).

## The full go-live checklist and roadmap

A working URL is the beginning. Depending on the app, going live can mean all of the following.
**GoLive should work out which items apply, help you finish them, and show evidence for the result.**
A static site should not be asked to set up a database; a paid SaaS should not stop at a deployed homepage.

This is our product roadmap as a launch checklist. Checkmarks and strikethroughs mark **specific
live-tested milestones**, not a finished category or a completed checklist for your app.

**✅ Live-tested** · **🚧 In progress / experimental** (code exists; complete journey pending) · **🗺️ Planned**

### Ship the app

- [x] ✅ **Frontend hosting:** ~~Prove deployment on Vercel and Netlify.~~ Build, deploy and verify
  the intended project on the two tested paths.
- [x] ✅ **Database:** ~~Prove provisioning and connection with Supabase and Neon.~~ The tested
  paths include environment wiring and application CRUD checks.
- [x] ✅ **Environment wiring:** ~~Connect hosting and database credentials on both tested paths.~~
  Broader secret rotation and environment lifecycle management remain planned.
- [ ] 🗺️ **Backend / servers:** dedicated API services, containers, persistent servers, runtime
  configuration and health checks. App routes already deploy through the supported hosts.
- [ ] 🗺️ **Schema and data:** reviewed migrations, safe rollout, environment separation and app
  data checks. These were separately supervised in live tests; a reusable workflow is still planned.
- [ ] 🗺️ **File and object storage:** buckets, uploads, access rules, signed URLs and lifecycle policies.

### Make it a complete product

- [ ] 🚧 **Authentication:** signup, login, sessions, password recovery and account isolation.
  Supabase auth policy (signup, email confirmation, minimum password length, mailer) and the site
  URL/redirect allowlist are written through an approved plan, re-read for evidence and verified
  by the `auth-policy`/`auth-redirects` checks — exercised in an approved disposable run, where the
  policy write held at a twelve-character minimum. The opt-in journey (`auth.e2e: true`) passed the
  same run: the `auth:test-user` step seeded a real test account, that address could not sign in
  before confirming, and the `auth-signup`/`auth-session` checks proved the signup email, the enforced
  confirmation, the confirmed login and the session token — **live-validated for Supabase across
  disposable projects, where the confirmation came through the Auth admin API instead of the seeded
  email click, inbox delivery stayed human-confirmed, and a later run proved a declared protected
  path (an anonymous 401) and a signed-in read of an RLS-protected table, reported as a count rather
  than a table name**. Password recovery is implemented on the same provider and covered by mocked
  tests (`auth.recovery: true` adds the `auth:recovery` step and the `auth-recovery` check, which
  proves no account enumeration, a one-time token and the replaced password); its live run still needs
  work. Account isolation — the other half, and the one earlier runs could not exercise — is
  implemented and mock-covered the same way: `auth.isolation: true` with `auth.identityPath` and
  `auth.isolationPath` adds the `auth:isolation` step (a second real test account, confirmed through
  the provider's admin API and recorded by id and address) and the `auth-isolation` check, which
  signs in as both accounts and proves on the app's own routes that neither can read the other's
  identity or rows (a cross-account read fails critically; an undeclared or 404 route skips with the
  app-code task). Its live run comes separately too. Other auth providers stay guided.
- [ ] 🗺️ **OAuth / social login / SSO:** client registration, consent screens, scopes, callback
  URLs and provider reviews. Current auth-provider setup is guided.
- [x] ✅ **Payments and subscriptions:** ~~Prove test-mode checkout and webhook acceptance with Stripe.~~
  A real test-card payment delivered a signature-verified `checkout.session.completed` event. Live-mode
  readiness, entitlements, refunds and subscription events still need validation.
- [x] ✅ **Transactional email:** ~~Prove sending-domain setup, verification and real delivery with Resend.~~
  A send through the app's own environment key was delivered (to spam on a fresh subdomain, no DMARC yet).
  With `auth.smtp: resend` the `auth:smtp` step also writes the auth project's custom SMTP — Resend's
  host/port/user, the sender the app already uses, and an SMTP password taken from a sending key golive
  issued (the email journey's key, or one it issues for SMTP alone) — and `auth-policy` then reports
  `custom SMTP via Resend` instead of warning about the built-in mailer. The password is write-only (the
  provider answers a hash), so the read-back confirms the settings and a real auth email is the only full
  proof. **Implemented and mock-covered, not live-validated**; bounce handling and richer message content
  still need validation.
- [x] ✅ **Domains / DNS / HTTPS:** ~~Prove domain attachment, DNS wiring and HTTPS serving on host+DNS pairs.~~
  Tested: Vercel attachment with Porkbun and GoDaddy record writes under `--confirm-dns`, ownership
  verification and HTTPS 200 on disposable subdomains. The Cloudflare DNS adapter, redirects and
  further host pairings still need live validation.
- [ ] 🗺️ **SMS and push notifications:** sender registration, credentials, permissions and delivery checks.
- [ ] 🗺️ **Third-party and AI services:** API access, scopes, callbacks, quotas and functional tests.
  Missing environment variables are detected today; service-specific workflows are planned.
- [ ] 🗺️ **Background work:** cron schedules, queues, workers, retries and failed-job recovery.
- [ ] 🗺️ **Cache, search and realtime:** caches, search/vector indexes and realtime services when needed.

### Launch with confidence, then keep it running

- [ ] 🗺️ **Security and abuse controls:** access policies, exposed credentials, security headers,
  rate limits and bot protection. Scoped RLS/advisor and credential-pattern checks exist today.
- [ ] 🗺️ **Monitoring and alerts:** error tracking, logs, uptime and actionable alerts.
  Provider suggestions are guided today; verified setup is planned. On-demand drift checks exist
  (`golive status`, below) — continuous monitoring and alerting do not.
- [ ] 🗺️ **Product analytics:** event validation and consent/data settings, beyond today's guided
  provider suggestions.
- [ ] 🚧 **CI/CD and safe releases:** previews, release checks, promotion, rollback and drift
  detection, building on today's approved CLI deployments. **Deployment identity — implemented, not
  live-validated:** each successful deploy records the provider's own identity for the deployment it
  made (`deployed:<target>:id` = `<provider>|<deployment id>|<url>|<time>` in `.golive/state.json`,
  mock-covered; a provider that reports no identity records none), so a later capability can name one
  exact deployment. **Opt-in preview deploy and release check — implemented, not live-validated:**
  with `release.preview: true` in `golive.yaml` (and `preview` in `targets`), `plan` adds
  `preview:deploy` — a create that deploys the current working tree to the host's preview target,
  names the provider, project, env target and the source project the preview shares with production,
  needs `--confirm-live` when a live-mode value fills a preview env name, and records the provider's
  own identity as `deployed:preview:id` — and `release:check`, which writes nothing, declares
  `preview:deploy` as its prerequisite, and fails the plan when the provider's read of that deployment
  or a credential scan of its bundle fails. In a cut plan that check is the last step, so what it gates
  is the promotion (whose own plan re-runs the check before production changes), not a production
  deploy the plan emits before it. **Promotion
  and rollback — implemented, not live-validated:** with `release.promote: true` (on top of the
  preview opt-in) a plan asks for a release by promotion, and with `release.rollback: true` it asks to
  re-point production at an earlier deployment golive itself created and recorded. `promote:production`
  names the exact deployment id it would make production — the provider reports a deployment's id only
  once the deployment exists, so cutting the candidate and promoting it are two plans and the preview
  says which one it is — is gated by `release:check` re-reading that deployment in the same plan, and
  needs **no extra confirmation flag**: the plan id, the named deployment and the fresh gate are the
  approval. Both steps re-read the target deployment and what production serves before writing and
  prove what production serves afterwards; both keep the cross-release stop (neither is `replayable`
  nor a deletion), and neither is automatic — no failed check triggers a rollback, and a deployment
  built by a dashboard, a Git push or a pull request is never a promotion or rollback target (it is a
  handoff, named as such). What each host supports differs, and golive refuses rather than guessing:
  Netlify re-reads its published deployment and can restore an earlier one, so both steps work there;
  Vercel exposes no read of what production serves and no promote/rollback call golive has exercised,
  so on Vercel nothing is promoted or rolled back and a warning says why. `production-release` proves
  what production serves, names what it served before, and reports a deployment golive never recorded
  as a handoff. Adding these step ids changes a plan's id, so an approval that was not applied must be
  re-planned. The preview checks (and therefore promotion) skip on a host that exposes no
  per-deployment read (Vercel), reporting that instead of guessing. Drift detection
  exists as the read-only `golive status` command below (it ran read-only in the auth validation and
  had nothing actionable once that journey passed, but the DNS, environment, webhook and deployment
  baselines it compares still lack live evidence), and preview deployments are not yet among the
  subjects it compares.
- [ ] 🗺️ **Backups and recovery:** retention, restore drills, incident steps and approved cleanup.
  Approved `teardown` removes what golive created; backups and any restore remain manual, supervised work.
- [x] ✅ **Uninstall / teardown:** ~~an approved inventory of golive-created resources and their removal.~~
  `golive teardown` plans the removal, deletes only what golive provably created (ownership proofs and
  `--confirm-destroy`), confirms DNS records are gone by re-reading the zone, and hands back
  everything else. Supabase/Neon projects and the Resend sending domain remain manual handoffs
  ([#9](https://github.com/mikehasa/golive-skill/issues/9)).
- [ ] 🗺️ **Costs and quotas:** plan choices, budgets, alerts and capacity checks.
  Scoped Free-plan guards exist today; ongoing cost management is planned.
- [ ] 🗺️ **Launch essentials:** metadata, share previews, indexing, accessibility, support links
  and owner-reviewed policy pages.
- [ ] 🚧 **Ownership and handover:** accounts, resources, access, renewal responsibilities and
  maintenance instructions. `golive handoff --write` records the login route, ownership proofs,
  recurring jobs and removal gates in `GOLIVE_HANDOVER.md`, tagging every row as verified, recorded,
  not verifiable or unknown, and `golive status` re-reads those subjects on demand: it compares the
  baselines golive recorded with the providers as they are now, and names what it could not read.
  Drift re-baselining stays manual and approved — the command is implemented and ran read-only in the
  auth validation, but a live validation of every drift subject is still pending.

Some steps will always need a person: accepting terms, identity verification, purchases, billing
choices and reviews that a provider requires. “Guided” should still mean a clear next action,
the right page, the right permissions, a check afterward, and a return to the same workflow.
When the app itself needs code changes, GoLive should give the coding agent a concrete task and
recheck the result. It should not make you coordinate a dozen disconnected setup conversations.

**Next up:** complete and live-test the remaining launch journeys—the live runs for password recovery
and account isolation (both implemented and mock-covered on Supabase, not yet exercised against a real
project), live-mode payment flows and the Cloudflare DNS adapter—then expand app architectures and
ongoing operations.

These are directions, not release dates. A capability should graduate from experimental only after
its account setup, connection, verification and recovery have been exercised. Contributions toward
any part of this checklist are welcome, especially evidence of where a real launch gets stuck.

<details>
<summary>Production checklists informing this roadmap</summary>

The scope draws on [Vercel's launch checklist](https://vercel.com/docs/production-checklist),
[Supabase's production checklist](https://supabase.com/docs/guides/deployment/going-into-prod),
[Stripe's go-live checklist](https://docs.stripe.com/get-started/checklist/go-live),
[Google's OAuth production guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)
and [Next.js production guidance](https://nextjs.org/docs/pages/guides/production-checklist).
These inform the goals above; they are not GoLive features or blanket requirements for every app.

</details>

## Verification you can inspect

The report records **pass, fail, warning and skipped** results, along with remaining human steps.
Checks include account access, environment-variable names, provider-confirmed deployment URLs, public
JavaScript secret patterns, database access, supported auth/webhook/DNS settings, and (where the host
can answer it) the deployment the provider says production serves.

A ready deployment is not proof that the app works. An environment-variable name can exist with
a wrong value. A verified email domain does not prove inbox delivery. Signed payment events,
signup and the app's business flows need functional tests. **Skipped is not passed.**

Your app gets `golive.yaml`, `.golive/state.json`, `.golive/report.json` and `GOLIVE_REPORT.md`.
State preserves resource IDs and step evidence for recovery; it is not a credential store.
`golive teardown` removes what golive created after its own approval and `--confirm-destroy`;
there is no cross-provider rollback, restore or general reconciliation command for those resources —
`release:rollback` (opt-in) only re-points production at an earlier deployment golive itself recorded,
and touches no data, DNS, payment or email resource.

`golive handoff --write` adds the ownership document: `GOLIVE_HANDOVER.md` at the repo root and its
JSON source in `.golive/handover.json`. It names the accounts and login route, every resource golive
created and the proof it is golive's, what is still manual, what recurs, how removal works, and which
commands re-check each subject. Each row says whether it was verified in that run, recorded earlier,
not verifiable by golive or unknown; golive read no billing data, so no cost figure is stated. The
files contain no secret values, but secret-free metadata can still identify private resources —
review them before sharing. `--write` never overwrites a file golive did not generate unless
`--force` is passed.

`golive status` asks the follow-up question: has anything changed behind golive's back since it
recorded what it did? It compares recorded baselines — the DNS records golive wrote, the environment
variable **names** it delivered, the registered webhook endpoint, the domain attachment, the database
project and its connection selectors, the sending domain, the payment account behind the app's keys,
the host project — with reads taken now, and labels both sides: `expected (recorded by golive <time>)`
against `observed (read now)`. Each item says who can act: re-run a check, re-plan and apply an
approved change, or a decision only a human can make. It is read-only: no report file, no provider
write, no state change, and it exits with `2` when something needs acting on. A provider it cannot read
is reported as unverifiable — never as clean, and never as a failure — and it never re-baselines
anything by itself. Drift is deliberately not a gate: `plan`, `apply` and `verify` never consult it.
`status` is **implemented**, and it ran read-only during the Supabase auth validation (a failed step
surfaced as actionable, then an empty list once it completed), but a live validation of the remaining
drift subjects is still pending.

## Credentials and control

- **Approve before account changes.** Plans name the destinations and intended writes. Changing
  the installed release invalidates old approvals. DNS, live-payment and deletion steps have extra
  gates (`--confirm-dns`, `--confirm-live`, `--confirm-destroy`).
- **Keep secrets out of chat.** Supported vendor logins are reused. On macOS, a native hidden-input
  dialog can save a needed API key; your own editor is the fallback. Keys live in
  `~/.config/golive/credentials`, a local plaintext file with restricted POSIX permissions.
  The execution code keeps values out of plans, state and command output. Mac login passwords stay
  with macOS/vendor authentication prompts; GoLive never asks you to enter one in its key dialog.
- **Updates have an owner.** Skills CLI manages its installs. The optional own installer supports
  whole-bundle updates and local rollback; automatic replacement is off by default. Update between
  deployment runs, never between a plan and its apply. Cloud resources are unaffected by rollback.
- **Your accounts remain yours.** GoLive does not buy services or create billing accounts.
  Your coding agent, providers and installer have their own data practices.

## Contribute

🤝 **We're early, and we'd love your help shaping GoLive.** Bug reports, feature ideas, docs fixes
and pull requests are all welcome. You don't need to build an adapter to contribute: an unclear
login instruction or a real launch that got stuck is useful feedback too.

Open an issue to report a problem or discuss an idea, or send a focused PR. For a larger provider
or workflow addition, consider starting an issue so we can agree on the scope together. Never include secrets
or raw authentication responses in a report.

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for local setup, tests and your first contribution.
The [architecture](docs/ARCHITECTURE.md), [provider scope](docs/PROVIDERS.md) and
[validation record](docs/VALIDATION.md) explain what exists and where help is needed.

[MIT licensed](LICENSE). Bundled third-party notices are included in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
