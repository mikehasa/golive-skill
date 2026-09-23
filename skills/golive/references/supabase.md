# Supabase (database + auth): agent notes

Load this when the plan uses `db=supabase` or `auth=supabase`.

## 1. Logging in

**Preferred: one `supabase login` in the human's own terminal.** It needs a TTY, so use the Terminal
app or the IDE terminal, not the agent or Claude Code's `!` prefix. For a new account, the human
signs up and creates/selects a Free organization first; SDK imports do not prove a project exists.
Then golive checks the account and presents the exact project destination for approval.

On supported credential stores, golive reuses that browser login for the **complete flow**: creation,
API keys, pooled database URLs, Auth redirects, RLS queries and advisors. It captures the credential
internally as `Secret` and uses HTTPS; it never prints it or puts it on argv. A second manually
created Management API token is not required. Do not inspect or print the CLI token store yourself.

Supported credential stores (Supabase CLI v2.117.0 or later within v2):
- **macOS:** the official Keychain service/profile, with the documented private-file fallback when
  its items are absent. macOS may ask the human to allow a Keychain read. Denied/locked access stops
  the flow; golive does not silently choose another account.
- **Linux/WSL:** the CLI's private token file with keyring disabled, or on WSL. On Linux use
  `SUPABASE_NO_KEYRING=1 supabase login --profile supabase` in the human's terminal and preserve
  `SUPABASE_NO_KEYRING=1` when running golive. This is still browser login, not manual PAT creation.
- **Windows/native Linux keyrings:** safe reuse is not implemented. Use the explicit-token fallback
  below. Unknown CLI major versions require review; update an older CLI before retrying.

Only the production **`supabase` profile** is supported. `SUPABASE_PROFILE` overrides the CLI's
persisted profile file; staging, local, Snap and custom API profiles are rejected. Use
`supabase login --profile supabase` to select the intended production account. Stores are read-only;
golive never migrates them or changes permissions. Wrong owners, unsafe permissions or redirected
paths fail closed. A native macOS read-only test on 2026-09-23 reused the existing login with the
explicit-token path disabled: profile/projects/organizations reads passed and the CLI/API project
inventories agreed. First-login UX and project/Auth writes through that credential remain untested;
the earlier full deployment used an explicit token. Do not describe this as a fresh login or full E2E.

