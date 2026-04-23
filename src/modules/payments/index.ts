/**
 * Public barrel for the `payments` bounded context (F5 Online Payment).
 *
 * The ONLY surface that code OUTSIDE `src/modules/payments/**` may
 * import from. ESLint barrel-guard rule (eslint.config.mjs) blocks
 * deep imports into `./domain/**`, `./application/**`, and
 * `./infrastructure/**` per Constitution Principle III (Clean
 * Architecture boundary enforcement).
 *
 * Currently empty — populated as F5 Phase 2 sub-batches D + E land
 * Domain types (payment/refund aggregate + value objects), Application
 * use-cases (initiate-payment, confirm-payment, issue-refund, …), and
 * composition-root factories for route handlers. See
 * `specs/009-online-payment/tasks.md` § Phase 3+ for the incoming
 * exports.
 *
 * NOTE on Infrastructure (T027): `src/modules/payments/infrastructure/
 * schema.ts` Drizzle tables + row types are intentionally NOT
 * re-exported here — they're Infrastructure-only per Principle III.
 * Repository adapters translate DB rows into Domain aggregates before
 * anything leaves the module.
 */

export { SYSTEM_ACTOR_STRIPE_WEBHOOK } from './domain/system-actors';
