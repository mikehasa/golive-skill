# Agent instructions for this repo

Read `docs/ARCHITECTURE.md`, `src/core/types.ts` and `docs/VALIDATION.md` before making changes. They define
the product contract and distinguish implemented capabilities from observed live validation.

Rules:
- **Secrets:** never print, `cat`, log or paste a secret, and never ask a human to paste one into
  chat. In code, wrap credentials in `Secret` (src/core/secret.ts). Pass them only via child stdin or
  an HTTP header/body, and never on argv or in errors, logs, previews, state or reports.
- **Writes:** nothing touches a real account without the human approving the specific `plan` first.
  Live payments and DNS need explicit confirmation, and nothing that costs money is ever automated.
- **Tests:** every change ships with vitest tests that use `test/helpers.ts` / `test/fakes.ts` mocks.
  Tests never hit the network. Before finishing, run `pnpm vitest run && pnpm tsc --noEmit && pnpm build`.
- **Bundle:** `pnpm build` generates the runtime, installer helpers and `skills/golive/release.json`.
  Keep generated artifacts consistent with their source; never hand-edit runtime bytes or hashes.
  Runtime dependencies must stay at zero. Use Node 24 for tests and Node 20 for runtime compatibility.
- **Translations:** `README.<lang>.md` are full translations of `README.md`, and English is
  authoritative — they never state a claim the English README does not, and never strengthen or weaken
  one. Keep fenced code blocks byte-identical, never translate identifiers, link in-page anchors as
  `README.md#anchor`, and update the `golive-translation` marker (`source-commit`, `updated`) when you
  touch one. `test/readme-translations.test.ts` guards section order, switcher, code blocks, versions
  and links; `reviewed=true` needs a named native-speaker reviewer. Write idiomatically for a native
  developer, not word for word.
- **Git:** commit or push only when the human asks.