**Alternative: `SUPABASE_ACCESS_TOKEN` for CI or unsupported stores.** The human creates it at
https://supabase.com/dashboard/account/tokens with the permissions below. On macOS, run
`credentials --prompt SUPABASE_ACCESS_TOKEN --json` for private native entry. Their own editor is
the fallback if unavailable, unsupported, or preferred; follow
[How the human connects accounts](../SKILL.md#how-the-human-connects-accounts) for fallback,
replacement and cancellation. Never put the value in chat or command arguments; exporting it in an unrelated human
terminal does not reach the agent's shell. Never run `supabase login --token …`.

An explicit token takes precedence over CLI login for every call. If it is invalid, golive fails;
it never silently switches accounts. The human may replace it or remove that explicit setting to
use the CLI login. A rejected stored login is refreshed with browser login, without generating a PAT.

If using the **explicit-token alternative for an existing throwaway project**, choose only that project and a short expiry. Stage 1 permissions, using
the [current Supabase UI labels](https://supabase.com/docs/guides/platform/personal-access-tokens):

| Task | Permission / access |
|---|---|
| Project details + health | Project Settings: Read |
| Reveal API keys | API Keys + API Key Secrets: Read |
| Inspect auth | Auth Config: Read |
| Set site URL / redirects | Auth Config + Project Settings: Read-write |
| Read Data API schemas | Data API Config: Read |
| RLS SQL check | Database: Read |
| Security advisors | Advisors: Read |
| DB URLs if requested | Connection Pooling: Read |
| Approved password recovery for an golive-created project only | Database Config: Read-write |

For **a new project**, the human signs up and creates/selects a Free organization first. If using the token alternative, the docs list Organizations
Read, Organization Settings Read, Projects (account-wide) Read and Organization Projects Read-write for the
account/org flow. If the user's scoped-token UI does not expose these, the account-management token was under
the experimental-token dropdown in Stage 1; that is an observed rollout detail, not a universal UI guarantee.
Alternatively the human creates the throwaway project first, then supplies a token scoped to that project.

`doctor` / `plan` report the reused CLI login and the API-confirmed account identity. A missing,
unsupported or unsafe store gives a blocking `login:supabase` handoff with a specific remedy. If
only the limited legacy CLI fallback is usable, it covers project discovery, keys and the RLS query;
creation/Auth flows stay blocked until the login can be reused or the human supplies the alternative.

A `/profile` 403 does not mean the token is invalid: project-scoped tokens can still access their selected project.
golive verifies an explicitly selected visible existing project (exact ref or unambiguous configured name). With no
selected project, it checks organization discovery/details for one eligible Free destination instead. That confirms
organization read access only; creation write permission remains unverified until the operation. An empty/denied
organization list blocks this path. API operations check permissions independently and plan/apply revalidates targets.

## 2. What golive does vs. what stays with the human

golive automates (after plan approval):
- **Picks the project** (`project:db`): the linked one (state → `projects.db` in `golive.yaml` →
  `supabase link` file), else a same-named one it may adopt (names compare case-insensitively), else
  a **Create** step. It adopts a
  same-named project automatically only if it is in this app's org (the account's only org, else its
  single free org) and not paused or failed. A same-named project in another org, a paused
  (`INACTIVE`) one, or several orgs with no single free one means no auto-adoption: create refuses (no
  duplicate is made) and names the ref, org or status. The human chooses with
  `init --project db=<ref>`, or restores a paused project in the dashboard. golive never restores one;
  selecting a paused project fails with restore instructions. A `COMING_UP` / `RESTORING` project is
  waited on until `ACTIVE_HEALTHY`.
- **Creating costs money:** free orgs allow 2 active projects; on paid orgs each extra project is about
  $10/month of compute. Confirm with the human, and offer the existing projects the Create step
  lists. The region comes from `supabase.region` in `golive.yaml` (else Supabase's default group).
- For a new project, golive generates the database password and sends it only inside the create
  request. That request is **never re-sent** (90s timeout, no retry). If the response is lost, golive
  lists projects again and adopts the one new project with that name in that org, keeping the
  password it sent. If none appears, it fails and asks you to check
  `https://supabase.com/dashboard/org/<org>` before re-running (a re-run adopts it by name once it
  appears). Then it waits until the project is healthy (usually 1–3 minutes, up to 15). On timeout
  it asks you to re-run later: golive picks the project up (and resets its password if needed, below).
- A project golive creates is recorded as `supabase.createdByGolive=<ref>` in `.golive/state.json`
  (not a secret). The generated password lives only in memory. If a later run has lost it and no DB
  URL from that project was ever written, and the app actually requests a database URL, `plan` warns and the env write step sets a **new generated
  password** for it (Supabase Management API, using the reused login or explicit token) instead of a `db:password` handoff.
  Never for an adopted project, without a reusable credential, or once a DB URL was written for any target.
  Apps needing only Supabase client URL/API keys do not collect database URLs or reset the database password.
- Writes the project URL and API keys to the host under **the names the code uses** (publishable key
  for the browser, secret key server-only).
- When it knows the password (projects it created) writes:
  - `DATABASE_URL` (and `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, …): the shared Supavisor pooler in
    **transaction mode, port 6543** (uses the same login). Prisma repos get `?pgbouncer=true` (a
    `schema.prisma`, `prisma/schema.prisma` or `prisma/schema/` folder, a `prisma.config.*` or custom
    `prisma.schema` path, a Prisma dependency, or `POSTGRES_PRISMA_URL` referenced). Otherwise the
    log warns: postgres.js and Drizzle need `prepare: false`; node-postgres needs nothing.
  - `DIRECT_URL` (and `DATABASE_URL_UNPOOLED`, `POSTGRES_URL_NON_POOLING`, `DIRECT_DATABASE_URL`): the
    shared pooler in **session mode**, `postgres.<ref>@<region>.pooler.supabase.com:5432`. It is
    IPv4, so `prisma migrate deploy` works from Vercel. Without a reusable credential (or when Supabase lists no
    shared pooler) it falls back to `db.<ref>.supabase.co:5432` with a warning: that host is
    IPv6-only unless the project has the IPv4 add-on, so it won't work from most serverless hosts.
- Sets auth **Site URL** and the **redirect allowlist** to the production origin with a surgical API
  update (not `supabase config push`). Preview-deployment wildcards are added only with
  `auth.previewRedirects: true` in `golive.yaml` (flagged as a risk: it widens the production
  allowlist). Otherwise `plan` warns that sign-in on preview URLs won't work.
- Verifies: `rls-probe` (tables not readable with the public key, plus security advisors, read-only),
  `auth-redirects` (production URLs, no `localhost`), `env-parity` (names on the host).

Stays with the human (and why):
- **The database password of an existing project.** Supabase only reveals it at creation, so a
  `db:password` handoff appears: the human copies the connection string from the Supabase dashboard
  straight into the host's dashboard (never into chat), or resets the password in the Supabase
  dashboard (breaks anything else using the old one). Or the app skips a DB URL if it only uses the
  Supabase client.
- **Fixing RLS findings.** You (the agent) write the migration/policy change; the human approves it.
  golive never write-probes production data.
- **Custom SMTP for auth emails.** Not automated yet. The human sets it in the Supabase dashboard
  (Authentication → SMTP), pasting a sending key straight from the email provider (see `resend.md`).
- Restoring a paused project, plan upgrades, billing, creating OAuth apps (e.g. Google sign-in).

## 3. Explain these in plain words

- **New API keys.** `sb_publishable_…` is meant for the browser and is safe *only* if row-level
  security (RLS) is on. `sb_secret_…` bypasses RLS and must stay on the server. The old `anon` /
  `service_role` keys don't exist on projects created after 2025-11-01 and are being removed in late
  2026. If the code reads `SUPABASE_ANON_KEY`, golive fills it with the publishable key; suggest a
  rename.
- **RLS in one sentence:** "the publishable key is public, so the database itself must decide who can
  read each row." A table readable with the public key is a real leak unless it's meant to be public.
- **Default grants changed.** New projects (since 2026-05-30) and all projects from 2026-10-30 no
  longer let the public roles reach new tables automatically. After a migration the app may get
  "permission denied" (`42501`) until the migration adds a `GRANT` plus RLS policies.
- **Edge Functions and `verify_jwt`.** By default functions demand a Supabase login token (JWT). Stripe
  webhooks don't send one, so they get 401. Set `verify_jwt = false` for that function in
  `supabase/config.toml` (`[functions.<name>]`) and verify the Stripe signature in code. `detect`
  notes this. Env names used only under `supabase/functions/` are Edge Function secrets, not host env
  vars; golive doesn't write them.
- **Don't push `supabase/config.toml` to production blindly.** It usually has
  `site_url = "http://127.0.0.1:3000"` and localhost redirects; pushing that breaks sign-in.
- **Transaction pooler (port 6543)** has no prepared statements: Prisma needs `?pgbouncer=true` (golive
  adds it when it detects Prisma), postgres.js / Drizzle need `prepare: false` in code.
- **Free projects pause** after about a week without activity. Probes fail until the human restores it.
- **Vercel Marketplace integration:** if installed, Supabase vars are already synced into Vercel.
  golive adopts them rather than writing duplicates.

## 4. Troubleshooting

| Symptom | What to do |
|---|---|
| "Cannot use automatic login flow inside non-TTY environments" | The human runs `supabase login` in a real terminal window (Terminal app / IDE terminal), not with `!`. Not `--token`: use the credentials file. |
| CLI credential cannot be reused | Follow the specific version/profile/store remedy in `doctor`; check §1 platform support. Do not print or copy the vendor store. A manual PAT is the alternative only for unsupported setups. |
| Keychain denied, locked or timed out | The human unlocks Keychain and allows the read, then re-runs. golive does not silently fall back to another credential. |
| Credential invalid / expired (401) | If `via` is CLI login, refresh it with `supabase login --profile supabase`. If explicitly supplied, replace or remove that setting privately. No automatic account fallback. |
| `/profile` 403 but `/projects` succeeds | Project access can be valid. Explicitly select that existing project; creating needs organization/account management access. |
| 403 reading API keys | Check selected project, API Keys Read and API Key Secrets Read. A provider bug has also been reported; do not assume all scoped tokens fail or automatically broaden access. |
| Project paused (`INACTIVE`) | The human restores it in the dashboard (golive never does), waits until active, re-runs. |
| `INIT_FAILED` / `RESTORE_FAILED` | The human checks the project in the dashboard, or picks another with `init --project db=<ref>`. |
| Create refuses: same name in another org / several orgs | The human picks: `init --project db=<ref>` for an existing project, or creates it in the right org. |
| "no new project … is listed yet" after a create | Check the org's dashboard page; re-run apply once it appears (it's adopted by name). |
| Free-plan project limit on create | Human pauses/deletes an unused project or upgrades. Or adopt an existing project. |
| App gets `42501` / "permission denied" | Missing `GRANT` for the table (see default grants). Add grant + RLS policy in a migration. |
| `/rest/v1/` returns 403 "Access to schema is forbidden" | Expected since 2026: listing tables with the public key is blocked. `verify` uses the Management API / CLI instead. |
| Prepared-statement errors in production | Transaction pooler: Prisma `?pgbouncer=true`, postgres.js / Drizzle `prepare: false`. |
| Can't reach `db.<ref>.supabase.co` from the host | IPv6-only direct connection (fallback without a reusable credential). Repair the CLI login/store or use the explicit-token alternative and re-run so `DIRECT_URL` uses the session pooler; use `DATABASE_URL` at runtime. |
| Create timed out waiting for the project | Re-run `plan` + `apply` later; golive adopts the project it created and resets the password if it was lost. |
| Stripe webhook to an Edge Function returns 401 | `verify_jwt` is still on for that function. |
| Sign-in redirects to localhost or "redirect not allowed" | Auth Site URL / allowlist not updated. Re-run `plan` + `apply`, then `verify --only auth-redirects`. |
| Sign-in fails on preview URLs | Expected unless `auth.previewRedirects: true` (a risk) or a separate preview auth project. |
| Magic-link emails broken or slow | Supabase's default SMTP is rate-limited; custom SMTP is a manual dashboard step (§2). Turn off link tracking at the email provider. |

## Unverified

- Whether publishable keys are blocked from `/rest/v1/` exactly like anon keys (assumed yes).
- The exact enforcement date for removing legacy keys ("late 2026", not final).
