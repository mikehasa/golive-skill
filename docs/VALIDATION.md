# Validation scope

Pre-publication validation snapshot, 2026-09-23, for GoLive `0.1.0-alpha.1`. This is a sanitized summary:
no credentials, account inventories, real resource identifiers or private workspace paths.
The live tests exercised the implementation during development; this is not a claim that every
provider combination, first-time account setup or renamed package has had a live deployment.

## Observed live results

| Test | Observed result | Limits |
| --- | --- | --- |
| Vercel + Supabase | Approved disposable provisioning, environment wiring, deployment, authenticated CRUD, session restoration and access isolation; 22 strict API checks in the agent-observed retest | Existing Vercel login and explicit Supabase token; preconfirmed synthetic users; no signup/email-delivery proof |
| Netlify + Neon | Approved Free resources, environment wiring, deployment, database connection, separately approved schema, 149 two-session API assertions and real browser CRUD with refresh persistence | Postgres app, without an Auth provider; other frameworks and cross-pairings not live-tested |
| Supabase native CLI credential reuse | Existing macOS production-profile login reused with explicit-token input disabled; profile/projects/organizations returned 200; CLI/API project inventories agreed | Read-only; no fresh browser login, project creation, Auth writes or deployment through that credential |
| Cleanup | Separately approved exact test projects deleted; exact project reads and test URLs returned 404; unaffected scoped resources and login identities stayed unchanged | Normal provider deletion; Neon may retain a recovery window |

Cleanup used supervised fixture helpers; GoLive does not yet expose a general teardown command.
Sample application data was removed before project deletion. No domains were purchased and no live
payment, email or DNS resources were created in these runs.

## Provider mismatches found and repaired

- **Approval destinations and setup:** show the effective account/team/organization and exact
  project before writes; prepare the credentials directory before handing control to an editor;
  distinguish an empty account from an existing database and a scoped-token denial from logout.
- **Vercel diagnostics:** an auxiliary billing command returned a JSONL parse failure. It was not
  an adapter dependency; dashboard usage established Free quota. Currency figures from that CLI
  diagnostic are not proof of remaining free resource units.
- **Neon CLI stdin:** the installed parser rejected separate `--data -`; `--data=-` retained
  secret-safe stdin and succeeded in the subsequent approved apply.
- **Netlify reads and visibility:** bounded read recovery and fixed diagnostics avoid incorrectly
  treating every CLI failure as logout. Original transient read failure cause was not established.
  A successful deployment initially remained private; an approved project-only UI change made
  production public while keeping previews private. GoLive now detects the gate and presents the
  exact project visibility handoff, without inventing an unsupported API.
- **Detection and reporting:** exclude installed skill internals from app scanning and retain
  the provider's actual remediation for Auth advisories instead of suggesting unrelated RLS changes.

Provider fixes have offline mocked regressions. These implementation tests never use real accounts.
The repaired behavior was subsequently exercised where described above; this is not blanket live
coverage for every fallback or error condition.

## Candidate release checks

The candidate includes release identity and complete-bundle validation, approval binding across
versions, ownership-aware installation, explicit update/rollback and optional startup update checks.
Independent review found and fixed two additional guards: a script-only symlink must not validate
another bundle's instructions, and `--only` must not use changed historical prerequisite evidence
to authorize a dependent write. Both were rechecked with isolated offline reproductions.

The renamed candidate passed 1,096 mocked tests on Node 24, TypeScript checking and a tagged
release build. The suite includes local update/rollback, interruption, concurrency, pin, external
manager and user-data preservation cases. Skills CLI installed the complete local candidate for
both Codex and Claude Code. A real npm tarball also installed through the own installer. All three
installed copies matched all 20 manifest file hashes and passed help, version, menu, detect and
offline update-check on Node 20: 15 smoke checks with network and provider subprocesses blocked.
Automatic replacement was off in the owned installation.

Gitleaks 8.30.1 reported zero findings for the source export and installable skill. Five earlier
findings were reviewed as mocked test material and replaced with explicit fake-value construction;
no scanner allowlist was added. The affected 265 tests and the full suite passed afterward.
The export also passed a targeted check for private workspace paths and historical account/resource
identifiers. These checks reduce accidental disclosure risk; they are not a security certification.

