# Detect, plan, apply, verify: details

Load this when you need to explain a detect finding, a plan step, a handoff, why a check skipped, or
what a `status` drift item means. Provider-specific notes live in the other references.

## 1. Detect

`detect --json` returns `detect` (framework, `providers`, `envRefs`, `webhooks`, `notes`, …),
`env.mapped` / `env.unmapped`, `findings` and `suggestedStack`. Exit code 2 = a critical finding.

**Browser-exposed names.** Besides framework prefixes (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, …), detect
reads the framework config. Names inlined by next.config `env: {}`, by Vite/Astro `define` or webpack
`DefinePlugin` (`process.env.X` / `import.meta.env.X` keys, and env reads inside define values), or
matching a custom Vite `envPrefix` or SvelteKit `kit.env.publicPrefix`, count as client-exposed. golive
refuses to write a server secret into them (`secret-in-client-env`) and adds a note naming them.

**`config-inlines-all-env` (critical).** Raised when the config defines or spreads the whole
`process.env` / `import.meta.env`, a whole `loadEnv(mode, dir, '')` object, computed
`process.env.${k}` keys, or uses an empty public prefix. Every web-side env name is then treated as
public, so no server secret is written to that app's host until the config is fixed. Names used
only by Supabase Edge Functions (`supabase/functions/`) are not host env vars and are unaffected.
This also covers a `define` / `env` / `DefinePlugin` value that isn't an object literal: an
identifier, a call, shorthand `{ define }`, a spread identifier, and later mutations of the object.
If such a value (or a `'process.env'` define) can't be resolved and doesn't inline the whole env, a
**note** says "<file> <via> is set from an expression golive cannot read; make sure it holds no server
secrets". Read the config and confirm.

**Other detect output.** `configs` lists config files found, including Prisma schemas
(`schema.prisma`, `prisma/schema.prisma`, the `prisma/schema` directory, `prisma.config.ts`, a custom
package.json `prisma.schema` path). A `@prisma/client` or `prisma` dependency adds the note
"Prisma detected".

**Webhooks.** Each `webhooks[]` entry has `provider`, `path`, `file`, `verifiesSignature` and `events`:
the Stripe event types the handler references as string literals (case labels, `===` comparisons,
arrays, handler maps), sorted. `init` subscribes the endpoint to exactly these unless you pass
`--events`. If `events` is `[]`, a note says so: read the handler and pass `--events a,b`. Check
detected events against the handler the same way you check the path.

## 2. Plan

