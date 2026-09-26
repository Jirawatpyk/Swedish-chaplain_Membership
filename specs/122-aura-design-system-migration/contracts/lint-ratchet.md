# Contract: UI import ratchet

The blocks come from `uiRatchet(MIGRATED_PATHS)` in `eslint.ui-ratchet.mjs`, spread at the end of `eslint.config.mjs`. It uses **`@typescript-eslint/no-restricted-imports`**, a distinct rule id, so it never replaces the architecture `no-restricted-imports` blocks.

| Banned | Where | From | Message |
|---|---|---|---|
| `sonner` | all `src/**`, `tests/**` | US0 | Use `@/lib/toast`. |
| `cmdk` | all `src/**` except `src/components/ui/command.tsx` | US0 (the exemption goes with the file in US1) | Use AURA `Command`. |
| `formatDate`, `useFormatDate` from `@jirawatpyk/aura-react` (`importNames`) | all `src/**` | US0 | Use `@/lib/format-date-localised`. |
| `@/components/ui/*` | files matching `MIGRATED_PATHS` | the list grows per phase; empty in US0 | This path is on AURA. |

- **Where the list lives:** `MIGRATED_PATHS` is an array in `eslint.config.mjs`. Each phase PR adds its globs.
- **Every block restates the global bans:** flat config replaces a rule's options per matching block, within this rule id too.
- **Exit:** at US13 the old-kit ban becomes global and the list is deleted.

## Test (RED first)

`tests/unit/architecture/ui-import-ratchet.test.ts` runs `ESLint.lintText` through the real config and asserts each ban fires (the migrated-path case appends `uiRatchet([fixtureGlob])` via `overrideConfig`):
- importing `sonner`
- importing `formatDate` from `@jirawatpyk/aura-react`
- a fixture path listed in `MIGRATED_PATHS` importing `@/components/ui/button`

As a control, the same fixture outside `MIGRATED_PATHS` passes.
