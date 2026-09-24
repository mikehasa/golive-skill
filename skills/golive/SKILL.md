---
name: golive
description: Take an agent-written app from repo to live production on the user's OWN accounts, with providers they choose (hosting, database, auth, payments, email, domain/DNS). The human connects accounts and approves changes; supported wiring operations run through a local CLI and produce verification evidence with explicit limits. Use when the user wants to ship, deploy, go live, launch, publish, or put their app online, or asks to wire up env vars, webhooks, auth settings (signup, email confirmation, password policy), a real signup → confirmation email → login journey, password recovery, account isolation between two users, auth redirects, email DNS or a custom domain.
---

# golive: ship this app to production, on the user's own accounts

Help the agent take an app live on accounts the human owns. The `golive` script handles supported
provider operations after approval and records what its checks establish. The human connects
accounts and handles purchases; app migrations, business flows and guided steps need their own
review. Never turn an infrastructure check into a claim that the entire app works.

```bash
node <this-skill-dir>/scripts/golive.mjs <command> --json
```

`<this-skill-dir>` is the folder containing this SKILL.md. Every command prints one JSON document.
Exit code `2` means "worked, but something needs attention": read the JSON.

## Start with a verified release

At the start of a new deployment run, run `version --json` and `update-check --json` using the
script above. The runtime verifies the complete instruction/reference/script bundle before
accessing accounts. Update checking reads only public metadata, is cached and bounded, and an
offline/unavailable result does not block the deployment flow. `GOLIVE_UPDATE_CHECK=0` disables it.
Read `references/updates.md` for installation ownership, explicit updates, rollback and opt-in
automatic replacement. Automatic replacement is off by default and only runs between deployment
runs for copies owned by our installer. Skills CLI and plugin copies stay with their managers.
Never update between a plan and its apply. A changed release requires a new plan and human approval.

## Conversation and progress

- Follow the human's language: English for English, Chinese for Chinese, mixed when they mix.
  These English instructions do not fix the language of the conversation.
- Keep the current stage visible at handoffs: **completed / next step / what you need from them**.
  If they ask "what's next?", read the existing `golive.yaml`, non-secret `.golive/state.json`, and
  latest golive plan/result first. Resume the current stage; don't restart onboarding or treat a
  question as approval. Credentials, `.env`, and vendor login files are never context to read.
- Name agent-written deployment docs `docs/GOLIVE-<stage>-PLAN.md` and
  `docs/GOLIVE-<stage>-RESULT.md`; link them in chat. The CLI's final report is `GOLIVE_REPORT.md`.
  Preserve older artifacts as evidence and say which current document supersedes them.
- Use bundled provider references for the normal flow. Check current official docs for changing
  permissions, CLI versions, pricing, or an actual mismatch, and explain that purpose briefly.
  Reuse facts already verified in this session unless new evidence changes them. Don't describe
  ordinary onboarding as open-ended "researching the deployment plan" or claim no web lookup is needed.

## Hard rules (never break these)

1. **Never print, echo, `cat`, or paste a secret value** (`.env` files, API keys, tokens, database
   URLs, `~/.config/golive/credentials`). Refer to secrets by name. The script never prints them.
2. **Secrets never go through this chat.** Never ask the human to paste a secret key or token here.
   Prefer provider integrations or supported local secret transport. When guided setup has no safe
   automated route, the human may enter a needed value directly in the destination dashboard using
   their own browser; the agent must not view or capture it. If they paste one into chat anyway,
   don't use it; tell them it is now in the transcript and should be rotated. The one exception:
   Stripe **publishable** keys (`pk_test_…`, `pk_live_…`) are public, so the human may give them in
   chat. Never `sk_`, `rk_` or `whsec_`.
3. **No provider/account writes until the human approves the plan.** Local credential setup and
   human-submitted credential entry, `init`, and report files can be prepared during onboarding. Explain `plan` and get a
   clear yes before `apply`. Pass `--confirm-live` (live payments **or production data**, e.g. the
   `auth:test-user` account, the `auth:isolation` second account, `auth-signup`'s throwaway probe and
   the `auth:recovery` password rotation), `--confirm-dns` (DNS records) or
   `--confirm-destroy` (deletions) only if the human explicitly approved those categories.
4. **Never buy anything or create accounts for them.** Signups, payment methods, identity checks
   (KYC) and domain purchases are handoffs the human does in their browser.
