/**
 * Public barrel for the `invoicing` bounded context (F4).
 *
 * This is the ONLY surface that code OUTSIDE `src/modules/invoicing/**`
 * may import from. The ESLint `no-restricted-imports` rule in
 * `eslint.config.mjs` blocks deep imports into `./domain/**`,
 * `./application/**`, and `./infrastructure/**` from anywhere but
 * inside this module.
 *
 * Exports are filled story-by-story as user stories land (US1 → US7).
 *
 * See specs/007-invoices-receipts/plan.md § Architecture for the
 * bounded-context + port-adapter rationale.
 */

export {};
