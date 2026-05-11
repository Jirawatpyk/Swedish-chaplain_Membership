/**
 * F8 — client-safe re-export surface for the renewals bounded context.
 *
 * The full public barrel (`@/modules/renewals`) re-exports server-side
 * use-cases (cancel-cycle, dispatch-renewal-cycle, retry-failed-reminders,
 * etc.) which transitively pull in `@/lib/db`, `postgres`, `pino` and
 * other Node-only modules. Turbopack 16 walks barrel re-exports
 * eagerly when ANY client component imports from the barrel — even
 * type-only imports — so the result is "Module not found: 'fs' /
 * 'net' / 'worker_threads' / 'child_process'" build failures.
 *
 * This file exposes ONLY the client-safe surface (domain enums + value
 * objects + repo-port row shapes) so client components can import
 * type identifiers and tier-bucket arrays without dragging the
 * server-side graph into the browser bundle.
 *
 * Cross-module rule (Constitution Principle III): `client.ts` lives at
 * the module root — NOT inside `domain/`, `application/`, or
 * `infrastructure/` — so ESLint's no-restricted-imports allows
 * external consumers to import from here.
 *
 * Use this from `src/components/renewals/*`, `src/app/(staff)/admin/
 * renewals/_components/*`, and `src/app/(member)/portal/renewal/*`.
 * Server components + use-case callers should keep using the full
 * barrel (`@/modules/renewals`).
 */
export {
  TIER_BUCKETS,
  type TierBucket,
} from './domain/value-objects/tier-bucket';

export { type CycleStatus } from './domain/value-objects/cycle-status';

export type {
  PipelineRow,
  UrgencyBucket,
} from './application/ports/renewal-cycle-repo';