5. **A handoff is closed only by a passing check**, not by anyone saying "done". `done: false` is
   open. `done: null` (a `manual` item, or its check skipped) cannot be verified by golive: confirm it
   with the human and name it as **not verified by golive** in your final summary. A skipped check's
   evidence names the recorded outcome of the step it verifies when state has one, so a `done: null`
   item never contradicts `.golive/state.json`: if the evidence says the step is recorded done, the
   work ran and only this invocation could not re-check it — say that, not that it is unproven.
6. **Stay neutral.** Present provider options without steering. If they already use something, keep it.

## How the human connects accounts

golive runs in *your* shell, so a token the human `export`s in their own terminal never reaches it.
In order of preference:
1. **The vendor's browser login, when the adapter supports the required operations**
   (`vercel login`, `supabase login`, `resend login`). The human runs
   it in a **separate terminal window** (the Terminal app or their IDE's terminal), not with Claude
   Code's `!` prefix: `!` runs commands without a terminal (no TTY, stdin is `/dev/null`), so these
   interactive logins fail or hang there. A real user-controlled terminal can be opened for them
   when the host supports it; the human completes the login. Check the CLI is on PATH after install.
   A working CLI login does not prove golive's fallback implements every required operation.
   Nothing is copied. Never suggest a `--token` / `--key` login flag, even when a CLI's error hint
   does: it puts the secret on the command line (and, with `!`, into this chat).
   If macOS Keychain or the vendor login requests system authentication, explain which app is
   requesting access and why; the human responds to that system-controlled prompt. Never collect
   their Mac login password yourself or imitate an OS authorization prompt.
2. **Native token entry on macOS, when a manual API key is actually needed.** Give the exact
   variable name, provider token page, scope and permissions first. Explain that a GoLive input
   dialog will mask the value and the local process will save it without returning it to agent chat
   or command output. Then run `credentials --prompt NAME --lang en --json` (use `zh` when appropriate).
   Pass only the variable name, never its value. The human types or pastes directly into the native
   dialog. Do not inspect the dialog, clipboard, credential file or raw child output to retrieve it.
   This is local API-key entry, not a request for their Mac password. Storage remains the private
   plaintext credentials file, not Keychain. The dialog states the path and purpose.
   `saved` means local storage succeeded; rerun the provider check to validate access. If a named
   entry already exists, confirm it is the intended one to replace before using `--replace`.
   If `cleanupRequired` is true, treat a saved key as saved and repair only local cleanup; do not
   prompt for it again or retry replacement. See `references/troubleshooting.md` for the recovery.
   A cancellation means stop and wait; do not reopen the prompt or switch entry methods unasked.
   If `envOverride` is true, explain the existing process environment takes precedence; do not
   print its value or repeatedly replace the file entry. Use the manual fallback only when the
   platform/dialog is unavailable or the human prefers it, and explain the reason. Filesystem or
   concurrent-change failures need repair first; follow `references/troubleshooting.md`.
3. **Manual fallback: the credentials file** `~/.config/golive/credentials` (path shown by `doctor`).
   First run `credentials --setup --json` yourself: it creates a private empty file and missing
   directories, preserves existing contents, and returns metadata only. Never inspect those contents.
   Give the human the exact variable name, token page, resource scope and permissions for this stage
   before they open their own editor and add `NAME=value`. If suggesting nano, always spell out
   **Ctrl+O → Enter → Ctrl+X** (save, confirm filename, exit). The agent never enters token values.
   On Windows the setup command reports privacy as unknown; don't claim POSIX modes verify Windows ACLs.
4. The token exported in the shell the agent is launched from (then restart the agent).

Vercel deploys always run through the Vercel CLI, so it must be installed (`npm i -g vercel`) either
way; `VERCEL_TOKEN` only replaces `vercel login`. Use `doctor`'s `howToFix` to preserve the correct
login, variable and permissions, but present only the applicable entry method in the human's language;
do not recite editor setup when the native prompt is available. A login it
shows as `! <cmd>` goes in a separate terminal window too. Supabase can reuse a supported CLI
production-profile login for the complete Management API flow, including new projects and Auth
settings: read `references/supabase.md` for the CLI version and OS credential-store limits. An
explicit `SUPABASE_ACCESS_TOKEN` still takes precedence; a rejected explicit token never silently
switches accounts through CLI fallback. Request a manual token only when needed by the supported
credential path, and explain why. Do not make users do both login and token setup unnecessarily.

Netlify can reuse `netlify login` for deployment and API env wiring; Neon can reuse `neon auth`
through its CLI API transport. Read `references/netlify.md` / `references/neon.md` when selected.
Do not require MCP installation: these adapters use vendor CLI/API paths. Netlify + Neon passed a
supervised throwaway live run covering provisioning, env wiring, deployment and DB connectivity,
plus separately approved schema/API/browser acceptance. This does not validate every framework,
pairing or an Auth provider; explain the applicable limits when presenting the stack.

## Troubleshoot, then resume

When a setup command fails, help resolve that specific failure before continuing. Keep the app
directory, chosen stack, approved plan and completed resource IDs; onboarding does not restart.
An install success is not proof that the user's terminal or the agent can find the executable.
For `command not found`, installation/PATH/version differences, failed login or an interrupted
provider operation, read `references/troubleshooting.md`. Use narrow diagnostics that cannot expose
credentials, verify the repair with the appropriate CLI/account check, and return to the same
deployment stage. Explain **what failed / what now passes / the next deployment step**. A repaired
command does not authorize new destinations, paid operations or a changed plan.

## Flow

### 1. Detect: `detect --json`
Tell the human the framework, the providers the code already uses, and the env var *names* it
expects. Fix every **critical** finding in the code first (e.g. `secret-in-client-env`: a server
secret in a browser-exposed name; `config-inlines-all-env`: the framework config inlines every env
var into the browser). Until they are gone, golive won't write server secrets to that app's host.
Read `notes` too (webhook events not found, a `define` golive couldn't resolve, …).

### 2. Choose providers: `menu --json`, then `init`
Ask only about pieces the app **needs and doesn't have yet**. List what's already in the repo
first and preserve those choices unless the human requests a change. Offer compatible providers,
mark "automated" vs "guided", and include **Other — tell me the provider (guided, best effort)**.
For example, an app already using Supabase can keep it while choosing Vercel, Netlify or another
compatible host; this does not imply an existing Supabase cloud project or a tested cross-pairing.
Explain relevant framework limitations before presenting a provider as compatible. If they say
"you pick", suggest the option with the **fewest new accounts** and say why in one line.
For Other, use the menu's provider id when listed, or a lowercase letters/digits/hyphens id for an
unlisted provider (for example, `hosting=example-host`), never the placeholder `other`. An accepted
id records the choice; it does not add an adapter or guarantee deployment. Read
`references/guided.md`: check current official documentation, prefer a suitable official CLI,
consider an available official MCP or API when safe, then guide dashboard steps. No MCP install is
required. Stop with a concrete blocker when no safe documented path is available.
Ask whether they have a custom domain and which "from" address emails use.
For DNS, distinguish the registrar (where the domain was bought) from the authoritative DNS host.
Cloudflare, GoDaddy and Porkbun DNS are automated; a domain bought at one may use another's DNS.
The GoDaddy/Porkbun adapters check public delegation and do not move nameservers or buy domains.
Neon supplies server-side Postgres connections, not the Supabase SDK or Supabase Auth. Choosing it
does not migrate an existing Supabase app. For an existing Neon database explicitly select its
branch, database and role; show those selectors in the approval summary. New Free projects use
the documented initial defaults. Schema migrations and app-level authorization need separate review.

```
init --stack hosting=<id>,db=<id>,auth=<id>,payments=<id>,email=<id>,dns=<id>
     [--domain example.com] [--email-from hello@example.com]
     [--project hosting=<id|name>,db=<id|name>] [--webhook-path /api/...] [--events a,b]
     [--stripe-publishable test=pk_test_…,live=pk_live_…] --json
```
- **Account and project are separate choices:** a Supabase dependency/env name in code proves
  only that the app needs Supabase, not that an account or database already exists. Ask whether
  this app has an existing project. If not, explain that Vercel hosts the app and Supabase hosts
  its database/Auth: two provider projects for one product. For a new user, guide browser signup
  and a Free organization first; golive can create the database project after approval. Don't ask
  them to choose an unrelated project merely to finish a token form. If project-scoped access is
  their only option, explain the alternative: they create a Free project in the dashboard, then
  select that exact project for this app and for the scoped token.
- **Existing projects:** pass `--project` for a deliberately chosen existing project. Otherwise
  golive may propose adopting a same-named project or creating one; neither implies consent. In a
  throwaway test, stop on a same-name collision and choose a fresh name instead of adopting it.
- **Stripe webhook:** check `detect.webhooks[]`, both `path` and `events` (the event types the
  handler handles), against the handler code. Pass `--webhook-path` / `--events` if either is wrong
  or `events` is empty.

### 3. Accounts: `doctor --json`
For each provider with `ok: false`, give the human its `howToFix` (see "How the human connects
accounts"). `credentials` shows the credentials file's path, whether it's private, and the *names*
in it. Re-run until everything is ok or the rest are guided.
For a guided provider, `doctor` can return `ok: false` and exit code 2 because no adapter exists;
this alone is not a login failure or a reason to request another credential. Verify its account
through the chosen official tool or dashboard, following `references/guided.md`.
For Supabase, distinguish token **capabilities** from **resource scope**: "Full access" to one
project cannot create another project or manage its organization. A `/profile` 403 can mean a
project-scoped token, not an invalid key. Explain the required scope; don't blindly ask for another
Full access token. A passing account check doesn't prove every later endpoint permission.

### 4. Plan: `plan --json`
Explain the steps by provider, in plain language, and call out:
- which steps **write**, and which `needs` `--confirm-live` / `--confirm-dns` / `--confirm-destroy`
- `project:hosting` / `project:db`: which project and account every write goes to. If a step
  **creates** a project, its preview lists existing projects; ask whether to use one of those instead
  (`init --project <axis>=<name>`, then `plan` again). Creating a project can cost money.
- `handoffs`: what only the human can do. For a missing Stripe publishable key, ask for the `pk_` key
  and run `init --stripe-publishable <mode>=pk_<mode>_…`, then `plan` again.
- `auth:settings` / `auth:redirects` (Supabase Auth): the auth policy comes from `auth` in
  `golive.yaml` (`signup`, `requireEmailConfirm`, `passwordMinLength`; set or change those keys and
  re-run `plan`) and the redirects from the production URL. They are separate steps, each writing
  only what differs; show the `before → after` lines as the change being approved.
- `auth:smtp`: only when the human opted in with `auth.smtp: resend` **and** the email axis is Resend.
  Say plainly that it points the project's auth emails at Resend's SMTP (`smtp.resend.com:465`, user
  `resend`) as the sender `email.from` already names, and that the SMTP **password** is a sending key
  golive already issued: the one the email journey issued in this run, otherwise one golive issues for
  SMTP alone (`golive-…-smtp`, recorded in state like every other key). Never ask for that password —
  golive never prints, stores or reports it, and the provider never returns it (it answers a hash), so
  the step confirms the host/port/user/sender it can read back and a real auth email arriving is the
  only full proof. It also **raises the project's auth email rate limit** (`rate_limit_email_sent`) in
  the same approved write — the provider keeps that limit with custom SMTP in place, so wiring the
  mailer alone does not free a run's four sends — to 30 per hour, or to `auth.emailRateLimitPerHour`
  from `golive.yaml`; the plan and the step's changes name it (`auth email rate limit: 2 → 30 per
  hour`). Then `auth-policy` reports `custom SMTP via Resend` instead of the built-in-mailer warning
  plus the limit the project now holds, and the journeys below no longer depend on that mailer's rate
  limit.
- `auth:test-user`: only when the human opted in with `auth.e2e: true`, `auth.testEmail` and (for the
  app route) `auth.protectedPath`. Say plainly that it **creates a real account in their project**
  (a `--confirm-live` write), that the generated password lives only in that run, and that the
  confirmation email goes to their inbox: clicking that link is their one manual step
  (`auth:confirm-email`). Once they click, `golive handoff` reports that handoff done — `auth-signup`
  proves the journey from the provider's own reads, without needing that run's password — and a fresh
  `plan` + `apply` rotates the password so `auth-signup` / `auth-session` also prove the confirmed
  account can sign in. Those two checks also sign up one throwaway probe account each run, so `verify`
  writes when `auth.e2e` is on; with it off they skip and nothing is created.
- `auth:recovery`: only when the human opted in with `auth.recovery: true` **and** a confirmed test
  account is already recorded (the journey above; a plan says so and waits when it is not). Say plainly
  that it **rotates that test account's password** — a `--confirm-live` write — through the provider's
  own recovery calls: it asks for a real recovery email, mints the link with the admin API, exchanges
  the token for a session and sets the new password with that session. The old and new passwords and
  the token live only in that run's memory, and the recovery email lands in the human's inbox: clicking
  it is their step (`auth:recovery-email`, non-blocking, closed by `auth-recovery`). It never touches
  any other account, and a captcha or the provider's mail throttle stops it with the reason.
- `auth:isolation`: only when the human opted in with `auth.isolation: true` **and** `auth.e2e: true`
  already seeds the first account. Say plainly that it **creates a second real account in their
  project** (a `--confirm-live` write) whose address is `auth.testEmail` plus `+gl-isolation`, that
  golive **confirms that second account through the provider's admin API** (so no second click is
  needed; the confirmation email it also receives is a side effect), and that the passwords live only
  in that run's memory. Then say what the isolation check needs from the app: two routes named by
  `auth.identityPath` (the caller's own identity as JSON) and `auth.isolationPath` (the caller's own
  rows; a POST stores one row for the caller), both refusing anonymous callers. When those are not
  declared, `auth:isolation-routes` (non-blocking, closed by `auth-isolation`) is the app-code task to
  hand to the coding agent — the check itself writes one marker row per account through
  `auth.isolationPath` while it runs, so `verify` stores two small rows in the app's own data when
  this opt-in is on.
- `preview:deploy` / `release:check`: only with `release.preview: true` in `golive.yaml` **and**
  `preview` in `targets`. Say plainly that the deploy makes a real preview deployment of the current
  working tree (the branch is named in its preview; the preview env is filled from the same
  database/auth project as production, so a preview touches production data), that it records the
  provider's own deployment id, and that `needs` includes `--confirm-live` when a live-mode value fills
  a preview env name. `release:check` writes nothing; it **depends on `preview:deploy`** and re-reads
  that deployment from the provider and scans the HTML/JavaScript it serves, and **fails the plan** when
  either fails — that failure is the gate, and nothing is promoted by those two steps. Say plainly what
  that gate does and does not stop, because the step's own text does: it is the last step, so it stops
  nothing that came before it — a production deploy this plan emits runs earlier and is not gated by it
  — and what it gates is the promotion (a later plan, which re-runs the check before any production
  write). `apply --only release:check` is refused while `preview:deploy` has no completed evidence, so
  the gate is never run against a deployment the plan did not make. A host with no per-deployment
  preview read (Vercel) makes both checks skip: say that the preview is unverified rather than implying
  it passed, and point the human at the provider's own dashboard or CLI. These step ids are new, so a
  plan approved before the opt-in no longer matches: re-plan and get a fresh approval.
- `promote:production` / `release:rollback`: only with their own opt-ins (`release.promote: true` on
  top of the preview opt-in, or `release.rollback: true` on its own; both set means golive plans
  neither and says why). Say plainly, in the human's language:
  - A promotion **re-points production at the preview deployment golive deployed and recorded** — the
    plan names that exact deployment id, URL and the env target it was built with, and what production
    serves before it. It needs **no additional confirmation flag**: the plan id, the named deployment
    and `release:check` in the same plan (re-read from the provider, bundle scanned) are the approval.
    A failing check stops the plan before production changes.
  - Because the provider reports a deployment's id only once the deployment exists, a promotion is one
    of two halves and the preview says which: **cut** (`preview:deploy` + `release:check` at the end of
    the plan, a new candidate) or **release** (`release:check` + `promote:production`). Say plainly
    that in a **cut** plan the check gates the candidate, not the plan: everything else it does — a
    production deploy included — runs before the preview steps, so nothing that came before the gate is
    stopped by it, and the promotion stays in the next approved plan. In the **release** plan the check
    is the promotion's prerequisite and a red gate stops the re-point. While `release.promote` is set,
    every plan asks for a release: run the plan the human actually asked for, and after a release tell
    them the flag is a standing request — remove it (or set it to `false`) when they do not want
    another release planned. Do not loop `plan`/`apply` for it.
  - A rollback **re-points production at an earlier deployment golive itself created and recorded**
    (`deployed:history`); it is never automatic, never deletes anything, and only an approved plan run
    performs one. Once golive has rolled production back it reports that instead of planning the same
    rollback again. A deployment built by the provider's dashboard, a Git push or a pull request is
    never a promotion or rollback target: that stays with the human and their provider.
  - Both steps re-read the target deployment and what production serves **before** writing and prove
    what production serves **after**; a host that cannot answer those reads (Vercel has no
    production-deployment read) makes golive plan no promotion/rollback and say so. Treat promotion and
    rollback as **implemented and mock-covered, not live-validated**, and never describe them as
    verified on the human's own project until a report says so.
- `warnings` and `findings`, and `unmappedEnv`: env names golive can't fill (e.g. `OPENAI_API_KEY`).
  The human types those into the host's dashboard. Never ask for the value.

Before asking for approval, put a short consent summary **directly in chat**, even when a detailed
plan document exists. Read the destinations from `steps[].preview` (with the step's `destination`
when it has one) and `steps[].needs` for the confirm flags, plus verified provider metadata — never
guessed names. A teardown plan's `targets` is empty: its `steps[].preview` lines are the summary:

- **Frontend:** Vercel → account / team display name → project name; new or existing.
- **Database + Auth:** Supabase → organization display name → project name; new or existing; region.
- **Changes and cost:** what will be created/changed, test/live mode, verified free tier/quota or
  what remains unknown. State why these destinations were proposed (e.g. sole eligible Free org).
- **Approval:** link the detailed `GOLIVE-…-PLAN.md`, name the `planId`, and ask for an explicit yes
  to these exact destinations and writes. Say they can choose another team/org first.

Adapt the bullets to the selected providers. Include IDs in the detailed plan to disambiguate names.
A long document, a slug alone, or "looks ready" is not a substitute for this summary. Unknown scope
or cost needs resolution before asking for approval; never infer consent from "what's next?".
Remember the approved `planId`; changing destination requires a fresh plan and approval.

### 5. Apply: `apply --plan <planId> --yes [--confirm-live] [--confirm-dns] [--confirm-destroy] --json`
Report each outcome. For a `failed` or `blocked` step, read its `error`/`next`, fix the cause, and
run `apply` again (completed steps are skipped). If a write may have reached the provider, first
follow `references/troubleshooting.md` to reconcile its remote outcome; missing local state alone
is not permission to repeat creation. If `apply` says the plan changed, or `domain:dns`
says the records the host requires changed since approval, run `plan` again and get approval again
(with `--confirm-dns` for DNS). Some things only appear after the first deploy (webhook, site URL): run
`plan` again after a successful apply until it shows only the zero-write project pins. If the gate
`release:check` failed, fix the cause and run `plan` + `apply` again: the failure is recorded, so the
next cut deploys a fresh preview of whatever was fixed and checks that deployment, and a promotion plan
re-runs the check against the recorded candidate — a candidate whose check failed is never promoted.
The two release checks can also be re-run against the current preview with `verify --only
preview-deploy,preview-bundle`, whose result is evidence, not a new gate. A `promote:production` or
`release:rollback` step in the plan is applied the same way — one approved plan, and its own `run`
re-reads both sides around the write — and it needs no extra confirmation flag: the plan names the
exact deployment id.

### 5b. Teardown: `teardown --json`, then `apply --plan <teardown planId> --yes --confirm-destroy [--confirm-dns] --json`

`teardown` is the inverse plan: it lists ONLY resources golive can prove it created — golive-owned DNS
records at the configured provider, recorded webhook endpoints, issued sending keys, and the host
project whose creation marker matches. Adopted projects, records golive did not write, and anything
without a capability become non-blocking `manual` handoffs (Supabase/Neon projects, the Resend sending
domain). Show the list, get explicit approval, then apply with `--confirm-destroy`; DNS deletions also
need `--confirm-dns` and live-mode endpoints `--confirm-live`. An already-removed resource is a
harmless no-op, and a blocked deletion step deleted nothing — resolve and re-run.

### 6. Verify: `verify --json`
Runs the live checks and writes `GOLIVE_REPORT.md`. A **`skip` means blocked or not applicable, never
passed**: its evidence says `blocked by: <id>`. If `accounts` fails, fix logins first and re-run;
most other checks skip until then. `verify --only <id>` produces a partial report for this invocation;
old results are not carried forward. Run full verification for a current check set. A check report
does not establish deployment readiness or replace reviewing pending plan steps and app acceptance.

Check scope:

| id | checks |
|---|---|
| `accounts` | every automated provider is logged in |
| `env-parity` | the host has every env name the code needs, per environment (names only) |
| `domain-live` | custom domain is attached at an automated host (`ok`), resolves, serves HTTPS; with a guided host, DNS + HTTPS only (attachment not confirmed) |
| `netlify-public-access` | Netlify's confirmed production homepage accepts an anonymous request; a private gate needs the exact-project visibility UI handoff, without changing team defaults or exposing previews |
| `bundle-secrets` | known secret patterns in fetched production HTML/JavaScript; incomplete fetches or scan limits warn instead of passing |
| `rls-probe` | tables not readable with the public key |
| `db-connection` | selected Neon database and role accept a fixed read-only query; does not verify migrations, deployed app access or user isolation |
| `auth-redirects` | auth site URL / redirect allowlist point at production |
| `auth-policy` | auth signup/confirmation/password policy matches the app and golive.yaml (site URL and redirects are `auth-redirects`); the mailer is reported as the provider's built-in one (with its rate limit) or as the custom SMTP it is (Resend's own host named), with the provider's own auth email rate limit and a medium warning when it is below the four accepted sends an auth journey run needs; a setting the provider does not report is named, never assumed, and the SMTP password is never read back |
| `auth-signup` | the `auth.e2e` journey: a fresh probe address gets a confirmation email, cannot sign in before confirming, and the test account reads back confirmed (`email_confirmed_at`) — a sign-in of that account is extra evidence when this run holds its password (golive never sees the inbox: delivery and the click stay human-confirmed) |
| `auth-session` | the `auth.e2e` journey: the test account's password login returns a session, the token resolves to that user, an anonymous request is refused, and a declared `auth.protectedPath` is not publicly readable |
| `auth-recovery` | the `auth.recovery` journey: the provider accepts the recovery request for the test account, an address with no account gets the same answer (a different one is account enumeration), the token this run spent is refused when replayed, the new password signs in and the one it replaced is refused, and the token's window is named from `otpExpirySeconds` when the provider reports it (a 429 only warns: the mail throttle decides what a run can prove) |
| `auth-isolation` | the `auth.isolation` journey: two recorded accounts sign in at once, both declared routes refuse an anonymous caller, each account's identity route answers with its own id and never the other's, and each account's rows route returns its own marker row and none of the other's (an anonymous 200, a crossed id or another account's marker fails **critical**) |
| `webhook-unsigned` | the production webhook rejects unsigned POSTs (a non-HTML 401/403 only warns: it may be an auth wall) |
| `webhook-registered` | the endpoint exists, enabled, for the right URL and events |
| `stripe-live-ready` | the Stripe account can take live payments |
| `email-dns` | the sending domain's SPF/DKIM/DMARC records are published |
| `email-verified` | the email provider marks the domain verified |
| `preview-deploy` | with `release.preview: true`: the hosting provider's own read confirms the preview deployment golive recorded (`deployed:preview:id`) is ready, belongs to the linked project and is not the production deployment; skips once golive itself promoted that deployment (it is production then, not a preview to gate) |
| `preview-bundle` | with `release.preview: true`: the HTML/JavaScript the provider-confirmed preview URL serves carries no known credential patterns (a protected preview skips; an incomplete scan only warns) |
| `production-release` | with `release.promote`/`release.rollback` (or a recorded release, even after the opt-in is removed): the provider's own read of what production serves is the deployment golive promoted or rolled back to, naming what production served before. Skips without a recorded release and on a host that cannot answer that read (Vercel); **warns** when production serves a deployment golive never recorded (a dashboard, Git or PR-built one — a handoff, `action` for the human); **fails** when it serves another deployment golive recorded (something moved production after the release) |

`auth-signup` and `auth-session` are opt-in: without `auth.e2e: true` in `golive.yaml` they skip with
that reason and create nothing. With it on, each run signs up one throwaway probe account (address
`auth.testEmail` plus a plus-tag). The seeded account's password exists only in the run that seeded or
rotated it, so `auth-session` skips with `blocked by: no password for the test account in this run`
outside such a run; `auth-signup` needs no password — it passes on the provider's own reads (the
probe's signup, its refused login, the account's `email_confirmed_at`) and adds the confirmed login as
extra evidence when that run holds the password. Never report the inbox leg as verified by golive.

`auth-recovery` is opt-in too (`auth.recovery: true`), needs a seeded account (`blocked by:
auth:test-user` without one) and only passes in the run that carries the `auth:recovery` step: the
password it set and the token it spent exist there and nowhere else, so a plain `verify` skips with
`this run holds none of what the recovery check needs`. It spends up to two auth emails per run, so a
429 warns rather than fails, and it never reads the inbox: the click stays with the human. This check
**passed a disposable live run on 2026-09-24** (accepted request, an unknown address answered
identically, the spent token refused on replay, the new password signing in and the one it replaced
refused), so the journey is proven for Supabase — but only in the exact pass that report carries: the
human's inbox click stays human-confirmed, and a project's captcha or mail throttle can still make a
run skip or warn. Never present the inbox leg as verified by golive.

`auth-isolation` is opt-in too (`auth.isolation: true`, plus `auth.identityPath` and
`auth.isolationPath`), needs the second account the `auth:isolation` step seeds (`blocked by:
auth:isolation` without one) and needs BOTH accounts' passwords, which exist only in the run that
seeds or rotates them: a plain `verify` skips with that reason. A skip — never a pass — is also the
answer when a route is undeclared or answers 404 (the skip names the app-code task), when a route
refuses the session token golive holds, when the host cannot confirm the production URL, or when the
provider or the app rate-limits a request. Treat it as **implemented and mock-covered, not
live-validated**: until a live run's report says `pass`, never present account isolation as proven on
the human's project, and never read it as covering an app whose routes golive could not read.

`preview-deploy` and `preview-bundle` only mean anything after an opted-in preview deploy recorded
`deployed:preview:id`: without one they skip with that reason, and a plan without `release.preview`
never produces one. Treat them the same way — **implemented and mock-covered, not live-validated** —
and note that on a host exposing no per-deployment preview read (Vercel) both skip, so the preview is
unverified by golive rather than gated; say that plainly instead of presenting the preview as checked.

`production-release` is the same: **implemented and mock-covered, not live-validated**. It only has
something to confirm when a promotion or a rollback recorded one (`deployed:release`), and on Vercel
it skips with `exposes no read of what production serves` — that is not a pass. Report its warn branch
as a handoff (the human confirms or changes that deployment in the provider's own dashboard), and its
fail branch as an open problem: production moved after the release, so re-plan (`golive plan`) and
apply the release step it shows if production should serve a deployment golive created.

Finish with a short summary: the live URL, what passed, what is still open (`handoff --json`), and
every `done: null` / skipped item named as not verified by golive. Say who owns each remaining item —
the human's login, purchase or dashboard step, a recurring job, or golive's own next run.

### 7. Status: has anything changed behind golive's back? `status --json`

Run this once the app is live: **before a release**, and **after a run that changed providers or
settings**. It compares what golive recorded (the DNS records it wrote, the env names it delivered,
the webhook endpoint, the domain attachment, the db project and its connection selectors, the sending
domain, the payment account, the host project, unfinished release state) with reads taken now. It
writes nothing — no report, no state, no provider write — and exits `2` when any item has an
`action` other than `none`.

- Every item is labelled: `expected` is *recorded by golive <time>*, `observed` is *read now*. Report
  both, in the human's language, with the `subject`.
- `action: verify` → re-establish it with that item's `checkId` (`verify --only <checkId>`);
  `reconcile` → `plan`, get approval, `apply` (DNS needs `--confirm-dns`); `human` → only the human can
  decide (an account switch, a project that cannot be read).
- `medium` and `info` items often say the change **may be intentional**: ask the human instead of
  reporting a fault. `info` + `action: none` is nothing to act on (e.g. DNS still inside the
  propagation window).
- `unverifiable: true`, and every `notChecked` entry, means golive could **not read** that subject:
  say so plainly and never present it as clean. `verified` lists what was read and found unchanged —
  the only thing a "nothing changed" statement may cover.
- **Never use `status` as a gate.** Do not block `plan`, `apply` or a release on it, and never
  re-baseline anything by hand: only an approved write moves a baseline. Drift is a review list for
  the human, not a decision the agent may take for them.

For the durable ownership record, run `handoff --write --json` (add `--force` only when the human
agrees to replace a file golive did not generate). It writes `GOLIVE_HANDOVER.md` and
`.golive/handover.json`: the accounts and login route, every resource golive provably created with the
proof it is golive's, what is still manual, what recurs (DMARC tightening, key rotation, backups,
domain renewal), how removal works, and the commands that re-check each subject. Every row is tagged
`[verified by golive]`, `[recorded <date>, not re-checked]`, `[not verifiable by golive]` or
`[unknown]` — treat the last three as unverified, and never present the document as drift detection,
because nothing was re-checked unless its row says so (use `status` to re-check those subjects). It
contains no secret values, but it names accounts and resources: tell the human to review it before
sharing it. The CLI's report is `GOLIVE_REPORT.md`. Recommend adding `.golive/`, `GOLIVE_REPORT.md`
and `GOLIVE_HANDOVER.md` to the app's own `.gitignore`: state, report and handover carry resource ids
and account names, while credential values live outside the repo in the private credentials file.

## More detail (load only what you need)

- `references/plan-and-verify.md`: detect findings, plan steps and ordering, handoffs, what each
  check needs and why it skips, and what `status` compares.
- `references/guided.md`: when the chosen provider isn't automated.
- `references/troubleshooting.md`: setup failures, CLI/PATH mismatches and resuming after a repair.
- `references/<provider>.md`: `vercel`, `netlify`, `supabase`, `neon`, `stripe`, `resend`, `cloudflare-dns`, `godaddy`, `porkbun`.
