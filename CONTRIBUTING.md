# Contributing to GoLive 🤝

GoLive is an early alpha, and there is plenty to build together. Bug reports, confusing setup
steps, clearer docs, stronger verification and new provider integrations are all welcome.
You do not need to write an adapter to make a useful contribution.

Our goal is to help people finish everything between working code and a working live product,
on their own accounts. Start with the [roadmap](README.md#the-full-go-live-checklist-and-roadmap)
to see what exists, what is experimental and what we hope to support next.

## Where to start

- **Hit a rough edge?** Open an issue with the steps, expected result and what actually happened.
- **Found unclear guidance?** A small documentation or onboarding PR is very welcome.
- **Want to build something?** Look through existing issues; for a new provider or a larger
  workflow, consider opening an issue first to discuss the scope and avoid duplicate work.
- **Tried a real launch?** Tell us where you got stuck and which checks were missing. Describe
  the app and provider setup without sharing private account details.

Useful references:

- [Architecture](docs/ARCHITECTURE.md) — execution flow and safety boundaries.
- [Provider scope](docs/PROVIDERS.md) — supported capabilities and current limitations.
- [Validation](docs/VALIDATION.md) — observed live evidence and what is still unverified.
- [TypeScript contracts](src/core/types.ts) — the interfaces adapters, links and checks implement.

## Local development

Fork or clone this repository, then create a branch for your change. Use **Node.js 24** and
**pnpm** for source development; the installed runtime supports Node.js 20+.

```bash
pnpm install
pnpm vitest run
pnpm tsc --noEmit
pnpm build
```

These tests use mocked provider responses; no provider login or credentials are needed.

Source lives in `src/`, tests in `test/`, and the installable skill in `skills/`. The runtime
has **zero external package dependencies**. Keep that property when adding functionality.
`pnpm build` regenerates the bundled CLI, installer helpers and release manifest. Include changed
generated files in your PR; do not edit them by hand.

A plain build creates a development manifest with no release tag. Before committing generated
files, rebuild with `GOLIVE_RELEASE_REF=v0.1.0-alpha.4 pnpm build` (use the version in
`package.json` if it changes). CI uses that tagged build and checks that the committed bundle matches.

## Making a change

Keep PRs focused and explain the user-visible problem, the resulting behavior and how you checked
it. Screenshots or a short, sanitized example can help explain a confusing interaction.

- Behavior changes need mock-based regression tests using `test/helpers.ts` and `test/fakes.ts`.
  Tests must never contact real providers or depend on personal credentials.
- Documentation-only changes should have working links and commands that match the implementation;
  they do not need a test that simply repeats the prose.
- Provider changes should update the relevant reference under `skills/` and the public provider
  documentation. Record response shapes and failure cases without secret values.
- A new adapter is **experimental** until its complete workflow has live evidence. Mock coverage,
  an API success response and an end-to-end app test are different things; describe which you ran.

Before sending a PR, run the tests, TypeScript check and build above. Mention any checks you could
not run. Maintainers may ask for a narrower change or additional coverage before merging.

## Translations

`README.<lang>.md` at the repository root are full translations of `README.md`. **English is
authoritative:** a translation may lag in wording, and it must never be the place where a claim
appears that the English README does not make. `test/readme-translations.test.ts` guards the
structure — section order, switcher, code blocks, versions and links.

- Write for a native developer, not for a translator. A literal word-for-word rendering is a
  regression: rewrite idioms, units and sentence rhythm the way a native technical author would.
- Keep fenced code blocks byte-identical to `README.md`; only prose is translated. The
  paste-into-your-agent prompts stay English on purpose, so the same text produces the same behavior
  for every reader.
- Translate identifiers never (`golive.yaml`, `--confirm-destroy`, `auth.e2e`, provider and flag
  names, env vars, file names); gloss them in parentheses if a reader needs help.
- In-page anchors (`#install-from-npm`) name English headings, so link them as
  `README.md#install-from-npm` instead of guessing a translated fragment.
- Never strengthen or weaken a claim. “Implemented and mock-covered, not live-validated”, “skipped is
  not passed” and the four trust limits must survive translation intact.
- Keep the `golive-translation` marker on the first line current (`source-commit`, `updated`) when you
  touch a translation. Set `reviewed=true` only with a named native-speaker reviewer.
- Adding a language: add the file, add it to `TRANSLATIONS` in `test/readme-translations.test.ts`, and
  add the switcher entry to `README.md` and every translation. The test reports what you missed.
- When `README.md` gains a section, changes a command or moves to a new version, the test fails until
  the translations follow. Fix them in the same PR.

## Accounts, secrets and live testing

Issue reports should include the command, relevant versions, expected versus actual behavior,
and a **sanitized response shape**. Never include tokens, connection strings, cookies, credential
files, raw authentication responses or unreviewed logs. Resource IDs and account names can also
be private; replace them with placeholders.

In implementation code, keep credential values in the existing `Secret` wrapper and reveal them
only at the transport boundary. Never place them in command arguments, errors, plans, state or
reports. See the [architecture](docs/ARCHITECTURE.md#secret-and-network-boundaries) for details.

Live testing is separate from the automated suite. Use disposable resources and get the account
owner's approval for the specific plan before writes, and for cleanup before deletion. Never
automate purchases. Report the exact scope and limitations of live evidence in the validation
docs; do not mark skipped or guided steps as passed.

Thanks for helping make going live less of a scavenger hunt. 🚀
