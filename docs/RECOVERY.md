# When something goes wrong — stop, recover, roll back, remove

Recovery for a run that stopped, a production that looks broken, and a stack that has to come down.
Every command below is a real one and every limit is in the code; [architecture](ARCHITECTURE.md) is
the contract and [validation](VALIDATION.md) records what has actually been exercised live.

## The run stopped

Read what happened before changing anything.

- The `apply` output names the failing step, the error and a `next` line (`--json` gives the same as
  structured data). `.golive/state.json` holds the durable record: `steps.<id>` carries `status`, `at`,
  `planId`, the `release` that wrote it, the `hash` of what was approved, `changes` and `error`.
- `.golive/report.json` and `GOLIVE_REPORT.md` are written by `golive verify` and describe that
  invocation's checks only (status, severity, evidence, fix) plus open handoffs. If `verify` has not
  run since the failure, they say nothing about it.
- `golive status` answers the other question: has anything changed behind golive's back since it
  recorded what it did. It compares recorded baselines with reads taken now and writes nothing — no
  report file, no provider write, no state change, no billing read. Exit code 2 means something to act
  on; `notChecked` lists the subjects it could not read, and those are not a clean bill of health.
- `golive status` is deliberately not a gate: `plan`, `apply` and `verify` never consult it, because a
  comparison that needs an unapproved decision would deadlock a legitimate intent.

Then resume correctly:

- `golive apply --plan <planId> --yes` skips a step state records as `done` whose approved content
  still matches. A step's identity is a hash of its preview text, intent, destination, risk and
  dependencies, so changed content means a changed hash and the step runs again.
- If the world moved far enough that the plan no longer rebuilds to the approved `planId`, apply
  refuses: re-observe with `golive plan`, show the new plan and get a fresh approval.
- A write recorded under a different release stops instead of being replayed. A step whose record
  belongs to another (or an unknown) release is refused unless the step itself declares the exemption:
  a deletion (`risk.destroy`, which re-checks ownership and is idempotent) or a write that declares
  `risk.replayable`. A production re-point declares neither, so one approved under an older release is
  refused rather than repeated.
- `golive status` names that case as `release:step:<id>` with `action: human` — including when the
  current plan no longer carries the step at all — and says there that re-running `apply` cannot fix
  it.
- Do not clear `.golive/state.json` (or delete installation metadata) to force a retry. Inspect the
  provider for what the write actually did, then prepare a separately reviewed recovery; there is no
  general reconciliation command. The same boundary is written for the agent in
  `skills/golive/references/updates.md`.

## Rollback, exactly as it is

`release.rollback: true` in `golive.yaml` (with `production` in `targets`) plans one step,
`release:rollback`, that re-points production at an earlier deployment **golive itself recorded**.

- The target comes from golive's own record only: `.golive/state.json` holds `deployed:history` (the
  last 8 deployment identities, newest first) and `deployed:production:id`. A deployment built by a
  dashboard, a Git push or a pull request is not in that record and is never a rollback target.
- It is never automatic. No failed check triggers a rollback; golive plans one only while the opt-in
  is set and an earlier recorded production deployment exists.
- Approval is the plan: the step preview names the deployment id and URL, what production serves now
  and the times golive recorded them. Run it with `golive apply --plan <planId> --yes`; there is no
  `--confirm-promote` or `--confirm-rollback`, because the plan id is the binding.
- Before writing, the step re-reads that exact deployment by the provider's own id and what
  production serves now. It fails with nothing written when the provider cannot answer either read or
  when the deployment is gone or not ready; when production already serves the target it is a no-op —
  nothing is written and no release is recorded.
- After writing, it re-reads production and records nothing unless the provider reports the target as
  what it serves. The `production-release` check re-reads that same record later:
  `golive verify --only production-release`.
- Once golive has rolled production back, a later plan reports that instead of planning the same
  rollback again. Remove `release.rollback` when production is where it should be.
