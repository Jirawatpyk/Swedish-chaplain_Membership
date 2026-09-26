# Contract: UI import ratchet

This is one block appended at the end of `eslint.config.mjs`. It uses **`@typescript-eslint/no-restricted-imports`**, a distinct rule id, so it never replaces the architecture `no-restricted-imports` blocks.

| Banned | Where | From | Message |
|---|---|---|---|
| `sonner` | all `src/**`, `tests/**` | US0 | Use `@/lib/toast`. |
| `cmdk` | all `src/**` | `warn` in US0, `error` from US1 | Use AURA `Command`. |
| `formatDate`, `useFormatDate` from `@jirawatpyk/aura-react` (`importNames`) | all `src/**` | US0 | Use `@/lib/format-date-localised`. |
| `@/components/ui/*` | files matching `MIGRATED_PATHS` | the list grows per phase; empty in US0 | This path is on AURA. |

- **Where the list lives:** `MIGRATED_PATHS` is an exported array in `eslint.config.mjs`. Each phase PR adds its globs.
- **Exit:** at US13 the old-kit ban becomes global and the list is deleted.

## Test (RED first)

`tests/unit/architecture/ui-import-ratchet.test.ts` runs `ESLint.lintText` on fixtures and asserts each ban fires:
- importing `sonner`
- importing `formatDate` from `@jirawatpyk/aura-react`
- a fixture path listed in `MIGRATED_PATHS` importing `@/components/ui/button`

As a control, the same fixture outside `MIGRATED_PATHS` passes.
