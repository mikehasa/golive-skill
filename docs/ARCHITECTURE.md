# Architecture

GoLive combines an Agent Skill with a bundled Node CLI. The agent handles the conversation and
approvals; the CLI performs provider operations, carries secrets internally and records evidence.
The runtime has no external package dependencies. Provider access uses vendor CLIs and HTTPS APIs;
no MCP server is required. See [validation](VALIDATION.md) for what has actually been exercised.

## Execution flow

```text
detect → choose missing providers → connect accounts → plan → approve → apply → verify → report
```

`detect` scans the app, `menu` lists providers, `init` writes configuration, and `doctor` checks
access. `plan` observes destinations and returns steps and handoffs; `teardown` returns the inverse
plan of resources golive provably created. `apply` requires the approved plan identity and applicable
risk confirmations. `verify` produces check evidence; `handoff` lists what remains outside
automation, and `handoff --write` adds the ownership document (`GOLIVE_HANDOVER.md` and
`.golive/handover.json`) from recorded state, cheap provider reads and the same inventory teardown
uses. Guided or skipped work is not treated as verified success. `status` answers a different
question — what changed behind golive's back since it recorded what it did — by comparing recorded
baselines with reads taken now, and writes nothing.

## Drift, checks and the recorded baseline

A check proves that something holds now, and its report is release evidence. Drift asks whether the
world still matches what golive recorded, which needs the recorded side: `.golive/state.json` (the DNS
record baselines golive wrote, env names and fingerprints, resource ids and markers, step evidence) or
a marker the provider itself assigned. `golive status` runs those comparisons read-only: no report
file, no provider write, no state change, no billing endpoint. A failed step it finds is compared with
the plan this release would run now — observed through a state view that drops adapter caches, never
applied — because whether `apply` could replay that write at all turns on what the step declares.

Every item pairs `expected (recorded by golive <time>)` with `observed (read now)`. Severity says what
a difference means: high = the app is broken (a record deleted, an endpoint gone, a domain detached, a
project unreadable); medium = hygiene or teardown safety, or a change that may be deliberate and is
worded that way; info = nothing to act on (still propagating). `action` says who can act: `none`,
`verify` (an existing check re-establishes the fact), `reconcile` (an approved `plan` then `apply`
restores it, possibly needing `--confirm-dns`), or `human` (only the human can act — e.g. a failed
step recorded by another release that `apply` refuses to replay, where the reviewed reconciliation
path has to come first). A provider that cannot be read yields `unverifiable: true` with
`action: 'none'` and is listed in `notChecked` — never drift, and never reported as clean. Nothing is
re-baselined silently: only a new approved write moves a baseline.

Drift is deliberately not a gate. `plan`, `apply` and `verify` never consult it, because a comparison
that needs an unapproved decision would deadlock a legitimate intent. A freshly written DNS record may
legitimately differ from public DNS for minutes, so the checks' existing propagation window governs it:
a public difference inside that window is `info`, and public DNS is only compared when the zone itself
still matches the baseline. `handoff --write` records what golive created; `status` re-checks it, and
neither claims the other's coverage.

## The opt-in preview and its release gate

With `release.preview: true` in `golive.yaml` (and `preview` in `targets`), `plan` emits two more steps
at the end of the plan. `preview:deploy` is a CREATE — `kind: 'deploy'`, `risk: { writes: true }`, never
`replayable` — that deploys the current working tree to the host's preview target, depends on the host
project and `env:preview`, and records the provider's own identity as `deployed:preview:id` (the same
shape production records; teardown forgets it with the project's other deploy facts). Its preview names
what the approval covers: provider and project, the branch/working tree it deploys (both hosts build
what is on disk, not a commit), the env target, the preview URL the provider reports per deployment,
and whether the preview shares production's sources — golive fills preview env from the same db/auth
project as production, so a preview reads and writes production's data — plus `--confirm-live` when a
live-mode source (recorded in state, or written by this plan) fills a preview env name.

`release:check` writes nothing (`risk: { writes: false }`) and depends on that deploy. It runs two
checks as its inline verification: `preview-deploy` (the hosting provider's own read confirms the
recorded deployment is ready, belongs to the project golive links, and is not the production
deployment) and `preview-bundle` (the credential scan of the provider-confirmed preview URL, reusing
the production scanner and its exact-host allowlist). A failing check fails the step, and the runner
stops the plan there: that is the gate. Neither check invents a read: a host that exposes no
per-deployment preview read (Vercel, whose preview URLs are also protected by default) makes them skip
with that reason, a 401/403 wall on a preview skips the scan, and neither is ever a pass. Both step ids
are part of a plan's identity, so an approval that was not applied has to be re-planned.

## Promotion and rollback

`release.promote: true` (on top of `release.preview`) asks for a release by promotion; `release.rollback: true`
asks for a rollback and needs no preview opt-in. The two are mutually exclusive — planning a release and a
rollback of the same app in one plan would contradict each other — and when both are set golive plans
neither and says why. Both are **implemented and mock-covered, not live-validated**.

