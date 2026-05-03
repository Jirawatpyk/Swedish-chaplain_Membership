/**
 * F8 — Renewals public barrel.
 *
 * Module is bootstrapped at `/speckit.implement` Phase 1 (T002).
 * All cross-module access from outside `src/modules/renewals/` MUST go through this barrel
 * (enforced by `eslint.config.mjs` no-restricted-imports rule per Constitution Principle III).
 *
 * Exports populate during Phase 2+ as Domain entities + Application use-cases ship:
 *   - Domain branded types + aggregates (`./domain/*`)
 *   - Application audit-event types (`./application/ports/audit-port`)
 *   - Application use-cases + composition-root factories (`./application/*` + `./infrastructure/*-deps`)
 *   - Infrastructure adapters (selective barrel exposure for cross-module bridge use only)
 */
export {};
