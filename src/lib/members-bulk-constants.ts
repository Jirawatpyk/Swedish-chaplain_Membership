/**
 * Shared client-safe constants for bulk actions.
 *
 * Lives in `src/lib/` (not `@/modules/members`) so client components
 * can import without pulling the Drizzle / postgres server-only deps
 * the members barrel transitively exposes.
 *
 * KEEP IN SYNC with `src/modules/members/application/use-cases/bulk-action.ts`
 * (BULK_CAP, BULK_RATE_MAX, BULK_RATE_WINDOW_SECONDS). A future
 * refactor could collapse these into a single Domain-layer constants
 * file if we move rate limit config out of the use case.
 */
export const BULK_CAP = 100;
export const BULK_RATE_MAX = 10;
export const BULK_RATE_WINDOW_SECONDS = 600;
export const ARCHIVE_TYPED_PHRASE_THRESHOLD = 5;
