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
file, no provider write, no state change, no billing endpoint.

Every item pairs `expected (recorded by golive <time>)` with `observed (read now)`. Severity says what
a difference means: high = the app is broken (a record deleted, an endpoint gone, a domain detached, a
project unreadable); medium = hygiene or teardown safety, or a change that may be deliberate and is
worded that way; info = nothing to act on (still propagating). `action` says who can act: `none`,
`verify` (an existing check re-establishes the fact), `reconcile` (an approved `plan` then `apply`
restores it, possibly needing `--confirm-dns`), or `human`. A provider that cannot be read yields
`unverifiable: true` with `action: 'none'` and is listed in `notChecked` — never drift, and never
reported as clean. Nothing is re-baselined silently: only a new approved write moves a baseline.

Drift is deliberately not a gate. `plan`, `apply` and `verify` never consult it, because a comparison
that needs an unapproved decision would deadlock a legitimate intent. A freshly written DNS record may
legitimately differ from public DNS for minutes, so the checks' existing propagation window governs it:
a public difference inside that window is `info`, and public DNS is only compared when the zone itself
still matches the baseline. `handoff --write` records what golive created; `status` re-checks it, and
neither claims the other's coverage.

## Adapters, capabilities and links

An adapter speaks to a provider and exposes capabilities such as `EnvStore`, `PublicUrl`,
`DomainAttach`, `DnsZone`, `DbAdmin`, `DbConnection`, `AuthConfig`, `AuthUsers`, `WebhookRegistry` and
`SendingDomain`. Links compose those capabilities, for example database output → hosting env or
hosting URL → auth redirects. A new adapter does not need a separate recipe for every pairing.

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
historical writes stop for reviewed recovery (destruction steps are exempt: a deletion re-checks
ownership and is idempotent; DNS records and webhooks re-read the proof from the provider, while a
host project relies on its recorded creation marker and re-reads the project after deleting it).
`teardown` removes only proven golive-created resources under its own approval and confirmation gate;
there is no automatic cross-provider rollback, restore or general reconciliation command. Its
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
never credentials). `.golive/report.json` and `GOLIVE_REPORT.md` hold verification results and
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
