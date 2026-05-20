/**
 * T022 (F7.1a US2) — `ImageAllowlistPort` Application port.
 *
 * Per-tenant `<img src>` hostname allowlist (FR-010). Body-HTML
 * sanitiser (Phase 4 T070 `validateImageSourceAllowlist`) checks every
 * `<img>` source hostname against this port's result; non-matching
 * submissions are rejected at submit boundary with
 * `broadcast_body_image_source_unsafe` audit.
 *
 * Tenant isolation: all methods take `TenantSlug`; the Drizzle adapter
 * (T027 `drizzle-image-allowlist-repo.ts`) runs inside `runInTenant()`
 * so RLS+FORCE (migration 0166) is the storage-layer guard.
 *
 * Defaults invariant (FR-010): rows with `isDefault=TRUE` MUST NOT be
 * removable by admins (the chamber asset domain + Resend CDN always
 * remain allowlisted). The `remove()` method returns
 * `cannot_remove_default` for those rows. Default seeding is deferred
 * to runtime (Phase 4 T072 `manage-image-allowlist.ts`) since migration
 * 0164 cannot iterate tenants (no central `tenants` table — verified
 * 2026-05-19 against live Neon).
 *
 * Hostname format invariant (FR-010): exact lowercase ASCII matches
 * only — no wildcards. The Domain layer (Phase 4 T069
 * `image-source-allowlist.ts`) introduces a `Hostname` branded type
 * via `asHostname(string): Result<Hostname, ...>`. This port surface
 * uses `Hostname` (Domain type) so the boundary preserves the
 * invariant — callers cannot pass a raw `string` here.
 *
 * Pure interface — no framework imports (Constitution Principle III
 * NON-NEGOTIABLE).
 */

import type { Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants';

/**
 * Opaque tx handle threaded by the use-case so a port mutation +
 * audit emit share one Drizzle/postgres-js transaction (Constitution
 * Principle I clause 3 atomicity). When omitted, the adapter opens
 * its own `runInTenant` scope. Use-cases that need to bind mutation
 * + audit to the same tx (`manageImageAllowlist`) MUST pass the
 * outer tx through. Typed as `unknown` to keep the port pure
 * (avoids leaking the Drizzle/postgres-js type into Application).
 *
 * PR-review fix 2026-05-20 CR-H1 — atomic-tx threading.
 */
export type ImageAllowlistTx = unknown;

/**
 * Hostname Domain branded type. The full Domain definition lands in
 * Phase 4 T069; this port declares the type-name alias to avoid a
 * circular Phase 2 ↔ Phase 4 ordering constraint. The string-shape is
 * RFC-1035 lowercase ASCII, ≥1 dot, no wildcards. Validation lives in
 * `asHostname` Domain VO (Phase 4 T069). Migration 0164's CHECK
 * constraint provides DB-layer enforcement.
 */
export type Hostname = string & { readonly __brand: 'Hostname' };

export interface AllowlistEntry {
  readonly hostname: Hostname;
  readonly isDefault: boolean;
}

export type AllowlistAddError =
  | { readonly kind: 'invalid_hostname'; readonly detail: string }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'storage_error'; readonly detail: string };

export type AllowlistRemoveError =
  | { readonly kind: 'cannot_remove_default' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'storage_error'; readonly detail: string };

export interface ImageAllowlistPort {
  /**
   * Open a tenant-bound transaction + invoke `fn` with the tx handle.
   * The use-case threads `tx` through subsequent `port.add` /
   * `port.remove` calls AND `audit.emit(tx, …)` so mutation + audit
   * land in ONE atomic unit (Constitution Principle I clause 3).
   *
   * PR-review fix 2026-05-20 CR-H1 — mirror of F7 MVP `BroadcastsRepo.
   * withTx` pattern. Contract tests mock this by immediately invoking
   * `fn(null)` so the use-case logic runs against the port mocks
   * without needing a real DB connection.
   */
  withTx<T>(tenantId: TenantSlug, fn: (tx: ImageAllowlistTx) => Promise<T>): Promise<T>;

  /**
   * List every allowlisted hostname for a tenant. Both `isDefault=TRUE`
   * (seeded) and admin-added rows are returned. Used by the sanitiser
   * to validate every `<img src>` host (FR-011).
   */
  findByTenantId(tenantId: TenantSlug): Promise<readonly AllowlistEntry[]>;

  /**
   * Idempotently seed default `is_default=TRUE` entries for a tenant
   * — the platform-mandated allowlist anchors that admins cannot
   * remove (FR-010). Phase 4 T072 `manage-image-allowlist.ts` use
   * case calls this on first admin visit to the allowlist editor OR
   * on first member compose-with-image, BEFORE any `findByTenantId`
   * read that the sanitiser depends on.
   *
   * Migration 0164 originally seeded these in-SQL via `FOR t_id IN
   * SELECT id FROM tenants LOOP`, but the project has no central
   * `tenants` table (verified 2026-05-19) so seeding moved to
   * runtime. This method exists at the port surface to document
   * that lazy-seeding contract — Phase 4 implementation idempotent
   * via the `(tenant_id, hostname)` unique index from migration 0164.
   *
   * Typical seed values for a new tenant onboarding (will be Phase
   * 4 T072 responsibility, NOT this port):
   *   - tenant's own asset domain (e.g. `swecham.zyncdata.app`)
   *   - email provider CDN (`resend.com`)
   *
   * Idempotent: re-calling with the same hostnames is a no-op
   * (ON CONFLICT DO NOTHING at the storage layer). No audit event
   * — seed is a platform action, not an admin decision.
   */
  seedDefaults(
    tenantId: TenantSlug,
    hostnames: readonly Hostname[],
  ): Promise<void>;

  /**
   * Add an admin-authored hostname. Returns `duplicate` if the
   * `(tenant_id, hostname)` pair already exists (unique index defined
   * in migration 0164). Emits `broadcast_image_allowlist_updated`
   * audit at the use case boundary (Phase 4 T072 — NOT the port).
   *
   * Optional `tx` parameter (PR-review fix 2026-05-20 CR-H1) — when
   * provided the adapter uses that tx directly (no nested
   * `runInTenant`); when omitted the adapter opens its own scope.
   * Threading the outer tx lets `manageImageAllowlist` commit the
   * mutation + audit-emit atomically.
   */
  add(
    tenantId: TenantSlug,
    hostname: Hostname,
    actorUserId: string,
    tx?: ImageAllowlistTx | null,
  ): Promise<Result<void, AllowlistAddError>>;

  /**
   * Remove an admin-authored hostname. Refuses to remove rows with
   * `is_default=TRUE` per FR-010 platform invariant.
   *
   * Optional `tx` parameter (PR-review fix 2026-05-20 CR-H1) — same
   * semantics as `add` for atomic-tx threading.
   */
  remove(
    tenantId: TenantSlug,
    hostname: Hostname,
    tx?: ImageAllowlistTx | null,
  ): Promise<Result<void, AllowlistRemoveError>>;
}
