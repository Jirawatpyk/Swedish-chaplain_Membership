/**
 * T023 (F7.1a US7) — `BroadcastTemplatesPort` Application port.
 *
 * Admin-authored broadcast template library (FR-016 .. FR-023). The
 * Drizzle adapter (T028 `drizzle-broadcast-templates-repo.ts`) runs
 * inside `runInTenant()` so RLS+FORCE (migration 0166) is the
 * storage-layer guard. Migration 0168 seeds 5 starter templates × 3
 * locales = 15 rows per production tenant at ship.
 *
 * Snapshot semantics (FR-019 / SC-007a): the broadcast `started_from
 * _template_id` FK uses `ON DELETE SET NULL`, and `templateNameSnapshot`
 * (TEXT column on broadcasts) preserves the template name for forensic
 * audit (per critique P9) even if the template is later deleted. The
 * snapshot itself is implemented at use case boundary (Phase 5 T102
 * `snapshot-template-to-draft.ts`) — this port just exposes the
 * required CRUD primitives.
 *
 * Soft-delete (`deletedAt` column, migration 0161): `softDelete()` sets
 * the column; `findByTenantId()` filters it out by default. Hard delete
 * is not exposed — FR-023 mandates the template-deletion audit retains
 * the `started_from_count` for forensics.
 *
 * Pure interface — no framework imports (Constitution Principle III
 * NON-NEGOTIABLE).
 */

import type { Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants';

/**
 * Opaque transaction token. The Drizzle adapter (Phase 5C) treats it
 * as a `TenantTx`; mocks treat it as `null`. Use cases pass the token
 * through to both the port's mutation methods AND `audit.emit(tx, ...)`
 * so the mutation + the audit row land in the SAME transaction
 * (Constitution Principle I clause 3 atomicity).
 */
export type BroadcastTemplatesTx = unknown;

export type TemplateLocale = 'en' | 'th' | 'sv';

export interface BroadcastTemplate {
  readonly id: string; // uuid
  readonly tenantId: TenantSlug;
  readonly name: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly locale: TemplateLocale;
  readonly startedFromCount: number;
  readonly isSeeded: boolean;
  readonly createdByUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface CreateTemplateInput {
  readonly name: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly locale: TemplateLocale;
  readonly createdByUserId: string;
}

export interface UpdateTemplateInput {
  readonly name?: string;
  readonly subject?: string;
  readonly bodyHtml?: string;
  readonly locale?: TemplateLocale;
}

export interface ListTemplatesOpts {
  /** Optional locale filter (Phase 5 T103 picker cascade). */
  readonly locale?: TemplateLocale;
  /** Include soft-deleted (default: false). */
  readonly includeDeleted?: boolean;
}

export type TemplateCreateError =
  | { readonly kind: 'duplicate_name'; readonly locale: TemplateLocale }
  | { readonly kind: 'invalid_input'; readonly detail: string }
  | { readonly kind: 'storage_error'; readonly detail: string };

export type TemplateUpdateError =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'duplicate_name'; readonly locale: TemplateLocale }
  | { readonly kind: 'invalid_input'; readonly detail: string }
  | { readonly kind: 'storage_error'; readonly detail: string };

export type TemplateDeleteError =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'storage_error'; readonly detail: string };

export interface BroadcastTemplatesPort {
  /**
   * Open a tenant-scoped transaction and invoke `callback` with a tx
   * token that the caller forwards to mutation methods + `audit.emit`.
   * Mirrors `ImageAllowlistPort.withTx` — mutation + audit share one
   * rollback boundary.
   */
  withTx<T>(
    tenantId: TenantSlug,
    callback: (tx: BroadcastTemplatesTx) => Promise<T>,
  ): Promise<T>;


  /**
   * Fetch a template by id, tenant-scoped. Returns `null` for
   * not-found OR cross-tenant (RLS + the explicit `tenantId` filter
   * are belt-and-braces).
   */
  findById(
    tenantId: TenantSlug,
    id: string,
  ): Promise<BroadcastTemplate | null>;

  /**
   * List templates for a tenant, MRU-ordered (updated_at DESC). Filters
   * `deletedAt IS NULL` by default. Phase 5 T103 picker uses this with
   * `opts.locale` filter for the cascade UX (`current_user_locale ||
   * tenant_default_locale || 'en'`).
   */
  findByTenantId(
    tenantId: TenantSlug,
    opts?: ListTemplatesOpts,
  ): Promise<readonly BroadcastTemplate[]>;

  /**
   * Create a new admin-authored template. Migration 0161's unique
   * index `broadcast_templates_tenant_name_locale_uniq` makes
   * `duplicate_name` deterministic at the storage boundary.
   */
  create(
    tenantId: TenantSlug,
    input: CreateTemplateInput,
    tx?: BroadcastTemplatesTx,
  ): Promise<Result<BroadcastTemplate, TemplateCreateError>>;

  /**
   * Update an existing template. Only changes the fields provided in
   * `input`. Refreshes `updated_at`.
   */
  update(
    tenantId: TenantSlug,
    id: string,
    input: UpdateTemplateInput,
    tx?: BroadcastTemplatesTx,
  ): Promise<Result<BroadcastTemplate, TemplateUpdateError>>;

  /**
   * Soft-delete: sets `deleted_at = now()`. Preserves audit trail per
   * FR-023. The template-deletion audit event (`broadcast_template_
   * deleted`) is emitted at the use case boundary (Phase 5 T101 —
   * NOT this port).
   */
  softDelete(
    tenantId: TenantSlug,
    id: string,
    tx?: BroadcastTemplatesTx,
  ): Promise<Result<void, TemplateDeleteError>>;

  /**
   * Increment `started_from_count` denormalised counter. Called by
   * `snapshotTemplateToDraft` (Phase 5 T102) at draft-start time.
   * Idempotent at row level (atomic UPDATE … SET started_from_count
   * = started_from_count + 1).
   */
  incrementStartedFromCount(
    tenantId: TenantSlug,
    id: string,
    tx?: BroadcastTemplatesTx,
  ): Promise<void>;
}