A provider reports a deployment's own id only once the deployment is made, so the plan that can *name*
the deployment it promotes is a different plan from the one that deploys it. With the promotion opt-in
set, a plan is one of the two halves, and the preview line says which:

- **cut**: `preview:deploy` + `release:check` — a new candidate for the next plan to promote;
- **release**: `release:check` (re-reading the recorded candidate) + `promote:production`.

`promote:production` (`kind: 'deploy'`, `risk: { writes: true }`, `dependsOn: ['release:check']`) names the
exact deployment in its preview: the provider's own id and URL, when golive recorded it, the env target it
was built for, what production serves before, the gate, and that production will change. There is no
`--confirm-promote` and no new category flag — the plan id, the named deployment and the dependency on the
gate do the gating. Its `run` re-reads the target deployment and what production serves *before* writing,
refuses when the provider cannot answer either read (or when the deployment is gone or not ready) rather
than acting blind, then re-reads production *after* the write and refuses to record anything unless the
provider reports the promoted deployment as what it serves. Production already serving the target is a
no-op: nothing is written and no release is recorded.

`release:rollback` (`kind: 'deploy'`, `risk: { writes: true }`) re-points production at an earlier
deployment golive itself recorded (`deployed:history`), and never at a deployment golive did not create:
what a dashboard, a Git push or a pull request built stays with that provider. It is deliberately neither
`destroy` (nothing is deleted, and that exemption is for golive's own removals) nor `replayable` (a
production re-point keeps the cross-release reconciliation stop), and it is never automatic — no failed
check triggers a rollback. Once golive has rolled production back, a later plan reports that instead of
planning the same rollback again.

`production-release` proves the outcome against the provider: it re-reads the recorded release
(`deployed:release`) and what the host says production serves, and names what production served before. A
host that cannot answer that read skips with the reason; production serving another deployment golive
recorded fails; production serving a deployment golive never recorded warns and names the handoff.

Hosts differ, and where one cannot support a step golive refuses rather than faking it. **Netlify** can
re-read its published deployment (`published_deploy`) and restore an earlier one
(`POST /sites/{site_id}/deploys/{deploy_id}/restore`), so both steps work there. **Vercel's** adapter has
no read of which deployment production serves (only aliases) and no promote/rollback call golive has
exercised, so on Vercel nothing is promoted or rolled back: the preview steps still run, and a warning
names the missing capability. See [provider scope](PROVIDERS.md) for the per-host table.

## Adapters, capabilities and links

An adapter speaks to a provider and exposes capabilities such as `EnvStore`, `PublicUrl`,
`DomainAttach`, `DnsZone`, `DbAdmin`, `DbConnection`, `AuthConfig`, `AuthUsers`, `WebhookRegistry`,
`SendingDomain`, `Deployer` and `ReleaseControl`. Links compose those capabilities, for example
database output → hosting env or hosting URL → auth redirects. A new adapter does not need a separate
recipe for every pairing.

`Deployer` answers with the URL of the deployment it made plus, when the provider reports one, the
provider's own identity for that deployment (the id in Vercel's deploy output; the deployment
Netlify confirms). golive records both in `.golive/state.json`: the `deployed:<target>` time marker
and, when there is one, the identity as `deployed:<target>:id` = `<provider>|<deployment id>|<url>|<time>`.
An id derived from the URL would name nothing a promotion or rollback could act on, so a provider
that cannot report one leaves it unset. Every recorded identity also enters `deployed:history` (bounded,
newest first), which is where a rollback takes its target from. `ReleaseControl` is the write side of
that record: an adapter that exposes it can re-read what production serves, re-read one deployment by
the id golive recorded, and re-point production at one. An adapter without it (Vercel) is skipped
with that reason. Preview deployments, the release check that gates them, promotion and rollback are
opt-in (`release` in `golive.yaml`) and described above.

| Source | Responsibility |
| --- | --- |
| `src/core/types.ts` | Adapter, capability, step, plan, state and report contracts |
| `src/core/drift.ts` | Recorded baselines vs reads taken now: the `status` model and its comparisons (read-only) |
| `src/adapters/` | Provider transport, observation and operations |
| `src/links/` | Destination selection and approved cross-provider changes |
| `src/checks/` | Verification with explicit pass/fail/warn/skip outcomes |
| `src/detect/` | Local framework, provider and environment-name detection |
| `src/handover/` | The ownership document's data: accounts, created resources and their proofs, what is manual |
| `src/report/` | Human-readable results |
| `skills/golive/` | Installable instructions, references and generated runtime |

Use the actual TypeScript interfaces as the implementation contract. Exposing a capability does
not prove that every provider pairing or application framework has passed a live test.

## Approval and recovery

Plan identity covers the executing release, previews, secret-free intent, risk and dependencies.
The approved destination is rechecked before writes. Changes require re-observation, a new plan
and fresh approval. DNS and live-payment writes require their additional confirmation gates;
purchases and account creation remain human tasks.

