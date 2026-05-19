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
   * List every allowlisted hostname for a tenant. Both `isDefault=TRUE`
   * (seeded) and admin-added rows are returned. Used by the sanitiser
   * to validate every `<img src>` host (FR-011).
   */
  findByTenantId(tenantId: TenantSlug): Promise<readonly AllowlistEntry[]>;

  /**
   * Add an admin-authored hostname. Returns `duplicate` if the
   * `(tenant_id, hostname)` pair already exists (unique index defined
   * in migration 0164). Emits `broadcast_image_allowlist_updated`
   * audit at the use case boundary (Phase 4 T072 — NOT the port).
   */
  add(
    tenantId: TenantSlug,
    hostname: Hostname,
    actorUserId: string,
  ): Promise<Result<void, AllowlistAddError>>;

  /**
   * Remove an admin-authored hostname. Refuses to remove rows with
   * `is_default=TRUE` per FR-010 platform invariant.
   */
  remove(
    tenantId: TenantSlug,
    hostname: Hostname,
  ): Promise<Result<void, AllowlistRemoveError>>;
}
