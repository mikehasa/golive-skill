# GoLive

**Take your agent-built product live: hosting, database, domain, email, payments — on your own accounts.**

Your coding agent can build an app in minutes. Getting it to real users still means accounts,
hosting, databases, domains, secrets and connected services. GoLive is the open-source Agent Skill
for that work: it **detects what your app needs, plans the exact changes, asks for your approval,
applies them with your own logins, and verifies what actually works**.

Automate the parts providers expose. Guide you through the parts that need a human. Verify what
can be observed, and make unfinished work clear. No GoLive account, hosted backend or product telemetry.

> **Early alpha · 0.1.0-alpha.1**
> We are starting with **hosting + database: two choices each**. Vercel + Supabase and Netlify +
> Neon passed disposable live tests; custom-domain DNS, transactional email and test-mode payments
> have since passed their own disposable validations. The broader
> [roadmap](#the-full-go-live-checklist-and-roadmap) is our direction, not a claim that it is all built.

[Install](#install) · [Use GoLive](#use-golive) · [See the workflow](#what-a-run-looks-like) · [Alpha scope](#what-this-alpha-supports) · [Roadmap](#the-full-go-live-checklist-and-roadmap) · [Contribute](CONTRIBUTING.md)

## Install

You need **Node.js 20+**, npm/npx, Git, and a coding agent that can load skills and run commands.
Installation has been checked for Codex and Claude Code; other clients are unverified.

**Install once for all your projects.** Run this from any directory:

```bash
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global
```

Select your agent when prompted: use the arrow keys to move, Space to select, and Enter to
confirm. That screen is waiting for input; installation continues after you confirm.

To skip the agent picker, use the command for your agent:

```bash
# Codex
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global --agent codex --yes

# Claude Code
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global --agent claude-code --yes
```

For installation in just one project, run from that project's repository and omit `--global`.

**Or paste this into your coding agent:**

```text
Install the GoLive skill globally so I can use it across projects:
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global

Target the agent I'm using: add --agent codex --yes for Codex, or
--agent claude-code --yes for Claude Code. Keep --global.
If the agent isn't clear, ask me which one.

Verify the installation with:
node <installed-skill-dir>/scripts/golive.mjs version --json
Tell me if I need to reload skills or start a new session.
Stop after installation; don't connect accounts or deploy yet.
```

The install includes the instructions, provider references and prebuilt runtime. It does not
connect accounts or deploy anything. See [installation and updates](docs/DISTRIBUTION.md) for
noninteractive agent flags, runtime verification and the optional own installer.

## Use GoLive

Open your app repository in your coding agent. After installation, reload skills or start a new
session if GoLive does not appear. The skill's name is **`golive`**. For the standalone installation
above, type one of these **in your agent's chat**:

| Agent | Example prompt |
| --- | --- |
| [Codex](https://learn.chatgpt.com/docs/build-skills#how-chatgpt-and-codex-use-skills) | `$golive Help me take this app live.` |
| [Claude Code](https://code.claude.com/docs/en/skills) | `/golive Help me take this app live.` |

You can also ask in plain language:

```text
Use the golive skill to take this app live. Keep the providers it already uses.
Show me the destination accounts and plan before changing anything.
```

GoLive inspects the app, asks about missing providers, and presents the destination accounts and
plan for your approval before making provider changes.

These are chat prompts. `golive skill` is not a command. Installing through `npx skills add` does
not add a `golive` command to your terminal; the agent runs the included CLI from the installed
skill directory. The optional npm package is prepared but not yet published; its terminal CLI
runs individual operations rather than the conversational skill workflow.

## What a run looks like

An illustrative conversation for an app that already uses Supabase:

> **You:** Use golive to take this app live. Use test resources for now.
>
> **Agent:** This app uses Supabase. Where would you like to host it?
>
> 1. **Vercel** — built-in hosting workflow; live-tested with Supabase.
> 2. **Netlify** — built-in hosting workflow; the live-tested pairing is Netlify + Neon.
> 3. **Other** — tell me your provider; I'll try a guided setup using its official tools and docs.
>
> **You:** Vercel.
>
> **Agent:** We'll keep Supabase. Does this app already have a Supabase project,
> or should we create a new test project?
>
> **You:** Create a new one.
>
> **Agent:** Run `vercel login` and `supabase login` in a separate terminal window.
> I'll check which account and organization are connected when you're done.
>
> **You:** Done.
>
> **Agent:** Here's the plan: create a new test frontend project in your selected Vercel team,
> create its database in your selected Supabase organization, transfer the required environment
> values, and deploy. I'll show the actual destination names and IDs, resource settings and cost
> information with the plan. Approve before I apply it.
>
> **You:** Approved.
>
> **Agent:** The deployment is live. Here is the URL, the verification report, and anything still
> unverified. Next we'll test the app's own signup and data flows.

GoLive keeps the provider choices already in your app and asks about missing pieces. You handle
signups, browser logins, identity checks and purchases. If an API key is needed on macOS, a native
hidden-input dialog explains why it is asking and where the key will be saved. Its value goes
directly to the local credentials file, never to chat or command output. Other platforms use your
own editor as a fallback. A later change to the plan needs
another approval; connecting auth or a domain may require a follow-up after the first deploy.

**Using another provider?** The skill has a general guided flow: check the provider's official
CLI, an available official MCP integration or API, then guide you through its dashboard if needed.
The agent still shows the destination, changes and cost before asking for approval, and checks
what it can afterward. This is **best-effort guidance**, with no guarantee of completion or the
same verification coverage as a built-in adapter. If a step cannot be completed or verified,
you get the specific blocker and next action. See [guided provider scope](docs/PROVIDERS.md#guided-providers).

## What this alpha supports

**Two hosting choices: Vercel and Netlify. Two database choices: Supabase and Neon.**

| Live-tested path | What was exercised |
| --- | --- |
| **Vercel + Supabase** | Provisioning, environment wiring, deployment, authenticated CRUD and access isolation |
| **Netlify + Neon** | Provisioning, environment wiring, deployment, Postgres connectivity, two-session API checks and browser CRUD |
| **Vercel + Porkbun (custom domain)** | Domain attachment, an approved DNS record write under `--confirm-dns`, ownership verification and HTTPS serving on a disposable subdomain |
| **Vercel + GoDaddy (custom domain)** | The same journey on a second subdomain, including the ownership TXT challenge Vercel requested after attaching |
| **Vercel + Resend (email)** | Sending-domain setup, DNS records, domain verification and a real send through the app's own environment key (delivered; the fresh subdomain landed in spam) |
| **Vercel + Stripe (test payments)** | Test-mode keys and webhook registration, an unsigned-request rejection, and a real test-card payment delivered as a signature-verified event |

These were approved disposable runs on existing accounts; completed test resources were deleted
afterward, and recent runs' disposable projects and records are cleaned up under the same
supervision. Cross-pairings have mocked coverage, not equivalent live proof. Supabase CLI-login
reuse separately passed read-only verification; the complete deployment test used an explicit
token. A new user's first-account setup and every application framework have not been validated.

Experimental adapters also exist for Supabase Auth configuration and Cloudflare DNS. Their complete
auth and domain journeys are **not validated alpha paths yet**; the DNS, email and test-mode
payment paths listed above are the tested ones. See [provider scope](docs/PROVIDERS.md) and
[observed validation](docs/VALIDATION.md).

## The full go-live checklist and roadmap

A working URL is the beginning. Depending on the app, going live can mean all of the following.
**GoLive should work out which items apply, help you finish them, and show evidence for the result.**
A static site should not be asked to set up a database; a paid SaaS should not stop at a deployed homepage.

This is our product roadmap as a launch checklist. Checkmarks and strikethroughs mark **specific
live-tested milestones**, not a finished category or a completed checklist for your app.

**✅ Live-tested** · **🚧 In progress / experimental** (code exists; complete journey pending) · **🗺️ Planned**

### Ship the app

- [x] ✅ **Frontend hosting:** ~~Prove deployment on Vercel and Netlify.~~ Build, deploy and verify
  the intended project on the two tested paths.
- [x] ✅ **Database:** ~~Prove provisioning and connection with Supabase and Neon.~~ The tested
  paths include environment wiring and application CRUD checks.
- [x] ✅ **Environment wiring:** ~~Connect hosting and database credentials on both tested paths.~~
  Broader secret rotation and environment lifecycle management remain planned.
- [ ] 🗺️ **Backend / servers:** dedicated API services, containers, persistent servers, runtime
  configuration and health checks. App routes already deploy through the supported hosts.
- [ ] 🗺️ **Schema and data:** reviewed migrations, safe rollout, environment separation and app
  data checks. These were separately supervised in live tests; a reusable workflow is still planned.
- [ ] 🗺️ **File and object storage:** buckets, uploads, access rules, signed URLs and lifecycle policies.

### Make it a complete product

- [ ] 🚧 **Authentication:** signup, login, sessions, password recovery and account isolation.
  Supabase configuration and some access checks exist; the complete journey still needs validation.
- [ ] 🗺️ **OAuth / social login / SSO:** client registration, consent screens, scopes, callback
  URLs and provider reviews. Current auth-provider setup is guided.
- [x] ✅ **Payments and subscriptions:** ~~Prove test-mode checkout and webhook acceptance with Stripe.~~
  A real test-card payment delivered a signature-verified `checkout.session.completed` event. Live-mode
  readiness, entitlements, refunds and subscription events still need validation.
- [x] ✅ **Transactional email:** ~~Prove sending-domain setup, verification and real delivery with Resend.~~
  A send through the app's own environment key was delivered (to spam on a fresh subdomain, no DMARC yet).
  Auth SMTP, bounce handling and richer message content still need validation.
- [x] ✅ **Domains / DNS / HTTPS:** ~~Prove domain attachment, DNS wiring and HTTPS serving on host+DNS pairs.~~
  Tested: Vercel attachment with Porkbun and GoDaddy record writes under `--confirm-dns`, ownership
  verification and HTTPS 200 on disposable subdomains. The Cloudflare DNS adapter, redirects and
  further host pairings still need live validation.
- [ ] 🗺️ **SMS and push notifications:** sender registration, credentials, permissions and delivery checks.
- [ ] 🗺️ **Third-party and AI services:** API access, scopes, callbacks, quotas and functional tests.
  Missing environment variables are detected today; service-specific workflows are planned.
- [ ] 🗺️ **Background work:** cron schedules, queues, workers, retries and failed-job recovery.
- [ ] 🗺️ **Cache, search and realtime:** caches, search/vector indexes and realtime services when needed.

### Launch with confidence, then keep it running

- [ ] 🗺️ **Security and abuse controls:** access policies, exposed credentials, security headers,
  rate limits and bot protection. Scoped RLS/advisor and credential-pattern checks exist today.
- [ ] 🗺️ **Monitoring and alerts:** error tracking, logs, uptime and actionable alerts.
  Provider suggestions are guided today; verified setup is planned.
- [ ] 🗺️ **Product analytics:** event validation and consent/data settings, beyond today's guided
  provider suggestions.
- [ ] 🗺️ **CI/CD and safe releases:** previews, release checks, promotion, rollback and drift
  detection, building on today's approved CLI deployments.
- [ ] 🗺️ **Backups and recovery:** retention, restore drills, incident steps and approved cleanup.
  Current test cleanup is supervised; there is no general cloud teardown command.
- [ ] 🗺️ **Uninstall / teardown:** an approved inventory of golive-created resources (host projects,
  DNS records, webhook endpoints, env names) and their removal, with ownership re-verification before
  every deletion ([#9](https://github.com/mikehasa/golive-skill/issues/9)).
- [ ] 🗺️ **Costs and quotas:** plan choices, budgets, alerts and capacity checks.
  Scoped Free-plan guards exist today; ongoing cost management is planned.
- [ ] 🗺️ **Launch essentials:** metadata, share previews, indexing, accessibility, support links
  and owner-reviewed policy pages.
- [ ] 🗺️ **Ownership and handover:** accounts, resources, access, renewal responsibilities and
  maintenance instructions, building on today's plans and reports.

Some steps will always need a person: accepting terms, identity verification, purchases, billing
choices and reviews that a provider requires. “Guided” should still mean a clear next action,
the right page, the right permissions, a check afterward, and a return to the same workflow.
When the app itself needs code changes, GoLive should give the coding agent a concrete task and
recheck the result. It should not make you coordinate a dozen disconnected setup conversations.

**Next up:** complete and live-test the remaining launch journeys—authentication, live-mode payment
flows and the Cloudflare DNS adapter—then expand app architectures and ongoing operations.

These are directions, not release dates. A capability should graduate from experimental only after
its account setup, connection, verification and recovery have been exercised. Contributions toward
any part of this checklist are welcome, especially evidence of where a real launch gets stuck.

<details>
<summary>Production checklists informing this roadmap</summary>

The scope draws on [Vercel's launch checklist](https://vercel.com/docs/production-checklist),
[Supabase's production checklist](https://supabase.com/docs/guides/deployment/going-into-prod),
[Stripe's go-live checklist](https://docs.stripe.com/get-started/checklist/go-live),
[Google's OAuth production guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)
and [Next.js production guidance](https://nextjs.org/docs/pages/guides/production-checklist).
These inform the goals above; they are not GoLive features or blanket requirements for every app.

</details>

## Verification you can inspect

The report records **pass, fail, warning and skipped** results, along with remaining human steps.
Checks include account access, environment-variable names, provider-confirmed deployment URLs,
public JavaScript secret patterns, database access and supported auth/webhook/DNS settings.

A ready deployment is not proof that the app works. An environment-variable name can exist with
a wrong value. A verified email domain does not prove inbox delivery. Signed payment events,
signup and the app's business flows need functional tests. **Skipped is not passed.**

Your app gets `golive.yaml`, `.golive/state.json`, `.golive/report.json` and `GOLIVE_REPORT.md`.
State preserves resource IDs and step evidence for recovery; it is not a credential store.
GoLive does not provide a general cloud teardown or cross-provider rollback command.

## Credentials and control

- **Approve before account changes.** Plans name the destinations and intended writes. Changing
  the installed release invalidates old approvals. DNS and live-payment steps have extra gates.
- **Keep secrets out of chat.** Supported vendor logins are reused. On macOS, a native hidden-input
  dialog can save a needed API key; your own editor is the fallback. Keys live in
  `~/.config/golive/credentials`, a local plaintext file with restricted POSIX permissions.
  The execution code keeps values out of plans, state and command output. Mac login passwords stay
  with macOS/vendor authentication prompts; GoLive never asks you to enter one in its key dialog.
- **Updates have an owner.** Skills CLI manages its installs. The optional own installer supports
  whole-bundle updates and local rollback; automatic replacement is off by default. Update between
  deployment runs, never between a plan and its apply. Cloud resources are unaffected by rollback.
- **Your accounts remain yours.** GoLive does not buy services or create billing accounts.
  Your coding agent, providers and installer have their own data practices.

## Contribute

🤝 **We're early, and we'd love your help shaping GoLive.** Bug reports, feature ideas, docs fixes
and pull requests are all welcome. You don't need to build an adapter to contribute: an unclear
login instruction or a real launch that got stuck is useful feedback too.

Open an issue to report a problem or discuss an idea, or send a focused PR. For a larger provider
or workflow addition, consider starting an issue so we can agree on the scope together. Never include secrets
or raw authentication responses in a report.

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for local setup, tests and your first contribution.
The [architecture](docs/ARCHITECTURE.md), [provider scope](docs/PROVIDERS.md) and
[validation record](docs/VALIDATION.md) explain what exists and where help is needed.

[MIT licensed](LICENSE). Bundled third-party notices are included in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
