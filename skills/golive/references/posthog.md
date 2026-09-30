# PostHog (monitoring): agent notes

Load this when the plan uses `monitoring=posthog`.

Status: the adapter, the link and the `posthog-ingest` check are **implemented and mock-covered, not
live-validated**. Nothing here has run against a real PostHog account yet; the reference records what
the code does and what the official API contract behind it is (checked 2026-09-29).

## 1. Logging in (least friction first)

1. **Personal API key (only path).** In PostHog: **Settings → Personal API keys → Create personal API
   key**, and check its scopes: `organization:read` (list the organization), `project:read` +
   `project:write` (list, read, create and delete projects) and `query:read` (read an event count
   back). Then hand golive the key privately — on macOS the agent runs
   `credentials --prompt POSTHOG_API_KEY --json` for the native hidden-input dialog; their own editor
   is the fallback (see [How the human connects accounts](../SKILL.md#how-the-human-connects-accounts)).
   Never put the value in chat or argv.
2. **Scope the key to ONE organization.** golive refuses to guess: a key that can see several
   organizations fails `doctor` with the list, because picking one would wire the app's analytics into
   an account nobody approved.
3. **Region.** `posthog.region: us` (default) or `eu` in `golive.yaml` selects both hosts: the control
   plane (`us.posthog.com` / `eu.posthog.com`) and ingestion (`us.i.posthog.com` / `eu.i.posthog.com`).
   A key from the EU Cloud is not valid on the US host, and events sent to the wrong ingestion host
   never reach the project.

## 2. What golive does vs. what stays with the human

golive automates (after plan approval):

- `analytics:project` — pins the project this repo is already linked to (zero writes), else selects
  `projects.monitoring`, else **creates** one named from the repository (`repoName`, from the git
  origin remote when there is one) in the key's organization. A created project records
  `posthog.createdProjectId`; a pinned or adopted one does not, so teardown can never delete a project
  golive did not make.
- `analytics:env:<target>` — reads the project's **public** ingestion token through the API and writes
  the names the code actually reads (`POSTHOG_KEY` + `POSTHOG_HOST`, or the framework's client-prefixed
  spelling: `NEXT_PUBLIC_POSTHOG_KEY`/`NEXT_PUBLIC_POSTHOG_HOST`, `PUBLIC_POSTHOG_KEY` in SvelteKit,
  `VITE_…`, …) into the host's env. Written as one write with the env pipeline's usual rules: names
  someone else set are kept, names golive wrote before are rewritten when the project or the token
  changes (the recorded source carries the project id and the token's fingerprint), and the whole step
  re-reads the token before writing so what was approved is what lands. The `phc_` token is public by
  design — it is the key browsers must have — so it is written **non-sensitively** and `bundle-secrets`
  does not treat it as a leak.
- `posthog-ingest` (the check) — sends one synthetic event (`golive_ingest_check`, distinct id
  `golive-verify`, plus a per-run marker property) and polls PostHog's own HogQL count for that marker
  for about three minutes. **Pass only on the read-back**; the capture endpoint's 200 is an acceptance,
  not proof. "Not visible yet" is a **warn** (ingestion is asynchronous), a refused read-back (401/403 —
  usually a missing `query:read` scope) or an unusable credential is a **fail**, and no linked project
  is a **skip** naming `analytics:project`.
- Teardown — a project carrying golive's creation marker is deleted through the API (`golive teardown`
  → `apply --plan <id> --yes --confirm-destroy`), and the provider's own read confirms it: PostHog
  **schedules** the deletion, so the confirming answer is `is_pending_deletion` (reported as "pending
  deletion (scheduled, not live)") or a 404 — both are confirmations; a project the provider still
  reports live fails the step. An adopted project, or one whose provider cannot be reached now, becomes
  a handoff naming the PostHog dashboard instead — never a silent gap.

Stays with the human:

- **Initializing the SDK in the app** (and sending the events the product cares about). Until the code
  reads the env names golive fills, the plan carries the non-blocking `analytics:snippet` handoff with
  that task; it closes when `posthog-ingest` passes.
- **The plan and its limits**: a free PostHog account allows **one** project, and PostHog is priced per
  ingested event. golive maps a refused create to "reuse the existing project, delete one you no longer
  need, or upgrade" and never upgrades, pays or retries a create.
- Dashboards, funnels, alerts, data retention and every product decision inside PostHog.
- Deleting a project by hand when golive did not create it.

## 3. Explain these in plain words

- **Two different keys.** The *personal API key* (`phx_…`, `POSTHOG_API_KEY`) is golive's own
  credential and stays server-side; the *project API key / project token* (`phc_…`) is PUBLIC — it is
  what the browser SDK sends every event with. Writing `NEXT_PUBLIC_POSTHOG_KEY` is not a leak; writing
  a `phx_` key there would be. golive fills the project-token names it knows (`POSTHOG_KEY`,
  `POSTHOG_TOKEN`, `POSTHOG_PROJECT_KEY`, `POSTHOG_PROJECT_API_KEY`, `POSTHOG_PROJECT_TOKEN`, and the
  framework's client-prefixed forms) but deliberately **never** fills `POSTHOG_API_KEY`: in PostHog that
  name means a *personal* key, so an app reading it is left unmapped on purpose (give it a server-only
  personal key by hand, or rename the variable to `POSTHOG_KEY` if it only wants the project token).
- **A 200 from the capture endpoint means "accepted", not "ingested".** PostHog queues events, so the
  only honest proof is reading the event count back — that is exactly what `posthog-ingest` does.
- **Verify leaves one (or a few) synthetic events in the project.** `golive_ingest_check` events are
  golive's own probes; ignore or filter them in dashboards and funnels.
- **Region matters twice**: the API host AND the ingestion host. An EU project receiving events at
  `us.i.posthog.com` silently drops them.
- **Deleting a project deletes its data.** PostHog schedules the deletion and keeps the project listed
  as pending until it is purged; that is why golive reports the scheduled state instead of waiting.

## 4. Troubleshooting

| Symptom | What to do |
|---|---|
| `doctor`: PostHog key rejected / not authenticated | Create a fresh personal API key with `organization:read`, `project:read`, `project:write`, `query:read`, and store it with `credentials --prompt POSTHOG_API_KEY --json` (§1). |
| `doctor`: "golive needs a key scoped to exactly one PostHog organization" | Scope the personal API key to one organization in PostHog (Personal API keys → scope), or use a key from that organization only, then re-run `doctor`. |
| `403` mentioning scopes | The key is missing one of the four scopes golive uses; the error names them. Re-create the key with all four. |
| Create refused: "free plans allow one project" | Reuse the account's existing project (`projects.monitoring: <id-or-name>`), delete one you no longer need (by hand, or `golive teardown` when golive created it), or upgrade the plan yourself. |
| `analytics:env:*` says the token changed since approval | The project token was rotated in PostHog after the plan was approved. Re-run `golive plan` and apply the new plan. |
| `posthog-ingest` warns "had not recorded the marker yet" | Ingestion can lag minutes. Re-run `golive verify --only posthog-ingest` in a minute. If it never appears: check the project id in the plan/state, the region (`posthog.region`) and that the app initializes the SDK with those env names. |
| `posthog-ingest` fails "the read-back was refused" | The key lacks `query:read` (or was revoked). Re-create it with the scopes above. |
| Events land in the wrong project | The app reads a token that does not match `projects.monitoring`. Re-run `golive plan` (it rewrites the names golive manages) and redeploy. |
| The app reads `POSTHOG_API_KEY` | That name means a *personal* API key in PostHog, so golive never fills it (and `env-parity` names it as unmapped). Give the app a server-only personal key by hand, or rename the variable to `POSTHOG_KEY` if it only needs the public project token, then re-run `plan`. |
| `bundle-secrets` flags a PostHog key | It should not: the `phc_` project token is public by design and is not a scanned pattern. A flagged `phx_` key in a bundle is a real leak — rotate it and keep it server-only. |
| Teardown step fails "still reports the project as live" | The delete did not stick (or the project was recreated). Delete it in the PostHog dashboard, or re-run teardown. |

## Unverified

- The exact status codes and wording PostHog uses for plan-limit refusals: golive maps them by message
  pattern (`project limit`, `upgrade`, `quota`, …) across 4xx, because the docs do not pin one code.
- Whether every PostHog plan/serializer returns `api_token` on `GET /api/organizations/:org/projects/:id`
  (the create response carries it; golive refuses to invent one when a read omits it).
- EU Cloud behaviour end to end: the host pair is configurable and mock-covered, but no EU account has
  run it.
- The ~180 s read-back window: from PostHog's documented ingestion lag, not from a measured live run.