These checks prove local installation and runtime behavior; they do not prove native discovery in
a new agent session. Publication is not implied by local acceptance. At the time of this snapshot,
anonymous clone, public Skills CLI installation, hosted CI and public release downloads had not
yet been tested; those checks require the published endpoints.

## Native credential entry and guided-provider follow-up

The native-entry follow-up passed **1,170 mocked tests / 32 files**, TypeScript checking and build after
adding macOS native token entry and expanding the guided-provider instructions. The 73 native
entry/CLI tests cover metadata-only results, secret-containing errors, cancellation, replacement,
concurrent edits, file/link/ACL protections, exact value preservation and cleanup reporting.
Generated English and Chinese AppleScript dialogs compile on macOS. Independent synthetic
filesystem checks reject inherited granting ACLs even with mode 0600 and accept deny-only defaults.
No real token or password was entered and the actual popup interaction remains untested.

An unknown-provider regression preserves an open guided handoff and confirms no provider login,
process, HTTP or automated write is dispatched. An independent instruction dry-run refused an MCP
result that would reveal a credential and an API operation with unknown cost, while retaining the
existing database and a possible approved dashboard path. This is not live provider coverage.

The latest alpha.1 bundle was repacked and installation acceptance repeated after these changes.
Skills CLI installs for Codex and Claude Code and the npm package's own installer each matched all
20 manifest file hashes and passed the 15 Node 20 runtime smoke checks, with network and provider
subprocesses blocked. All 28 npm package files passed a case-insensitive naming audit: no development
codename remains in their paths or contents. Source-only references are confined to the rename
helper, its regression fixtures and the CI guard that rejects old runtime names. This remains
local artifact acceptance; public installation still requires publication and a separate check.

## Still unverified

Stripe test/live payment behavior, Resend email delivery, custom domains and all DNS adapters need
live validation. Cross-provider pairings beyond the two above have mocked integration coverage.
First-time account/login UX, other OS credential stores and framework-specific behavior need further
coverage. A native Linux/Windows keyring path is not claimed by the Supabase reuse implementation;
the own updater's Windows filesystem behavior is not a validated alpha channel.
There is no nightly canary or published cross-agent compatibility matrix. Treat skipped and manual
checks as unverified, and functionally test the application flows that matter to its owner.


## Independent pre-publication review

A separate agent reviewed the source and public documentation, then independently reproduced and
rechecked these repairs with mocked providers:

- Payment approval now binds the Stripe account and operator credential fingerprint, rechecks
  before writes, and verifies a separate app key belongs to that account. Account read denial
  blocks payment planning. Captured credentials keep later cleanup in the approved account.
- Partial verification no longer carries checks forward from an older report. Current reports
  explicitly identify selected/omitted checks and do not claim deployment readiness from checks alone.
- Public HTML/JavaScript scans warn when assets cannot be fetched or bounded scan limits are reached.
  Observed credential patterns still fail; clean partial content is not a complete passing scan.
- Public documentation was rewritten around current behavior, observed evidence and a clearly
  labeled roadmap. Internal research notes are excluded from the public source candidate.

Independent rechecks passed 17 report tests, 15 Stripe approval tests and four bundle-scan cases.
The complete post-review suite passed 1,096 tests in 30 files, followed by TypeScript and build.
These are offline source checks. They do not add live Stripe, email, DNS or new-account evidence.

## Lock recovery follow-up

The current source and renamed candidate pass **1,175 tests / 32 files**, TypeScript checking
and build. Five added regressions cover overlapping lock recovery, old-operation cleanup, empty
locks left by interrupted cleanup, explicit empty-lock recovery and refusal of incompatible
fixed-name lock records. A later updater keeps its lock when an earlier recovery or cleanup resumes;
automatic-update opt-out cannot succeed concurrently and then be overwritten by that updater.
Each operation removes only its unique owner record, followed by nonrecursive empty-directory
cleanup. These are offline filesystem and mocked-update checks, not additional provider coverage.
