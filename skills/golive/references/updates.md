# Release integrity, installation ownership and updates

Run `node <this-skill-dir>/scripts/golive.mjs version --json` when starting a new deployment run.
It verifies the complete skill against `release.json`, including instructions, references and
runtime. A missing/mixed/corrupt bundle stops before account access. Repair it using the same
installation manager; do not download just a replacement script.

Then run `node <this-skill-dir>/scripts/golive.mjs update-check --json`. This reads only public
release metadata, uses a 24-hour cache and a bounded timeout, and never reads project credentials.
An unavailable/offline result does not block deployment commands. Set `GOLIVE_UPDATE_CHECK=0` or
pass `--offline` to skip the network check. Explain current/latest versions only when useful;
do not repeatedly announce an unchanged result.

## One manager per installed copy

- Skills CLI owns installations it made. Use `npx skills update golive -p` for project scope or
  `-g` for global scope, between runs. A pinned source stays pinned until explicitly changed.
- Plugins use their plugin manager. Never edit plugin caches or lockfiles directly.
- Manual copies are replaced as a complete verified bundle by the user.
- The optional own installer manages only its own receipt-backed copies. Run
  `node <this-skill-dir>/scripts/install-cli.mjs install-status --json` to inspect one. It reports
  duplicates without deleting them. An external copy is never adopted or overwritten implicitly.

## Own installer commands

At a new run boundary, an owned installation can explicitly update to an immutable public tag:

```bash
node <this-skill-dir>/scripts/install-cli.mjs update --between-runs --ref v<version> --json
node <this-skill-dir>/scripts/install-cli.mjs rollback --json
node <this-skill-dir>/scripts/install-cli.mjs update-policy --auto on --json
node <this-skill-dir>/scripts/install-cli.mjs update-policy --auto off --json
```

Automatic replacement is off by default. Only after the user opts in, when `update-check` reports
`manager: owned`, `automaticInstall: true`, `status: available` and a valid `latest.source.ref`,
the agent may invoke `update --auto --between-runs --ref <that-exact-tag> --json` at the start of a
new run. Reload the entire skill and verify its new version afterward. This is startup-driven
automation, not a background daemon. Pinned copies never auto-update.

Updates stage the complete bundle, verify every file and run offline smoke checks before switching
the active pointer. The previous version is retained for local rollback. A failed/stopped update
keeps the prior active version; a stale lock requires the explicit `recover-lock` command after
confirming the original process has stopped. Never remove installation metadata by hand to bypass
a refusal. These operations do not change app config/state, credentials or cloud resources.
Rolling back the skill does not roll back a deployment or database.

## Approval and resume boundary

Never install an update between `plan` → human approval → `apply`. Plans bind the verified release
and schema versions. After any bundle change, discard the old approval, re-observe with `plan`,
show the new plan and obtain a fresh approval. No old runtime is fetched to make approval pass.

Compatible state keeps resource IDs, fingerprints and evidence. Identical completed operations
remain completed. Changed, failed or ambiguous historical writes may require reconciliation;
do not delete state or force replays to get past that guard. Incompatible schemas stop safely.
There is no general reconciliation command yet. Explain the blocked operation and prepare a
separately reviewed recovery after inspecting the provider; do not promise automatic recovery.
Existing private golive deployments are not automatically migrated to a differently named product.
