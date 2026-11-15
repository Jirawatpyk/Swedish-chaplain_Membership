# Contract: UI import ratchet

The block comes from `uiRatchet()` in `eslint.ui-ratchet.mjs`, spread at the end of `eslint.config.mjs`. It uses **`@typescript-eslint/no-restricted-imports`**, a distinct rule id, so it never replaces the architecture `no-restricted-imports` blocks.

| Banned | Where | From | Message |
|---|---|---|---|
| `sonner` | all `src/**`, `tests/**` | US0 | Use `@/lib/toast`. |
| `cmdk` | all `src/**`, `tests/**` | US0 (its one host went with the kit at US13a) | Use AURA `Command` or `Combobox`. |
| `formatDate`, `useFormatDate` from `@jirawatpyk/aura-react` (`importNames`) | all `src/**` | US0 | Use `@/lib/format-date-localised`. |
| `@/components/ui`, `@/components/ui/*` | all `src/**`, `tests/**` | per phase through `MIGRATED_PATHS`; global since US13a | The legacy kit was removed. |

- **Until US13a** the kit ban was path by path: `MIGRATED_PATHS` in `eslint.config.mjs` grew per phase. At US13a the kit was deleted, the ban became global and the list went.
- **A new block on this rule id must restate every ban:** flat config replaces a rule's options per matching block, within this rule id too.

## Test (RED first)

`tests/unit/architecture/ui-import-ratchet.test.ts` runs `ESLint.lintText` through the real config and asserts each ban fires: `sonner`, AURA `formatDate`, `cmdk`, and a legacy-kit import at one path per area (the shell, both portals, components, `src/lib`, `src/modules`, the fixtures, unit and e2e tests). As a control, an AURA import at the same paths passes.