- **Netlify** supports both re-points (a published-deploy read and a restore call). **Vercel** cannot
  answer what production serves and has no exercised re-point (`src/adapters/vercel.ts`), so golive
  plans no rollback there and says why — production is corrected in Vercel's dashboard. Per-host
  table: [providers](PROVIDERS.md#opt-in-promotion-and-rollback).
- Promotion and rollback are implemented and mock-covered, **not live-validated**: no provider run has
  performed a production re-point yet.

## Production looks broken right now

1. Confirm what production serves from the provider, not from the URL:
   `golive verify --only production-release` re-reads the recorded release against the host's own read
   of production. It needs a release golive recorded (`deployed:release` in state); if there is none,
   or the host cannot answer that read (Vercel), the check skips with the reason and the provider's
   dashboard or CLI is the only path. `golive status` shows the rest of the recorded picture — host
   project, env names, DNS records, webhooks, sending domain, payment account — read-only.
2. Decide whether an earlier golive-recorded deployment is the right target: read `deployed:history`
   in `.golive/state.json`. If the build you want came from a dashboard, a Git push or a pull request,
   golive cannot roll back to it, and that provider's dashboard is the only path.
3. Plan and approve the rollback: set `release.rollback: true`, run `golive plan`, read the
   `release:rollback` preview (target deployment, what production serves now, both recorded times),
   then `golive apply --plan <planId> --yes`.
4. Prove it by re-reading: the step re-reads production after the write and records what it serves,
   and `golive verify --only production-release` re-proves it afterwards. A failure there means
   production moved again and needs a fresh decision.

## What has no inverse

Some of what golive writes cannot be rolled back, only re-applied or removed. `golive status` names
the item and its action — the two that matter here are `reconcile` (an approved `plan` then `apply`
restores it) and `human` (only you can act) — and, where one exists, the check that re-establishes the
fact (`golive verify --only <checkId>`).

| Recorded thing | Put it back | Take it away |
| --- | --- | --- |
| DNS records | `golive plan`, approve, `golive apply --plan <id> --yes --confirm-dns` re-upserts the records the plan declares | `golive teardown` removes the records the DNS provider itself reports as golive-owned (that apply needs `--confirm-dns` and `--confirm-destroy`) |
| Environment variables | an approved `env:<target>` step rewrites a name golive manages that the host no longer lists; a name someone else set is never touched | nothing: golive has no env removal. Delete the name in the host's dashboard |
| Auth settings (policy, redirects) | `auth:settings` — planned when `golive.yaml` names an auth policy — re-reads the project and writes what the config asks for; `auth:redirects` does the same for the allowlisted URLs | nothing to restore: golive stores no previous policy or allowlist value, so an old setting can only come back from the provider's dashboard |
| Database data | nothing: golive keeps no backup and performs no restore (the ownership document lists provider backup retention as a recurring manual job) | only by deleting the whole project, which is a manual handoff — see below |

## Removing the stack

`golive teardown` is the inverse plan, and it has its own approval and confirmation:

```bash
golive teardown                                        # prints a planId; nothing is deleted
golive apply --plan <planId> --yes --confirm-destroy
```

- It removes only what golive can prove it created: the host project whose recorded creation marker
  matches, DNS records the DNS provider lists as golive-owned, webhook endpoints and sending keys
  recorded in state. An adopted project, a record golive did not write and a resource of a signed-out
  provider are left alone.
- Nothing golive cannot remove is dropped silently: every leftover is named as a handoff saying what
  it is, why golive will not remove it and where to remove it by hand. Supabase and Neon projects and
  the Resend sending domain always end up there. Read the teardown plan's `handoffs` and `golive
  handoff` before reporting a stack gone.
- It re-reads after deleting: the DNS zone's golive-owned record list and the host's own project read.
  A host golive cannot re-read after the delete warns instead of claiming success, and a URL fetch is
  not deletion evidence — a stale edge cache can still answer 200 while the provider already reports
  the project gone.
- Deleting the host project also forgets its deploy facts (`deployed:*`), so no later rollback can
  name a deployment of a project golive no longer has.
- Rolling the skill itself back (`node <this-skill-dir>/scripts/install-cli.mjs rollback --json`)
  replaces only the installed copy: it does not roll back a deployment or a database, and it touches
  no app config, state, credential or cloud resource. See [distribution](DISTRIBUTION.md).
