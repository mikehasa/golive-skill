# GoLive distribution and updates

GoLive is the project name; `golive` is the skill name, and the repository is
[`mikehasa/golive-skill`](https://github.com/mikehasa/golive-skill).

The current alpha is `0.1.0-alpha.6`. Three installation channels are served: GitHub through Skills
CLI and the npm package, which both carry the release built from this repository, and ClawHub, the
OpenClaw registry, which is published separately (the earlier `0.1.0-alpha.0` snapshot remains a
separate version on the npm registry). GitHub installation works without npm.
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

## Alternative installation: the npm package

The registry serves `golive@0.1.0-alpha.6` under the `alpha` and `latest` dist-tags. The tarball
carries the zero-dependency wrapper (`bin/golive.mjs`), the standalone installer helpers
(`scripts/install-cli.mjs`, `scripts/install-lib.mjs`), the complete skill and the licenses, so it
installs the skill offline — without Git or the Skills CLI:

```bash
npx golive@alpha install --agent codex            # .agents/skills/golive in this project
npx golive@alpha install --agent claude           # .claude/skills/golive in this project
npx golive@alpha install --agent codex --global   # ~/.agents/skills/golive
```

This is the same installer as the [own installer](#optional-own-installer) below, entered through
npm instead of a checkout: it walks the complete bundled skill, refuses a symlinked parent or an
existing destination, and copies the bundle without touching provider accounts. Verify a copy from
either channel with `node <installed-skill>/scripts/golive.mjs version --json`. The wrapper also
exposes the bundled CLI: `npx golive@alpha help`, `version --json`, `detect --json`, `menu --json`,
and the workflow commands `init`, `doctor`, `plan`, `apply`, `verify` and `handoff`. `apply`
requires the approved plan ID and explicit confirmation.

**This channel matches the GitHub channel.** The registry serves the release published from this
repository (`0.1.0-alpha.6`), including the standalone installer helpers, so an npm installation is
an owned copy with the same update, pin and rollback flow as the
[own installer](#optional-own-installer). The earlier `0.1.0-alpha.0` snapshot predates the helpers
and has no updater: the installer refuses an existing destination, so updating such a copy means
removing it first, or switching to the Skills CLI channel, which manages its own installs. Both
`alpha` and `latest` point at the current alpha, so `npx golive` and `npx golive@alpha` resolve to
the same version.

## Third channel: ClawHub (the OpenClaw registry)

[ClawHub](https://clawhub.ai/mikehasa/skills/golive) is OpenClaw's public registry, and the skill is
listed there at the same version as the two channels above. It is a separate registry with its own
copy: publishing to it is a deliberate step of every release, not a mirror of GitHub. It installs
into the current directory rather than an agent's global skills directory, so it suits an OpenClaw
workspace; the clients this project verifies are served by the two channels above.

```bash
npx clawhub@latest install golive     # into ./skills here, recorded in .clawhub/lock.json
npx clawhub@latest update golive      # later updates stay with ClawHub
npx clawhub@latest skill verify golive  # the registry's own scan summary for the release
```

Publishing (maintainer, after the GitHub tag exists in step 3 of [releasing a version](#releasing-a-version)):

```bash
npx clawhub@latest skill publish skills/golive --slug golive --name GoLive \
  --version <version> --changelog "<what changed>"
```

Always pass `--version` and preview with `--dry-run` first: `skills/golive` carries no version field
of its own, so the CLI would otherwise publish `1.0.0` or the next patch and put the release
ordering out of step with the other channels.

ClawHub writes its own metadata *inside* the installed folder: `_meta.json`, `skill-card.md` and
`.clawhub/origin.json`. The runtime's bundle check and the standalone installer ignore exactly those
names — and nothing else. Without that tolerance every ClawHub copy reported itself as damaged, which
is why the check carries the exception (it is the only marketplace that does this today). Updates are
ClawHub's; nothing adopts that copy, and the own installer leaves it unchanged as an external copy.

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
| npm package (`npx golive@alpha install`) | Own installer, from `0.1.0-alpha.6`; a copy installed from `0.1.0-alpha.0` has no updater — remove it and reinstall, or move to the Skills CLI channel |
| ClawHub (`npx clawhub@latest install golive`) | ClawHub; `npx clawhub@latest update golive` |

Externally managed copies are not adopted or deleted automatically. Deliberate per-project pins
may coexist. Installation status reports duplicates and leaves them unchanged.

## Optional own installer

The zero-dependency entrypoint is `bin/golive.mjs`, also reachable through npm as
`npx golive@alpha install` above. The npm `files` allowlist in this repository includes the wrapper,
the standalone installer and the complete skill with licenses, and the published `0.1.0-alpha.6`
carries all of them. The own installer's Claude flag is `claude`; the Skills CLI's `claude-code` spelling is accepted as
well, so either works and both name `.claude/skills/golive`.

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
`.golive/state.json`, `.golive/report.json`, `GOLIVE_REPORT.md`, and — after `handoff --write` —
`.golive/handover.json` and `GOLIVE_HANDOVER.md`. Credentials live in `~/.config/golive/credentials`;
`golive credentials --remove NAME --yes` deletes one stored entry without reading its value.
`GOLIVE_CREDENTIALS` selects an explicit credentials file; `XDG_CONFIG_HOME` is supported.
Provider-defined variable names do not change.

Earlier development installations are not migrated automatically. Do not copy old state,
credentials or cloud ownership records to renamed paths as a substitute for migration. Preserve
existing installations until a separately reviewed migration exists. Review resource IDs and
other non-secret metadata before sharing configuration, state or reports publicly.

## Releasing a version

Four independent places carry a release: the repository (source, tag and GitHub Release), the npm
registry, ClawHub, and — without any publish step — the Skills CLI channel and the skill's own
`update-check`, which read the repository. Work through this list in order; it is the memory of what
each place needs.

**1. Pre-flight (source).** `pnpm vitest run`, `pnpm tsc --noEmit` (Node 24 for tests, Node 20 for
the installed runtime) and `pnpm build`. Then `GOLIVE_RELEASE_REF=v<version> pnpm build` with
`<version>` matching `package.json` exactly, and confirm a second build leaves `git status` clean:
CI's `Tests and committed bundle` job rebuilds and compares those bytes.

**2. Version bump, one commit and one PR.** `package.json` is the single source of truth;
`.claude-plugin/marketplace.json` must match it (a test enforces this); `README.md` and the six
`README.<lang>.md` carry the version in their alpha banner and npm line; `docs/DISTRIBUTION.md`
names the current alpha and the dist-tags; the translations' `golive-translation` marker gets today's
`updated` date, and its `source-commit` is pointed at the release commit in a small follow-up commit
once that commit exists on `main` (the marker records which commit the translation was synced to).
Merge with CI green.

**3. GitHub, the release of record.** Tag the release commit `v<version>` (annotated) and push it,
then publish a GitHub Release with the release notes and the registry tarball attached (`npm pack`
from the tagged commit). The tag must equal the version inside `release.json`, or installed copies
refuse the update.

**4. npm.** From the tagged commit: `npm publish --tag alpha`, then `npm dist-tag add
golive@<version> latest` so `npx golive` and `npx golive@alpha` resolve to the same release, and
confirm with `npm view golive dist-tags`. The publish needs the maintainer's own 2FA; the machine
that builds the release is not required to be logged in.

**5. ClawHub.** `npx clawhub@latest skill publish skills/golive --slug golive --name GoLive
--version <version> --changelog "<what changed>"` (dry-run first, `--version` never omitted — see
[the ClawHub channel](#third-channel-clawhub-the-openclaw-registry)), then confirm
`npx clawhub@latest search golive --exact` reports the new version.

**6. Channels that need no publish.** The GitHub channel (`npx skills add
https://github.com/mikehasa/golive-skill --skill golive`) and the skill's `update-check` read the
repository, so the tag and `main`'s `skills/golive/release.json` carry the release as soon as step 3
is done. `npx skills` has no publish command, and no other registry mirrors this repository.

**7. Post-release verification, from outside the checkout.** An anonymous clone, a global Skills CLI
install, `npx golive@alpha install` into a scratch project, and `npx clawhub@latest install golive`
into a scratch directory: every copy must answer `version --json` with the new version and digest,
and the offline checks must still pass. Record what was observed — and what was not — in
[validation](VALIDATION.md), keeping provider evidence separate from package acceptance.

CI tests the already-renamed source and its generated artifacts; it does not rename it again. Keep
live provider evidence separate from package acceptance.

## Renaming a source fork

The optional `scripts/rename.sh <new-name> <old-name>` helper is for maintainers, not installation
or migration. Both names are required: this source is already renamed, so there is no old-name
default. Preview first; `--apply` changes inventoried source files and removes generated artifacts
for rebuilding. It does not change credentials, app state, Git remotes or cloud resources. Preserve
historical evidence. CI asserts the release source carries only this skill's directory; a fork
updates that assertion for its own name.

## References

- [Agent Skills specification](https://agentskills.io/specification)
- [Skills CLI](https://github.com/vercel-labs/skills)
- [Provider scope](PROVIDERS.md)
- [Validation scope](VALIDATION.md)
