# Trust, access and control

This page is for the person deciding whether to give golive access to their provider accounts. It
separates what the running code enforces from what is only an instruction the agent is asked to
follow ([the honest boundary](#the-honest-boundary)). golive runs in the agent's shell on your
machine: it needs no golive account, no Mac login password and no server of its own.

## What golive may write, and what comes first

Nothing touches a real account without an approved plan:

- `plan` is read-only: it observes, writes no account and prints a plan id.
- `apply --plan <id> --yes` recomputes the plan identity and refuses to run if the release, the plan
  or the config schema changed since approval (`src/core/runner.ts:56-64`). That identity covers
  each step's id, preview text, intent, destination, risk flags and dependencies
  (`src/core/plan.ts:11-18`).
- The human reads that plan's previews, and they are secret-free: public values may appear, credential
  values never do (`src/core/plan.ts:71-72`, `test/links.test.ts:136`).

Only steps declared `risk.writes` write anything. In practice: provider projects (hosting, database),
host env vars, DNS records, deployments, a Resend sending domain and per-environment sending keys, Stripe
webhook endpoints, auth settings, one seeded test account for the auth journey, and the deletions an
approved `teardown` plans.

Per-step risk flags own extra confirmations, checked at apply time (`src/core/runner.ts:169-176`):

| Step risk | Meaning | Required flag |
| --- | --- | --- |
| `live` | live-mode payments, production data or a real account | `--confirm-live` |
| `dns` | creates or changes DNS records | `--confirm-dns` |
| `destroy` | deletes a resource golive created | `--confirm-destroy` |
| `spend` | would cost money | none: the step is refused outright |

A project's first production deploy also needs `--confirm-live`, because it is a live write to a
destination golive has never deployed.

## When a run stops

`apply` stops at the first condition below. Later steps do not run, and the next `apply` resumes at
that step: steps already done under the same approved content are skipped from recorded state
(`src/core/runner.ts:51-55`, `:100-110`). Paths in the table are `src/core/runner.ts`.

| Condition | Result |
| --- | --- |
| The release, plan or config schema changed since approval | refused before any step (`runner.ts:57-63`) |
| `--yes` is missing | refused before any step (`runner.ts:64`) |
| A write recorded under another or unknown release would be replayed | refused before any step, for reviewed reconciliation (`runner.ts:91-93`) |
| A prerequisite has no matching completed evidence for this plan | refused before any step (`runner.ts:95-97`), or `blocked` when a dependency has no completed record (`runner.ts:113-121`) |
| A step's confirmation flag is missing | `blocked`, run stops (`runner.ts:122-126`) |
| A handoff step's checks have not all passed | `blocked`, run stops (`runner.ts:127-137`) |
| A check fails | `failed`, run stops (`runner.ts:151-156`) |
| The step throws | `failed`, run stops (`runner.ts:159-164`) |

A provider that contradicts the approved intent fails the step: write steps re-read what they are about
to change and throw on a mismatch — a project that now resolves elsewhere (`src/links/projects.ts:123`),
DNS records that changed (`src/links/domain.ts:112`), a Stripe account or key that changed
(`src/adapters/stripe.ts:89`, `src/links/payments.ts:166`), a moved Vercel creation scope
(`src/adapters/vercel-project.ts:215`) or Supabase organization (`src/adapters/supabase.ts:487`).

## What it will never do

- No purchases, upgrades, plan changes, account signups or automated spend of any kind. `spend` steps
  are refused, adapters refuse billable operations (a Netlify team that is not Free, an exhausted
  free quota: `src/adapters/netlify-project.ts:32-33`), and their instructions to the human exclude
  purchase scopes (`src/adapters/godaddy.ts:26`). Domains, paid plans and capacity stay handoffs.
- No automatic rollback. A failed check never triggers one; `release:rollback` is opt-in, re-points
  production only to a deployment golive itself recorded, and runs only under its own approved plan
  (`src/links/release.ts:388-394`).
- No deletion of a resource it cannot prove it created. Teardown deletes only golive-created
  resources — the rest of its inventory is handoffs, never deletions — and DNS adapters refuse to
  delete a record without golive's own ownership marker
  (`src/core/teardown.ts:1-18`, `src/adapters/cloudflare.ts:428`, `src/adapters/porkbun.ts:265`,
  `src/adapters/godaddy.ts:274`).
- No telemetry. The only request that is not a provider call is the update check, a plain HTTPS GET
  of public release metadata (`src/core/update-check.ts:9`) with no credentials and no identifiers;
  `GOLIVE_UPDATE_CHECK=0` or `update-check --offline` disables it. Transport refuses every host
  outside the provider allowlist (`src/core/http.ts:9-22`, `:48-49`).

## The credential boundary

- golive reads a credential's value only in-process, at the moment it must send it to the provider.
  It never prints it, never passes it in argv, never writes it into a plan, state, report, log or
  error, and never returns it to the agent (`src/core/secret.ts:14-51`, `src/core/output.ts:8-16`).
- A value travels only to the provider that needs it: an HTTPS header or body
  (`src/core/http.ts:51-63`), a child process's stdin (`src/core/exec.ts:48-50`), or the child
  environment of the one vendor CLI that requires it (Vercel: `src/adapters/vercel.ts:111-116`). A
  secret offered in argv is refused (`src/core/exec.ts:20-22`).
- `Secret` values cannot leak by accident: every way of stringifying one yields a label and a short
  fingerprint, and the raw value comes out only through `reveal()` at a transport or private
  credential-write boundary. All golive output passes through `redact()`, which scrubs every
  registered value and known credential shape (`src/core/secret.ts:14-51`, `:80-92`,
  `src/core/output.ts:8-16`).
- `.golive/state.json` holds fingerprints, ids and step evidence, never a value
  (`src/core/runner.ts:192-202`, `src/core/state.ts:26-30`).
- The credentials file lives outside any repo (`~/.config/golive/credentials`; `GOLIVE_CREDENTIALS`
  and `XDG_CONFIG_HOME` are honoured) and is created and kept at mode 0600. Its setup refuses a
  symlink, a hard link, a non-regular file or a symlinked parent and never reads the file's bytes;
  `doctor` lists defined names, not values (`src/core/credentials.ts`: `setupCredentials`,
  `credentialsStatus`).
- On macOS, `credentials --prompt NAME` opens a native hidden-input dialog, saves the value locally
  and returns metadata only. It says it is not your Mac login password, and it never collects one
  (`src/core/credential-prompt.ts:109-118`).
- Ask for scoped keys rather than account-wide ones. golive's instructions ask for a Cloudflare token
  restricted to `Zone:DNS:Edit` plus `Zone:Zone:Read` on your zone (`src/adapters/cloudflare.ts:21-27`)
  and accept a restricted Stripe `rk_` key for golive's own calls, which is never copied into your app
  (`src/adapters/stripe-api.ts:9-15`). The Resend keys golive gives your app are `sending_access`,
  scoped to your domain and issued one per environment plus one for SMTP (`src/adapters/resend.ts:427-433`,
  `:141-144`); its own operator key needs full access, to create that domain and those keys.

## The honest boundary

**Enforced by code.** `apply` refuses without `--yes` and the approved plan id; risk confirmations are
evaluated per step at apply time, and a missing flag stops the run; step evidence, hashes and the
executing release are recorded, and a foreign or unknown record stops for reconciliation instead of
being replayed; credential values cannot reach golive's own stdout, stderr, state or reports.

**Only an instruction the agent is asked to follow.** None of the following is enforced:

- `--yes` and the `--confirm-*` flags are arguments the agent passes on the human's behalf. Nothing
  independently records who approved what: `.golive/state.json` records the plan id, step hash, time,
  changes and release, with no approver identity, signature or second factor, and any process that can
  run golive can pass the same flags.
- The agent must not paste credential values into chat or put them in argv; golive's redaction
  covers golive's output, not the agent's other tools.
- The agent must show the human the plan and get approval before `apply`. The mechanical refusals
  above are not proof that a human said yes.
- The agent's own pre-existing logins sit outside golive's gate. `vercel login`, `supabase login`,
  `netlify login` and `resend login` belong to the agent's shell, and golive reuses them where it can
  (the Vercel CLI session, and the Supabase and Netlify credential stores read in-process:
  `src/adapters/supabase-credentials.ts`, `src/adapters/netlify-credentials.ts`). An agent already
  logged in to your provider can write there with no golive plan, flag or state record; golive's
  controls govern golive's writes only.
- The credentials file is plaintext at mode 0600. It is not an OS keychain and it is not encrypted,
  so anything running as your user can read it; vendor logins and short-lived or scoped keys are
  better where you can use them.

## Taking access away

1. Remove golive's copy of a token: `golive credentials --remove NAME --yes` deletes that one entry
   from the credentials file — irreversibly, hence the flag — and leaves every other entry, comment
   and line ending in place; `doctor` then reports the credential as missing.
2. Revoke the token at the provider. This is the step that actually ends access: a revoked token
   fails the next read, and golive reports that rather than retrying blind
   (`src/adapters/cloudflare.ts:83-88`, `src/adapters/resend.ts:93-94`,
   `src/adapters/stripe-api.ts:166-169`).
3. Uninstall the skill through whatever installed it. That stops the agent running golive; it does
   not revoke tokens and does not delete local files. The credentials file and the `.golive/` files
   listed in [distribution and updates](DISTRIBUTION.md#fresh-installations-and-local-data) stay.
4. Know what `status` cannot see. `golive status` compares recorded baselines with reads taken now
   and writes nothing, has no credential list, and cannot report that a credential was revoked: a
   revoked token shows up only as a read that failed, reported as unread rather than as drift
   (`src/core/drift.ts:218-231`), and it cannot tell a revoked credential from a deleted resource or
   a network problem (`src/core/drift.ts:825`). A sending key golive issued to your app can never be
   re-read at all, because the provider offers issue and revoke only
   (`src/core/drift.ts:161-163`). Use `golive doctor` for "is this credential still accepted", and
   the provider's own dashboard for what exists.
