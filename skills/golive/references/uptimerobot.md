# UptimeRobot (monitoring): agent notes

Load this when the plan uses `monitoring=uptimerobot`.

Status: the adapter, the link and the `uptime-monitor` check are **implemented and mock-covered, not
live-validated**. No UptimeRobot account has run this slice, so every claim below is the code and the
official API contract behind it (checked 2026-10-03) — nothing here is an observed live result. The
API surface encoded is UptimeRobot's **v2** API (uptimerobot.com/api/legacy): form-encoded POSTs to
`https://api.uptimerobot.com/v2/getAccountDetails`, `getMonitors` (paginated by
`offset`/`limit`/`total`, page max 50; `monitors=<id>` filters to one monitor and `logs=1` with
`logs_limit=1` returns its latest log line), `newMonitor` (`type=1` for HTTP(S), `url`,
`friendly_name`) and `deleteMonitor`. The key travels in the request **body** (`api_key`), never in a
URL or a header. The envelope is `{ stat: "ok", … }` or `{ stat: "fail", error: { type,
parameter_name, passed_value, message } }` — and a `stat: "fail"` arrives with HTTP 200, so `stat`,
not the status code, is the verdict. Monitor status codes: `0` paused, `1` not checked yet, `2` up,
`8` seems down, `9` down; type codes `1` HTTP(s), `2` Keyword, `3` Ping, `4` Port, `5` Heartbeat.
`editMonitor` exists too — its documented `status` is `0` to pause and `1` to resume, and a monitor's
type cannot be edited — but golive performs no pause/resume or edit, so it is deliberately not
encoded.

## 1. Logging in (least friction first)

