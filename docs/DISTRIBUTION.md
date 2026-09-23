# GoLive distribution and updates

GoLive is the project name; `golive` is the skill name, and the repository is
[`mikehasa/golive-skill`](https://github.com/mikehasa/golive-skill).

The current alpha is `0.1.0-alpha.1`. GitHub installation does not depend on our npm package.
See [validation](VALIDATION.md) for tested capabilities and remaining channel acceptance.

## Default installation: GitHub through Skills CLI

We recommend global installation so GoLive is available across projects. Run from any directory:

```bash
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global
```

The explicit `--global` selects user-wide installation. To install only in one project, run from
that project's repository and omit `--global`; project scope is the Skills CLI default when the
flag is absent. Add `--agent codex --yes` or `--agent claude-code --yes` to skip the agent picker.
Without those flags, select your agent with the arrow keys and Space, then press Enter to continue.
Users need Node 20+, npm/npx and Git, but do not need the source checkout or TypeScript dependencies
after installation. Reload skills or start
another agent session, then verify `node <installed-skill>/scripts/golive.mjs version --json`.

Update between deployment runs:

```bash
npx skills update golive -g
```

For a project-only installation, run `npx skills update golive -p` inside that project instead.
A pinned tag is changed explicitly, not silently advanced. A clone alone is not installation:
use Skills CLI on the clone or copy
its complete `skills/golive` folder into the appropriate agent skill directory and verify it.
Skills CLI has its own telemetry policy; GoLive has no product telemetry.

## One version and complete bundle integrity

`package.json` supplies the product version. Build produces the bundled CLI, standalone installer
helpers and `skills/golive/release.json`. The
manifest contains version/name, public source, supported Node range, config/state/approval schemas,
file hashes and a canonical bundle digest. It excludes itself from the file hashes. LICENSE and
third-party notices accompany the bundled YAML parser.

Development manifests have `source.ref: null`. A release build uses `GOLIVE_RELEASE_REF=v<version>`
for the published candidate; the tag must exactly match the package version.
It never derives a public source revision from private Git history. A checksum establishes internal
consistency, not independent publisher authenticity; the trusted public source remains essential.

Every runtime command checks the entire file set and all hashes before project/provider access.
Missing files, unexpected files, symlinks inside the bundle or mismatched instructions/runtime
stop with a complete-bundle repair message. Do not hand-edit a generated CLI or install one script
under older instructions. Rebuild after changing the source, instructions or references.

## Checking versus installing updates

`version --json` includes the verified release identity. `update-check --json` reads the fixed
public release manifest, caches successful metadata for 24 hours and has a three-second deadline.
It does not construct a provider context, use provider tokens, or read app credentials. Offline,
missing or invalid public metadata returns `unavailable` without breaking offline commands.
`--offline` or `GOLIVE_UPDATE_CHECK=0` disables checking.

The skill invokes the check at the start of a deployment run. Checking is enabled by default;
replacement is off by default. There is no daemon. The result names the current/latest release,
installation ownership and applicable update instructions.

| Installation | Update owner |
| --- | --- |
| Skills CLI | Skills CLI; GoLive never edits its locks/caches |
| Agent plugin | That plugin manager |
| Manual copy | User replaces the complete verified bundle |
| Own installer | Our explicit whole-bundle update/rollback flow |

Externally managed copies are not adopted or deleted automatically. Deliberate per-project pins
may coexist. Installation status reports duplicates and leaves them unchanged.

## Optional own installer

The zero-dependency entrypoint is `bin/golive.mjs`. The npm `files` allowlist includes the
wrapper, standalone installer and complete
skill with licenses. The own installer's Claude flag is `claude`, unlike Skills CLI's `claude-code`.

```bash
node bin/golive.mjs install --agent codex --global
node bin/golive.mjs install --agent claude --global
node bin/golive.mjs install-status --agent codex --global --json
```

An own installation has a receipt-backed immutable bundle in an adjacent private store and an
atomic active pointer. Metadata records manager/channel, public source, version/ref, destination,
pin, automatic-update preference and previous version. External copies and unexpected symlink
layouts are refused. After installation the skill carries its own updater; it does not depend on
an npm cache or the source checkout remaining present.

At a new run boundary, an owned copy supports:

```bash
node <installed-skill>/scripts/install-cli.mjs update --between-runs --ref v<version> --json
node <installed-skill>/scripts/install-cli.mjs rollback --json
node <installed-skill>/scripts/install-cli.mjs update-policy --auto on --json
node <installed-skill>/scripts/install-cli.mjs update-policy --auto off --json
```

An explicit `--from <complete-bundle>` supports local/offline installation or update. Online
updates use a selected immutable version tag under the fixed public repository. Redirects,
unsafe paths, incompatible metadata, oversized downloads and wrong hashes are refused. No
provider credentials are used. New content is staged, verified and smoke-tested offline before
the active pointer changes. Concurrent updates are locked and the prior bundle is retained.

When the user opts in, the skill may execute `update --auto --between-runs --ref <latest-tag>`
only at startup after a successful metadata check. Pinned installations do not auto-update;
automatic updates do not downgrade. Failure/interruption preserves the old active copy or refuses
an incomplete operation. `recover-lock` handles a stopped updater explicitly; it must not bypass
an active or uncertain owner. Rollback switches the local bundle, not cloud infrastructure.
Installation/update/rollback never alter app configuration, deployment state or credentials.
The own manager's directory-symlink switch has been tested on macOS/POSIX; Windows installation
and symlink privileges remain unverified and are not a claimed supported channel for this alpha.

## Plans and preserved state

Plan identity includes the executing release, bundle digest and schema versions, as well as
approved actions. `apply` compares those before any step runs. Upgrading invalidates an old
approval even if the preview looks the same; re-observe, generate a new plan and obtain approval.
No old runtime is downloaded to make a stale approval work.

Compatible state retains resource IDs, fingerprints and execution evidence. Identical completed
writes stay completed; changed, failed or ambiguous historical operations stop for reconciliation
instead of being replayed blindly. Unknown/incompatible schema versions stop without clearing
state. Earlier development installations, credentials and cloud ownership are not migrated into GoLive.
There is no general reconciliation command yet: an ambiguous historical write may need manual
provider inspection and a separately reviewed recovery. An update is not a promise that every
interrupted run from an older release can resume automatically.

## Fresh installations and local data

This source and skill use `golive`: `skills/golive/`, `bin/golive.mjs`, `golive.yaml`,
`.golive/state.json`, `.golive/report.json`, `GOLIVE_REPORT.md` and `~/.config/golive/credentials`.
`GOLIVE_CREDENTIALS` selects an explicit credentials file; `XDG_CONFIG_HOME` is supported.
Provider-defined variable names do not change.

Earlier development installations are not migrated automatically. Do not copy old state,
credentials or cloud ownership records to renamed paths as a substitute for migration. Preserve
existing installations until a separately reviewed migration exists. Review resource IDs and
other non-secret metadata before sharing configuration, state or reports publicly.

## Releasing a version

Run the full mocked suite, typecheck and build. Use Node 24 for tests, Node 20 for the installed
runtime. Set `GOLIVE_RELEASE_REF=v<version>` for the release build, matching `package.json` exactly.
Review package contents, licenses and the full manifest. Verify isolated Codex/Claude installation,
version/help/menu/detect, offline checks and owned update/rollback on the actual artifact.

Keep live provider evidence separate from package acceptance. After publication, verify anonymous
clone, public Skills CLI installation and tagged downloads before marking that channel available.
CI tests the already-renamed source and its generated artifacts; it does not rename it again.

## Renaming a source fork

The optional `scripts/rename.sh <new-name> <old-name>` helper is for maintainers, not installation
or migration. Pass both names explicitly for a fork of this already-renamed source. Preview first;
`--apply` changes inventoried source files and removes generated artifacts for rebuilding. It does
not change credentials, app state, Git remotes or cloud resources. Preserve historical evidence.
Review CI old-name exclusion guards independently; indiscriminate replacement can invert them.

## References

- [Agent Skills specification](https://agentskills.io/specification)
- [Skills CLI](https://github.com/vercel-labs/skills)
- [Provider scope](PROVIDERS.md)
- [Validation scope](VALIDATION.md)