Compatible completed steps can be skipped when their identity and evidence still match. Resource
IDs, fingerprints and operation records survive interruptions. Unknown schema versions or ambiguous
historical writes stop for reviewed recovery; two exemptions are declared by the step itself and
resume instead. Destruction steps are exempt: a deletion re-checks ownership and is idempotent; DNS
records and webhooks re-read the proof from the provider, while a host project relies on its recorded
creation marker and re-reads the project after deleting it. So is a step whose risk declares
`replayable`: the same bar, asserted by an author for a write that re-observes the provider and
golive's own recorded resource before acting (the `auth:test-user` password rotation, which re-reads
the account state names; the `auth:recovery` rotation, which re-reads the recorded account and its
provider state before it asks for a recovery link; and the `auth:isolation` second-account seed or
rotation, which re-reads its own recorded account and the provider's state for it before writing).
A production re-point (`promote:production`, `release:rollback`) declares neither: it keeps the stop,
so a re-point approved under an older release is refused and reconciled rather than repeated. Nothing
else is replayed automatically.
`teardown` removes only proven golive-created resources under its own approval and confirmation gate;
there is no automatic cross-provider rollback, restore or general reconciliation command for those
resources — the opt-in `release:rollback` re-points production at an earlier deployment golive itself
recorded and touches no data, DNS, payment or email resource. Its
read-only inventory (`src/core/inventory.ts`) is shared with the handover document, so what a teardown
would remove and what the owner is told are one list. Do not clear state to force a retry.

Provider-specific adapters handle uncertain creation results; non-idempotent writes must not be
blindly repeated after a timeout. A successful API response is followed by the relevant observation
or check before the operation is reported as verified.

## Secret and network boundaries

Credential values enter `Secret` wrappers and stay inside execution code. Use `secretJson` or
`revealDeep` only at the transport boundary. Do not place values in argv, errors, plan previews,
state, reports or agent context. Use the existing provider transport rather than inventing a shell
command that exposes a token. Some vendor CLIs receive credentials through their supported child
environment; other operations use stdin or HTTPS headers/bodies.

Prefer supported vendor logins; interactive login belongs in the human's separate terminal window.
When a token is needed on macOS, `credentials --prompt NAME` opens a native hidden-input dialog.
The local process captures the value privately, saves it in the credentials file and returns only
metadata. The dialog explains its purpose and local plaintext storage; it does not collect a Mac
login password. Actual Keychain/vendor system authorization remains with the OS or vendor login.
The fallback credentials file is outside the app repo and can be edited by the human. Setup creates
missing directories and an empty file, preserving existing contents. Neither the agent nor logs
should read back the values. Cancelling token entry preserves existing credentials; saving a token
does not establish provider access until the account check passes.

Network access is restricted to approved provider API hosts and validated provider-returned
endpoints. Active app probes, such as webhook rejection and JavaScript scanning, require the selected host
to confirm the deployment URL. The separate domain-live check can perform read-only DNS/HTTPS
checks against the configured domain; that does not authorize active app probes at arbitrary URLs.

## Local files and releases

`golive.yaml` holds provider choices and non-secret configuration. `.golive/state.json` holds
resource IDs, fingerprints and step evidence, including one machine-readable baseline per DNS record
golive wrote under the documented key `dns:<zone>|<type>|<name>` (record values are public DNS data,
never credentials), the deployment identity of the last successful deploy per target under
`deployed:<target>:id`, the bounded trail of deployment identities golive recorded under
`deployed:history` (the last 8: `target`, `provider`, `id`, `url`, `time`, `production`) and the last production
re-point golive performed under `deployed:release` (`kind|provider|id|url|displaced|<time>`, where
`kind` is `promote` or `rollback`). All three are deploy facts of the host project: removing that
project forgets them (`forgetDeployFacts`), so a later rollback can never name a deployment of a
project golive no longer has. Everything there is secret-free: provider ids, deployment ids, URLs and
times. `.golive/report.json` and `GOLIVE_REPORT.md` hold verification results and
outstanding work. `.golive/handover.json` and `GOLIVE_HANDOVER.md` hold the
ownership document: what golive provably created, the accounts and login route, what is manual, what
recurs and how removal works, each row tagged by how it was checked. Review these files before
sharing them: secret-free metadata can still identify private resources. They are not credentials or
a cloud rollback plan.

A build creates `skills/golive/release.json` covering the instructions, references, runtime,
installer helpers and licenses. Runtime integrity is checked before account access. Plans bind
the release identity so an update cannot silently reuse old approval. See
[distribution and updates](DISTRIBUTION.md) for manager ownership, pins and local rollback.

## Contributor checks

Run mocked tests, TypeScript and build with Node 24. Test the installed, source-independent runtime
on Node 20. New provider behavior needs mock regression coverage using `test/helpers.ts` and
`test/fakes.ts`; tests must not access provider accounts. Live validation uses separately approved
throwaway resources and records scope and limitations in [VALIDATION.md](VALIDATION.md).