1. **API key (only path).** In UptimeRobot: **Integrations & API → API** (older dashboards: **My
   Settings → API**). The docs name three key types, and this slice uses exactly what each can do:
   a **read-only** key may call every `get*` method — enough to read the monitor `uptime-monitor`
   checks; a **monitor-specific** key may call only `getMonitors` for its one monitor; the account's
   **main** (account-specific) key is what `newMonitor` and `deleteMonitor` require. Then hand golive
   the key privately — on macOS the agent runs `credentials --prompt UPTIMEROBOT_API_KEY --json` for
   the native hidden-input dialog; the human's own editor is the fallback (see
   [How the human connects accounts](../SKILL.md#how-the-human-connects-accounts)). Never put the
   value in chat or argv.
2. **One account.** Unlike PostHog's or Sentry's organizations, the v2 API names no team, workspace
   or sub-account: a key belongs to one account, so `doctor` has nothing ambiguous to refuse and
   names the account's own e-mail and monitor budget back instead. A key that cannot read the account
   (`getAccountDetails` refused) is reported with the key types above.
3. **No region, no golive.yaml section.** There is one API host; `projects.monitoring` is the only
   selector. The docs publish rate limits as FREE 10 req/min, Pro monitor limit × 2 up to 5000, and
   answer 429 with `X-RateLimit-*` and `Retry-After` headers, which golive maps to "wait and re-run".

## 2. What golive does vs. what stays with the human

golive automates (after plan approval):

- `uptimerobot:monitor` — pins the monitor this repo is already linked to (zero writes), else selects
  `projects.monitoring` (a monitor id or an exact friendly name; an ambiguous or missing one is
  refused, never guessed), else **adopts** a monitor that already watches the production URL or is
  named like the repository, else **creates** one named from the repository (`repoName`, from the git
  origin remote when there is one) for the production URL golive can name: the configured `domain`,
  or the host's own URL once golive has recorded a production deploy. With no such URL the link plans
  nothing and warns to deploy production (or set `domain`) and run `plan` again. Several monitors
  watching the same URL are equivalent, so the first by id is adopted with a warning naming them;
  several carrying the repository's name are **not** picked between — the plan carries a blocking
  handoff naming them until `projects.monitoring` says which one is this app's. A created monitor
  records `uptimerobot.createdMonitorId`; a pinned or adopted one does not, so teardown can never
  delete a monitor golive did not make.
- `uptime-monitor` (the check) — **read-only**: one monitor read plus the account read behind the
  login check, and never a request to the app (the production URL is compared as a string). It
  **passes** only when the linked monitor watches exactly that production URL and the provider
  reports it `up`. Paused, not checked yet, seems-down or down **warn** — down/seems-down as
  severity **high** — naming the provider's status and, when it returned one, the monitor's latest
  log line, downtime reason included. A monitor watching a different URL **warns** too. An unusable
  key is a **skip** naming `login:uptimerobot` (the `accounts` check owns that verdict), no linked
  monitor is a **skip** naming `uptimerobot:monitor`, and an unreadable provider (refusal, rate
  limit, unreachable host) or a production URL golive cannot name yet (`blocked by:
  deploy:production`) skips rather than failing the run.
- Teardown — a monitor carrying golive's creation marker is deleted through the API (`golive
  teardown` → `apply --plan <id> --yes --confirm-destroy`) and the provider's own monitor read
  confirms it: UptimeRobot deletes at once (the docs publish no scheduled-deletion state), so `gone`
  is the confirmation and a monitor the provider still reports fails the step. An adopted monitor, or
  one whose provider cannot be reached now, becomes a handoff naming the UptimeRobot dashboard —
  never a silent gap.

Stays with the human:

- **Who gets alerted.** `newMonitor`'s documented `alert_contacts` parameter is optional and golive
  does not send it, so the account's own alert-contact rules decide recipients. golive never adds,
  removes or redirects an alert recipient — set alert contacts in the dashboard, and test them there.
  (The docs do not spell the default out; UptimeRobot's own release note for monitor-specific
  contacts says monitors formerly notified every contact defined in My Settings.)
- **The plan and its limits.** Free plans cap monitors and check frequency, and an independent
  2026-08-16 measurement saw a free account's `newMonitor` refused with `access_denied` ("You are not
  allowed to use some settings with your current plan") although the v2 docs publish no such limit.
  golive maps that refusal to reuse/adopt/upgrade and never retries, upgrades or spends money.
- **Creating the monitor by hand** when the plan or the API refuses the create: create it in the
  dashboard, then set `projects.monitoring` to its id or friendly name and re-plan — golive adopts it.
- **Editing a monitor.** golive never changes a monitor's URL, type, interval or status: it neither
  calls `editMonitor` nor pauses/resumes anything. Point the monitor at the right URL in the
  dashboard, or adopt the one that already watches it.
- Deleting a monitor by hand when golive did not create it.

## 3. Explain these in plain words

- **One key, three scopes.** The *read-only* key can read everything golive checks; the *main* key is
  needed only when golive creates or deletes the monitor it manages; a *monitor-specific* key is too
  narrow even for the check (the account read it needs is not allowed for one). Least privilege is
  therefore: start read-only, and only use the main key when golive should manage a monitor for you.
- **A monitor is not a golive probe.** UptimeRobot watches the URL from its own locations; the check
  only reads the provider's verdict (and its own log line), so it can be right while the app is
  unreachable from somewhere else, and a fresh monitor legitimately reports "not checked yet" for a
  moment.
- **The interval is the provider's.** The docs call 300 seconds the default, and the account's own
  plan decides the minimum; golive sends no `interval` on create, so it never guesses at — or
  overrides — a plan's checking frequency.
- **golive touches no alert recipient.** Not who is notified, not when, not how often. If a monitor
  should page someone, that is configured (and tested) in UptimeRobot.
- **A deletion is immediate.** There is no scheduled state to wait for: the provider's own read is
  the confirmation, and a still-present monitor fails the teardown step rather than being forgotten.

## 4. Troubleshooting

| Symptom | What to do |
|---|---|
| `doctor`: UptimeRobot key rejected / not authenticated | Create an API key under Integrations & API → API (read-only is enough for monitoring; the main key is needed for create/delete) and store it with `credentials --prompt UPTIMEROBOT_API_KEY --json` (§1). |
| `doctor`: the key is valid but cannot read the account | A monitor-specific key only allows `getMonitors` for its one monitor. Use a read-only or the main account key so golive can name the account and the monitor. |
| Create refused: `access_denied` ("not allowed to use some settings with your current plan") | The account's plan refused the write (free plans have been observed doing this; the docs publish no limit). Create the monitor in the UptimeRobot dashboard, set `projects.monitoring` to its id or friendly name and re-run `plan` — golive adopts it — or change the plan yourself. |
| Create refused: "already watches …" | A monitor already watches that URL. Re-run `golive plan` after setting `projects.monitoring` to that monitor (its id or friendly name); golive adopts it instead of duplicating. |
| Plans nothing and warns "the production URL isn't known yet" | golive has no `domain` and no recorded production deploy to point a monitor at. Apply the plan (or deploy production), then run `plan` again. |
| `uptime-monitor` warns "not checked yet" | A new monitor has not completed its first check yet. Re-run `golive verify --only uptime-monitor` in a minute; if it stays, check the monitor's settings and target in the dashboard. |
| `uptime-monitor` warns `paused` | Resume it in the UptimeRobot dashboard; golive never pauses or resumes a monitor. |
| `uptime-monitor` warns it watches another URL | Point the monitor at the production URL in the dashboard, or set `projects.monitoring` to the monitor that does watch it and re-run `plan`; golive never rewrites a monitor's URL. |
| `uptime-monitor` warns `down` / `seems down` | The provider reports the site unreachable; check the site now, then the dashboard's check history and the reason in the log line. The warning is **high** severity but never fails the run (`site-headers` treats an unreachable page the same way). |
| `429` in any message | UptimeRobot's documented rate limit (FREE 10 req/min). Wait for the `Retry-After` window and re-run. |
| Teardown step fails "still reports the monitor" | The delete did not stick (or the monitor was recreated). Delete it in the UptimeRobot dashboard, or re-run teardown. |

## Unverified

- Every live path: no UptimeRobot account has run the adapter, the link or the check. The account
  read, the monitor list/create **and delete**, the status and log reads, the key-type messages, the
  rate-limit handling, the check's pass/warn/skip verdicts and the teardown confirmation are all
  mock-covered only.
- **Docs ambiguities golive encoded conservatively.** The legacy field table calls
  `account.monitor_interval` seconds while a live third-party measurement (2026-08-16) saw `5` for a
  five-minute account — so golive never writes `interval` and reports that value as read. The field
  table spells the paused count `pause_monitors` while both response examples spell it
  `paused_monitors` — golive accepts either. `monitor.url` is documented as "URL or IP", but golive
  only manages http(s) monitors and refuses anything else.
- **v2 is the legacy surface.** UptimeRobot's own page marks v2 as no longer receiving updates or new
  features and documents a v3 API instead; golive encodes v2 (the documented form-encoded interface
  this slice was written against). Moving to v3 would be a transport change, not a capability change.
- **Plan-dependent creates.** The v2 docs publish no plan restriction on `newMonitor`, but the
  2026-08-16 measurement above saw a free plan refuse it; whether that is a plan rule, an account
  setting or something transient is not confirmed by the docs, so golive maps the refusal and hands
  the create over rather than asserting a rule.
- **Alert contacts.** golive sends none on create, on purpose; no live run has confirmed how a
  monitor created this way appears in an account with several alert contacts.
