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
automation. Guided or skipped work is not treated as verified success.

## Adapters, capabilities and links

An adapter speaks to a provider and exposes capabilities such as `EnvStore`, `PublicUrl`,
`DomainAttach`, `DnsZone`, `DbAdmin`, `DbConnection`, `AuthConfig`, `WebhookRegistry` and
`SendingDomain`. Links compose those capabilities, for example database output → hosting env or
hosting URL → auth redirects. A new adapter does not need a separate recipe for every pairing.

| Source | Responsibility |
| --- | --- |
| `src/core/types.ts` | Adapter, capability, step, plan, state and report contracts |
| `src/adapters/` | Provider transport, observation and operations |
| `src/links/` | Destination selection and approved cross-provider changes |
| `src/checks/` | Verification with explicit pass/fail/warn/skip outcomes |
| `src/detect/` | Local framework, provider and environment-name detection |
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
host project relies on its recorded creation marker). `teardown` removes only proven golive-created
resources under its own approval and confirmation gate; there is no automatic cross-provider rollback,
restore or general reconciliation command. Do not clear state to force a retry.

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
resource IDs, fingerprints and step evidence. `.golive/report.json` and `GOLIVE_REPORT.md` hold
verification results and outstanding work. Review these files before sharing them: secret-free
metadata can still identify private resources. They are not credentials or a cloud rollback plan.

A build creates `skills/golive/release.json` covering the instructions, references, runtime,
installer helpers and licenses. Runtime integrity is checked before account access. Plans bind
the release identity so an update cannot silently reuse old approval. See
[distribution and updates](DISTRIBUTION.md) for manager ownership, pins and local rollback.

## Contributor checks

Run mocked tests, TypeScript and build with Node 24. Test the installed, source-independent runtime
on Node 20. New provider behavior needs mock regression coverage using `test/helpers.ts` and
`test/fakes.ts`; tests must not access provider accounts. Live validation uses separately approved
throwaway resources and records scope and limitations in [VALIDATION.md](VALIDATION.md).
