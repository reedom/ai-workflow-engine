# TODOS

## Packaging

### Verify dist artifacts exist in CI before publish

**Priority:** P2

`test/packaging.test.ts` checks that the exports map is internally consistent,
but nothing verifies that `pnpm build` actually emits `dist/index.js` and
`dist/index.d.ts` (a tsconfig include change could drop the barrel silently).
`prepublishOnly` runs the build, which narrows the window, but a CI step that
builds and asserts the artifacts (or `npm pack --dry-run` contents) closes it.
Surfaced by the ship test-coverage audit on `feat/embed-api` (2026-06-12).
Start at: a GitHub Actions workflow running build + test + artifact check.

## Escalation

### Warn when a settings.json fails to parse

**Priority:** P3

`readPermissions` in `src/escalation/rules.ts` swallows all errors, so a
corrupted `settings.json` silently drops its deny rules — a call the operator
denied would instead escalate to a human who might approve it. A parse-failure
warning through the run log closes the silent gap. Surfaced by the adversarial
review on `feat/embed-api` (2026-06-12). Depends on: threading a logger into
`loadHomeDeferRules`/`loadProjectDeferRules` (currently pure functions).

## Completed
