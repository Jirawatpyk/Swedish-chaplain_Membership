/**
 * Canonical `invoicing/<slug>/logos/...` blob-key utilities.
 *
 * Single source of truth for:
 *   - PATCH /api/tenant-invoice-settings logo_blob_key cross-tenant
 *     prefix guard (route-level startsWith check).
 *   - Unit-test pin (`tests/unit/invoicing/logo-blob-key-guard.test.ts`)
 *     — imports this module directly so a refactor of the prefix
 *     format fails the test instead of silently drifting.
 *
 * The trailing `/` is load-bearing: without it, slug `abc` would
 * accidentally match keys under `abcdef/logos/...` (slug-prefix
 * collision). Never inline this pattern elsewhere — always route
 * through `buildLogoBlobPrefix`.
 *
 * Lives in `src/lib/` (not the invoicing module barrel) because it is
 * a pure string utility with no Domain / Application coupling — the
 * guard happens at the route boundary.
 */

export function buildLogoBlobPrefix(slug: string): string {
  return `invoicing/${slug}/logos/`;
}
