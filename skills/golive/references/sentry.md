# Sentry (monitoring): agent notes

Load this when the plan uses `monitoring=sentry`.

Status: the adapter, the link and the `sentry-ingest` check are **implemented and mock-covered, not
live-validated**. No Sentry account has run this slice, so every claim below is the code and the
official API contract behind it (checked 2026-10-03) — nothing here is an observed live result. The
API surface encoded: `GET /api/0/organizations/` (`org:read`), `GET
/api/0/organizations/{org}/teams/` (`team:read`), `GET /api/0/organizations/{org}/projects/` and
`GET /api/0/projects/{org}/{project}/` (`project:read`), `GET
/api/0/projects/{org}/{project}/keys/` for the DSN (`project:read`), `POST
/api/0/teams/{org}/{team}/projects/` to create (`project:write`), `DELETE
/api/0/projects/{org}/{project}/` to delete (`project:admin`, asynchronous), `GET
/api/0/projects/{org}/{project}/events/{event_id}/` to read one event back (`event:read`), and the
DSN Store endpoint `POST https://<dsn host>/api/<project id>/store/` with the `X-Sentry-Auth` header
(`sentry_version=7`, `sentry_key=<public key>`) — a 2xx there only means accepted.

## 1. Logging in (least friction first)

1. **Auth token (only path).** In Sentry: **Settings → Account → API → Auth Tokens → Create New
   Token** (an internal integration's token under **Settings → Custom Integrations** works too and is
   recommended for shared use). Check its scopes: `org:read` (list organizations), `team:read` (list
   the organization's teams), `project:read` + `project:write` (list, read and create projects, and
   read their client keys/DSN), `event:read` (read an event back for `sentry-ingest`) and — only for
   teardown's delete of a project golive created — `project:admin`. Then hand golive the token
   privately — on macOS the agent runs `credentials --prompt SENTRY_AUTH_TOKEN --json` for the native
   hidden-input dialog; the human's own editor is the fallback (see
   [How the human connects accounts](../SKILL.md#how-the-human-connects-accounts)). Never put the
   value in chat or argv.
2. **One organization.** golive refuses to guess: a token that can see several organizations fails
   `doctor` with the list, because picking one would wire the app's error reporting into an account
   nobody approved. Create the token for the organization that owns this app.
3. **Region.** `sentry.region: us` (default) or `eu` in `golive.yaml` selects the API host:
   `us.sentry.io` or `de.sentry.io` (Sentry's documented EU region domain). A request to the wrong
   region host is answered with a redirect; golive reports that and names `sentry.region`. The DSN
   carries its own ingest host, so events always go where the project lives.
4. **Team (only for creating).** A project is created into a team: with exactly one team golive uses
   it; with several, nothing is created and the plan carries a handoff naming the teams until
   `sentry.team: <slug>` in `golive.yaml` names one. An adopted (`projects.monitoring`) or
   already-linked project needs no team.

## 2. What golive does vs. what stays with the human

golive automates (after plan approval):

- `sentry:project` — pins the project this repo is already linked to (zero writes), else selects
  `projects.monitoring` (id, slug or name), else **creates** one named from the repository
  (`repoName`, from the git origin remote when there is one) in the approved team. A created project
  records `sentry.createdProjectId`; a pinned or adopted one does not, so teardown can never delete a
  project golive did not make. A create whose team is ambiguous becomes a blocking handoff naming the
  teams — never a guessed one.
- `sentry:env:<target>` — reads the project's **public DSN** (client key) through the API and writes
  the names the code actually reads (`SENTRY_DSN`, or the framework's client-prefixed spelling:
  `NEXT_PUBLIC_SENTRY_DSN`, `PUBLIC_SENTRY_DSN` in SvelteKit, `VITE_…`, …) into the host's env.
  Written with the env pipeline's usual rules: names someone else set are kept, names golive wrote
  before are rewritten when the project or the DSN changes (the recorded source carries the project
  id and the DSN's fingerprint), and the whole step re-reads the DSN before writing so what was
  approved is what lands. The DSN is public by design — it is what browsers must have — so it is
  written **non-sensitively** and `bundle-secrets` does not treat it as a leak.
- `sentry-ingest` (the check) — sends one synthetic event (message `golive_ingest_check <marker>`,
  tag `golive_marker=<marker>`, a per-run event id) through the project's Store endpoint and polls
  Sentry's own event read for that exact event id for about three minutes. **Pass only on the
  read-back**; the Store 2xx is an acceptance, not proof. "Not visible yet" is a **warn** (ingestion
  can lag), an event that reads back without the marker is a **warn**, an unusable credential is a
  **skip** naming `login:sentry` (the `accounts` check owns that verdict), and no linked project is a
  **skip** naming `sentry:project`. A read-back golive cannot read — including a 401/403, usually a
  missing `event:read` scope — is a **warn with the scope fix**, never a failure of the app's
  monitoring: the Store call already showed the project accepts events.
- Teardown — a project carrying golive's creation marker is deleted through the API (`golive teardown`
  → `apply --plan <id> --yes --confirm-destroy`) and the provider's own read confirms it: Sentry
  deletes **asynchronously**, so `pending_deletion` and a 404 are both confirmations, while a project
  Sentry still reports live fails the step. The delete needs the token's `project:admin` scope; a
  refusal names that scope and the dashboard, and an adopted project — or one whose provider cannot
  be reached now — becomes a handoff naming the Sentry dashboard instead, never a silent gap.

Stays with the human:

- **Initializing the SDK in the app** (and choosing what to capture). Until the code reads the DSN
  env name golive fills, the plan carries the non-blocking `sentry:snippet` handoff with that task.
  No check can see the app's own code, so nothing closes it — it ends when the code reads that name,
  and the handoff then stops being planned.
- **The plan and its limits**: Sentry's pricing, quotas, retention and data-storage choices are the
  account's; golive never upgrades, pays or retries a create.
- Alerts, issue triage, source maps, releases, integrations and every product decision inside Sentry.
- Deleting a project by hand when golive did not create it.

## 3. Explain these in plain words

- **Two different values.** The *auth token* (`SENTRY_AUTH_TOKEN`) is golive's own credential and
  stays server-side; the *DSN* (`https://<public key>@o<org>.ingest.<region>.sentry.io/<project id>`)
  is PUBLIC — it is what the browser SDK reports errors with. Writing `NEXT_PUBLIC_SENTRY_DSN` is not
  a leak; writing an auth token there would be. golive fills `SENTRY_DSN` (and its client-prefixed
  spellings) but deliberately **never** fills `SENTRY_AUTH_TOKEN`: that name is golive's own
  operator credential.
- **The Store endpoint accepting an event is not delivery.** Sentry queues events, so the only honest
  proof is reading the event back — that is exactly what `sentry-ingest` does, by the event id the
  Store call returned.
- **Verify leaves one `golive_ingest_check` event per run in the project.** It is golive's own probe;
  ignore or filter it in alerts and issue views.
- **A deletion is asynchronous.** Sentry schedules it; golive reports the scheduled state instead of
  waiting, and the provider's own read is the confirmation.
- **The DSN names the region.** An EU project's DSN points at `…ingest.de.sentry.io`; golive reads
  the DSN rather than constructing it, so the region setting only affects golive's own API calls.

## 4. Troubleshooting

| Symptom | What to do |
|---|---|
| `doctor`: Sentry token rejected / not authenticated | Create a fresh token with `org:read`, `team:read`, `project:read`, `project:write`, `event:read` (and `project:admin` for teardown) and store it with `credentials --prompt SENTRY_AUTH_TOKEN --json` (§1). |
| `doctor`: "golive needs a token scoped to exactly one Sentry organization" | Create the token (or internal integration) inside the one organization that owns this app, then re-run `doctor`. |
| Requests redirect, or the EU account answers oddly | Set `sentry.region: eu` (or `us`) in `golive.yaml`; the API host must match the organization's data region. |
| Create refused: "has N teams … so golive will not guess" | Set `sentry.team: <slug>` in `golive.yaml` to one of the listed teams, or create the project in Sentry and set `projects.monitoring` to it, then re-run `plan`. |
| Create refused: "already exists in this organization" | Re-run `golive plan` after setting `projects.monitoring` to that project: golive adopts it instead of duplicating it. |
| `sentry:env:*` says the DSN changed since approval | The project's client key was rotated after the plan was approved. Re-run `golive plan` and apply the new plan. |
| `sentry-ingest` warns "had not returned the event yet" | Ingestion and indexing can lag. Re-run `golive verify --only sentry-ingest` in a minute. If it never appears: check the project id in the plan/state and that the app initializes the Sentry SDK with the DSN env name golive writes. |
| `sentry-ingest` warns "the read-back was refused" | The token lacks `event:read` (or was revoked). Re-create it with the scopes above; the Store call already showed the project accepts events. |
| Teardown step fails mentioning `project:admin` | The token may read and create but not delete. Grant `project:admin` (or delete the project in Sentry → the project → Settings) and re-run teardown. |
| `bundle-secrets` flags a Sentry DSN | It should not: the DSN is public by design and is not a scanned pattern. A flagged auth token in a bundle is a real leak — rotate it and keep it server-only. |

## Unverified

- Every live path: no Sentry account has run the adapter, the link or the check. The token/organization
  read, team selection, project create **and delete** (including `project:admin` and the scheduled
  deletion read), the host env write, the Store call, the event read-back and both region hosts are
  all mock-covered only.
- The ~180 s read-back window: from Sentry's documented asynchronous ingestion — no run has timed it.
- The `X-Sentry-Auth` Store payload is Sentry's legacy single-event endpoint (still documented at
  develop.sentry.dev/sdk/store); if it is ever removed, the check must move to the envelope protocol,
  which is a change to the check, not just the transport.
- A DSN served from a host outside `o<org>.ingest.{us,de}.sentry.io` is refused rather than sent to;
  should Sentry add more SaaS regions, the allowlist and `parseDsn` need those hosts.