`plan --json` → `planId`, `steps[]` (`id`, `title`, `kind`, `writes`, `needs`, `preview`,
`dependsOn`), `handoffs[]`, `unmappedEnv`, `warnings`, `findings`. `targets[]` lists only the steps
that carry a structured `destination` (the project steps), so a teardown plan's `targets` is empty:
read the destinations from `steps[].preview` (and the step's `needs` confirm flags) instead. Previews
are deterministic: the same state gives the same `planId`. `teardown --json` returns the same shape;
its steps carry `kind: 'destroy'` and `needs` includes `--confirm-destroy`.

**Step intent.** A step may also carry a secret-free `intent`: what it writes beyond its preview text
(source project ids, key fingerprints, endpoint ids, the hosting project, a previous attempt's time).
It is part of the step's hash and the `planId`. `apply` skips a completed step only when preview,
intent, risk, dependencies and kind are all unchanged, so a step with the same preview as last time
but a different intent runs again: a db project switch, a Stripe key rotation or a domain re-attach
really lands. The deploy step's intent includes the env writes it picks up.

**Teardown.** `teardown` enumerates only golive-created resources with their ownership proofs
(provider markers, state fingerprints, the host project's creation marker): DNS records golive owns,
recorded webhook endpoints, issued sending keys and the created host project. A removal re-checks
ownership before deleting. Each deleted DNS record is confirmed by re-reading the zone and the
deleted host project by re-reading the project: a project that is still resolvable fails the step,
while a read the provider cannot answer (auth, network) warns instead of passing. The webhook and key
removals rely on the provider's successful delete response, and every removal treats "already gone"
as done. Removing the host project also forgets its recorded deploy facts (the `deployed:…` marker
and the completed deploy step), so a project created again in the same repo is deployed again rather
than inheriting "production was deployed". Resources it cannot remove — adopted projects,
Supabase/Neon projects, the Resend sending domain — appear as non-blocking `manual` handoffs;
records or endpoints a human created are never deleted.

**Which project.** Every plan has a step `project:hosting` / `project:db` naming the provider,
project name (id), team/org if known, where the choice came from, and the logged-in account.
- Already linked: a zero-write pin. At apply time it refuses if the linked project changed since
  approval, then pins it in `.golive/state.json`. After a full apply, `plan` shows only these pins,
  and applying them is a no-op (`skipped`).
- `golive.yaml` `projects.<axis>` disagrees with the linked project: `plan` warns and uses the linked
  one.
- Nothing linked: a configured (`init --project`) or same-named project is selected; otherwise a
  **Create** step whose preview lists existing projects the human could use instead. Ask them, and
  use `init --project <axis>=<name>` to adopt one.

**Deploys.** Production is (re)deployed when this plan writes production env, when a production env
write is still waiting for a deploy, when the last deploy failed, or when golive has never deployed
production. Preview-only env changes don't trigger a production deploy. If production was never
deployed by golive, `deploy:production` runs **before** `domain:attach`, and
`deploy:production:final` redeploys after env writes that need the domain (the webhook secret). Once
deployed, attaching a domain neither waits for nor triggers a deploy.

**Production URL before the first deploy.** Without a custom domain, the host's production URL is used
for the webhook, the auth site URL and `SITE_URL`-style vars only after golive has deployed production
once. Until then those are left out with a warning; run `plan` again after the first deploy.

**Env steps.** Each env-writing step is verified by a step-scoped check `<step-id>:env-written` (only
the names that step wrote, on its target). Vars golive manages are rewritten when the provider, the
mode, the db/auth project behind them, or the payment account/key behind them changes.

**Domain.** `domain:attach` → `domain:dns` (DNS writes, `--confirm-dns`; verified against the zone's
records) → `domain:verify` (asks the host to verify ownership; on Vercel this can move the domain
from another account of the same host). `pending` there is not a failure: DNS is propagating, and
each new `plan` asks again (its preview shows `previous request: <time>`). While the domain isn't
live, each plan also re-sends `domain:attach` (idempotent). If at apply time the host requires
different records than the approved plan listed, `domain:dns` refuses and writes nothing: run
`plan` again and get re-approval with `--confirm-dns`. `domain-live` is left to `verify`. If the DNS zone lookup fails (token
permissions, rate limit, network), `plan` warns and plans no DNS step.

**Auth redirects.** Preview-deployment wildcards go into the (production) auth redirect allowlist only
with `auth.previewRedirects: true` in `golive.yaml`, and each such line is flagged as a risk.
Otherwise `plan` warns that sign-in on preview URLs won't work.

**Auth policy.** `auth:settings` writes only the values from `golive.yaml` `auth` that differ from
what the provider reports (`signup`, `requireEmailConfirm`, `passwordMinLength`), then re-reads them;
the step's own `auth:settings:applied` result and the `auth-policy` check carry that evidence. A
setting the provider does not report back shows as `not confirmed:` in the step's changes and does
not fail it; a value the provider keeps reporting differently fails the step. Changing a value in
`golive.yaml`, or changing it back in the provider dashboard, changes the step's intent, so it runs
again. Auth emails still going through the provider's built-in mailer warn unless
`auth.smtp: provider` accepts that deliberately; custom SMTP itself stays a manual dashboard step.

**Email.** `email:verify` is re-sent on each plan while the domain is pending; its preview shows
`previous request: <time>`.

**Secrets exposed.** A critical detect finding (or a client-prefixed secret name) blocks secret writes
for the affected names: env, payments keys, email key, and the whole webhook step. A blocking
handoff `secrets:exposed` tells the human to fix the code first. It disappears once detect stops
reporting the finding.

**Webhook.** The preview names exactly the endpoint apply will adopt, including one the human created
at the same URL: whether its events are kept, whether it will be re-enabled, and whether the old
endpoint is deleted or left for the human to delete. Apply refuses without writing if the endpoint
changed since approval. When the production URL changed, it also says the golive-created endpoint for
the old URL is deleted once the new secret is stored. If the host would refuse the secret
(`EnvStore.canSet`), a blocking `<adapter>:webhook-env` handoff replaces the step and no endpoint is
created. With a guided host, a blocking `<adapter>:webhook-guided` handoff (verified by
`webhook-registered`) asks the human to create it. See `stripe.md`.

## 3. Handoffs

Each handoff has `id`, `why`, `action`, `blocking`, and optionally `verifiedBy` (a check id) or
`manual: true`. `handoff --json` adds `done` and `evidence`:
- `done: true`: its check passed. Only a passing check closes a handoff.
- `done: false`: open. Its check ran and did not pass, or it has no check and isn't `manual` (it is in
  the plan only because its condition still holds, e.g. `secrets:exposed`, `stripe:webhook-env`).
  Blocking ones count in `apply`'s open handoffs and the report's `blocking`.
- `done: null`: golive cannot verify it (a `manual` item, or its check skipped). Confirm it with the
  human and list it as **not verified by golive** in your summary. `unverified` lists them.

Common ones: `login:<provider>`, `project:<axis>` (golive can't create it), `secrets:exposed`,
`db:password`, `stripe:activate`, `stripe:publishable-key:<mode>` (ask for the `pk_` key in chat,
then `init --stripe-publishable <mode>=pk_<mode>_…`; or the human adds it to the host dashboard),
`stripe:secret-key:<mode>` (the credentials-file instructions in its `action`; never chat),
`email:dns` / `domain:dns` / `domain:attach` (records or setup at a provider golive can't write),
`guided:<axis>`, `env:<target>` for a guided host (per target: the human sets the listed names in its
dashboard; `env-parity` can't read a guided host, so it stays `done: null`),
`stripe:webhook-env` / `stripe:webhook-guided` (see Webhook above), and `auth:redirects` for a guided
auth provider (manual, non-blocking: confirm it with the human, name it as unverified).

**Ownership document.** `handoff --write --json` also writes `GOLIVE_HANDOVER.md` and
`.golive/handover.json` (paths are reported as `handoverPaths`; `--force` replaces a file golive did
not generate — a file without the "Generated by golive" marker is never overwritten, and a symlink is
never followed). It is built from recorded state, `golive.yaml`, the cheap provider reads
`doctor`/`verify` already make (`auth().via`, project scope and URLs) and the teardown inventory —
never from `state.secrets` or an `Outputs` value, never from a billing endpoint. Sections: accounts and
login route; resources created (id, public URL, ownership proof, created-by-golive vs adopted); costs
and recurrence (no figures at all: golive reads no plan, quota or usage data); what is manual (the open
handoffs plus recurring jobs — DMARC tightening, key rotation, backups, domain renewal); if it breaks
(per-subject `doctor` / `verify --only` commands, `plan` → `apply` → `verify`, and where evidence
lives); retirement (the teardown inventory with its `--confirm-destroy` / `--confirm-dns` gates); and a
provenance footer. Every row carries `[verified by golive]`, `[recorded <date>, not re-checked]`,
`[not verifiable by golive]` or `[unknown]`. Treat the last three as unverified: this document is not
drift detection. It holds no secret values, but it names accounts and resources — review it before
sharing it.

## 4. Verify

`verify --json` runs every check. `--only id,id` writes a partial report containing only results
from this invocation; omitted checks are listed and previous results are not reused. Neither scope
establishes whole-app readiness: review pending plan steps and app functional acceptance. Verification
writes `.golive/report.json` and `GOLIVE_REPORT.md` (old `SHIP_REPORT.md` files are preserved).
Exit 2 when any check fails. `summary` counts
`pass`, `fail`, `warn`, `skip`, `blocking` (open blocking handoffs) and `manual` (blocking ones golive
can't verify).

**`skip` = blocked or not applicable, never passed.** Evidence `blocked by: <id>` names what's
missing: `login:<adapter>`, `project:hosting`, `project:db`, `deploy:production`, `email:domain`, or a
plain reason (e.g. `no publishable/anon key`, `the hosting token's role cannot read production env
vars`). Only `accounts` fails for login problems; fix it first, then re-run `verify`.

**Active probes** (`bundle-secrets`, `webhook-unsigned`, and the key `rls-probe` takes from the bundle)
only target the production URL the hosting adapter reports for the linked project, never
`config.domain` directly. If the host can't confirm it, the check skips with `cannot confirm <url>
belongs to your project yet`. If the host reports another origin than `config.domain` (e.g. the domain
isn't verified at Vercel yet), `webhook-unsigned` probes the host's URL and says so. `domain-live`
does resolve and GET `config.domain`.

| id | passes when | skips when |
|---|---|---|
| `accounts` | every automated provider authenticates | nothing chosen |
| `env-parity` | every referenced name exists per target (names only; unmapped missing names only warn) | guided host; a source provider not logged in (`blocked by: login:<id> (NAME@target, …)`); the role can't read production env |
| `domain-live` | automated host reports the domain `ok` (`pending` warns), it resolves, HTTPS answers 2xx/3xx; guided/no host: DNS + HTTPS only, evidence says the attachment isn't confirmed | no domain; `blocked by: login:<host>` / `project:hosting`; the host's status lookup errors (`cannot confirm <d> is attached …`) |
| `bundle-secrets` | no known credential patterns in the complete bounded fetch set | production URL not confirmed; **warns** on asset fetch failures, scan limits or off-origin production redirects |
| `rls-probe` | tables in exposed schemas aren't readable with the publishable key; advisors clean | `blocked by: project:db`; no publishable/anon key |
| `db-connection` | the selected Neon compute accepts a fixed read-only query and returns the expected database and role; no schema/Auth/app-isolation claim | no connection-probe capability; `blocked by: login:<db>` / `project:db` |
| `auth-redirects` | site URL and allowlist point at production, no localhost | guided auth; `blocked by: deploy:production` |
| `auth-policy` | the reported signup/confirmation/password policy matches golive.yaml `auth` (below 12 characters or a built-in mailer only warns); evidence lists the effective values | guided auth; `blocked by: login:<id>` / `project:<axis>`; the provider reports no policy fields |
| `webhook-unsigned` | an unsigned POST gets 4xx from the handler (a non-HTML 401/403 only warns — ambiguous between a rejection and an auth wall) | production URL not confirmed |
| `webhook-registered` | an enabled endpoint for the production URL covers the configured events | guided payments; no production URL |
| `stripe-live-ready` | the account has `charges_enabled` | production isn't live mode |
| `email-dns` | the provider's listed records (or common locations) and DMARC are in public DNS | no sending domain |
| `email-verified` | the provider marks the domain verified | guided email; `blocked by: email:domain` |

Details that trip people up:
- `env-parity` doesn't require `STRIPE_WEBHOOK_SECRET` (or other webhook-secret names) outside
  production: the webhook is registered and its secret written for production only. It doesn't
  require site-URL vars for a target with no stable URL (Vercel preview; production before the first
  deploy without a domain). These show as `not required` evidence lines. If the app needs e.g.
  `NEXT_PUBLIC_SITE_URL` in preview, the human sets it.
- `domain-live` warns "not propagated yet" (instead of failing) only right after a `domain:dns` step.
- `email-dns` checks exactly the records the provider lists once a sending domain id is recorded; a
  missing provider DKIM record fails. A missing DMARC record only warns and suggests one; golive does
  not write DMARC. Without that list it uses each provider's usual layout: a missing SPF fails only
  for Resend's `send.<domain>`; Postmark / SES DKIM selectors can't be found over DNS, so not finding
  one is a low warning (confirm DKIM in the provider dashboard). Details in `guided.md`.

## 5. Status (drift): what changed behind golive's back

`status --json` is the only command that asks whether the world still matches what golive **recorded**
— which is why no check can answer it: a check's report is release evidence for this invocation, while
drift needs the recorded side (state resources and step evidence, or a marker the provider assigned).
Run it once the app is live, before a release and after a run that changed providers or settings. It
writes nothing: no report, no state change, no provider write, and exit `2` means at least one item has
an `action` other than `none`.

Each item pairs `expected (recorded by golive <time>)` with `observed (read now)` and says who can act:
`verify` (re-run the named `checkId`), `reconcile` (an approved `plan` → `apply` restores it; DNS steps
still need `--confirm-dns`) or `human` (only the human decides, e.g. the credential now reads a
different account, or a project cannot be read at all). Severity: `high` = the app is broken (a record
deleted, an endpoint gone, a domain detached, a project unreadable); `medium` = hygiene or teardown
safety, or a change that may be deliberate; `info` = nothing to act on. Subjects: DNS records golive
wrote (checked against the zone, and against public DNS only while the zone still matches the baseline
— a record written inside the propagation window may legitimately differ publicly and is `info`), public
name-server delegation, golive-managed env **names** (never values: hosts hide sensitive values and
golive stores fingerprints, so a rotated value is outside the comparison), the recorded webhook endpoint
(gone, disabled, or missing events; a replacement at the same URL names the now-stale signing secret),
the domain attachment plus the records the host now requires, the db project and its
branch/database/role selectors, the sending domain, issued sending keys (no provider read exists, so
they are reported as unverifiable rather than checked off), the payment account and mode behind the
app's keys (a 403 is unverifiable, never drift), the host project identity and its creation marker, and
unfinished release state (a production env write no deploy picked up, a failed step).

A provider that cannot be read yields `unverifiable: true` with `action: 'none'` and appears in
`notChecked`: never drift, and never "clean". `verified` lists the subjects read and found unchanged —
the only thing a "nothing changed" statement may cover; `limits` names what this comparison can never
see. Drift is never a gate: `plan` and `apply` do not consult it, and nothing is re-baselined except by
an approved write.
