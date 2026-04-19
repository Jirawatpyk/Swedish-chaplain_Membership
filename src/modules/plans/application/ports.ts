/**
 * F2 Plans — Application-layer port interfaces.
 *
 * The Application layer talks to Infrastructure through these abstract
 * ports; Infrastructure provides the concrete implementations (Drizzle
 * repos, Resend mailer, argon2 hasher, etc.). The composition root
 * `src/modules/plans/plans-deps.ts` wires the defaults, and the
 * Presentation layer can override any port for tests or special
 * flows (e.g. integration tests injecting a fake `ClockPort`).
 *
 * **Every port method that touches the database takes a
 * `TenantContext` explicitly** — Constitution v1.4.0 Principle I
 * clause 1 requires compile-time enforcement of tenant isolation.
 * A use case that forgets to pass the tenant is a TypeScript error,
 * not a runtime bug.
 *
 * Pure TypeScript — NO framework imports, NO ORM imports.
 * Lives in Application so it can be consumed by use cases without
 * importing from Infrastructure.
 */

import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type {
  Plan,
  PlanCategory,
  PlanSlug,
  PlanYear,
} from '../domain/plan';
import type { F2AuditEvent, F2AuditEventType } from '../domain/audit-event';
import type { PlanPatchOutput, PlanSchemaOutput } from '../domain/plan-validators';

// ---------------------------------------------------------------------------
// PlanRepo — read + write plans scoped by TenantContext
// ---------------------------------------------------------------------------

export type ListPlansFilter = {
  readonly year?: PlanYear;
  readonly category?: PlanCategory;
  readonly q?: string; // free-text over plan_name in active locale
  readonly activeOnly?: boolean;
  readonly showDeleted?: boolean;
};

export interface PlanRepo {
  /**
   * List plans for the tenant, optionally filtered. Defaults to the
   * current year + all categories + hide-deleted + include-inactive.
   * Callers MUST pass TenantContext — forgetting it is a TS error.
   */
  findByTenantAndYear(
    tenant: TenantContext,
    filter: ListPlansFilter,
  ): Promise<Plan[]>;

  /**
   * Find a single plan by composite key. Returns `undefined` when the
   * plan does not exist OR belongs to a different tenant (RLS
   * transparently filters it out). Application layer maps `undefined`
   * → `not_found` error to preserve the "404 never 403" rule.
   */
  findOne(
    tenant: TenantContext,
    planId: PlanSlug,
    year: PlanYear,
  ): Promise<Plan | undefined>;

  /** Insert a single plan — used by create + clone use cases. */
  insert(
    tenant: TenantContext,
    draft: PlanDraftInput,
  ): Promise<Plan>;

  /** Partial update. `updatedBy` is the F1 user UUID from the session. */
  update(
    tenant: TenantContext,
    planId: PlanSlug,
    year: PlanYear,
    patch: PlanPatchOutput,
    updatedBy: string,
  ): Promise<Plan | undefined>;

  /** Toggle `is_active`. No-op when already at the target state. */
  setActive(
    tenant: TenantContext,
    planId: PlanSlug,
    year: PlanYear,
    active: boolean,
    updatedBy: string,
  ): Promise<Plan | undefined>;

  /**
   * Set `deleted_at = deletedAt`, keeping `is_active` unchanged.
   * Application layer checks member-attachment via MemberAttachmentChecker
   * before calling this — the repo just writes.
   */
  softDelete(
    tenant: TenantContext,
    planId: PlanSlug,
    year: PlanYear,
    deletedAt: Date,
    updatedBy: string,
  ): Promise<Plan | undefined>;

  /**
   * Clear `deleted_at` and force `is_active = false` (US4 AS4: undelete
   * returns plans to inactive, never directly to active).
   */
  undelete(
    tenant: TenantContext,
    planId: PlanSlug,
    year: PlanYear,
    updatedBy: string,
  ): Promise<Plan | undefined>;

  /**
   * Atomically clone all non-deleted plans from `sourceYear` into
   * `targetYear` for the tenant. Refuses if `targetYear` already has
   * any plans for this tenant (returns a Result.err — the repo
   * surfaces the clash to the Application layer).
   */
  cloneYear(
    tenant: TenantContext,
    sourceYear: PlanYear,
    targetYear: PlanYear,
    activateCloned: boolean,
    createdBy: string,
  ): Promise<Result<CloneYearSummary, CloneYearError>>;

  /**
   * Count non-deleted plans for the tenant — used by the fee-config
   * currency-immutability guard (critique R1, T145). Excludes
   * soft-deleted rows.
   */
  countActiveForTenant(tenant: TenantContext): Promise<number>;
}

/**
 * What the insert + clone repo methods take as input. Separate from
 * `Plan` because the repo generates timestamps + ids, not the caller.
 */
export type PlanDraftInput = PlanSchemaOutput & {
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly isActive: boolean;
};

export type CloneYearSummary = {
  readonly sourceYear: PlanYear;
  readonly targetYear: PlanYear;
  readonly clonedPlanIds: readonly PlanSlug[];
  readonly count: number;
};

export type CloneYearError =
  | { readonly type: 'target_year_populated'; readonly existingCount: number }
  | { readonly type: 'source_year_empty' };

// R9 — FeeConfigRepo interface + FeeConfigPatch + FeeConfigUpsert
// REMOVED after the full Option-2 consolidation. Plans module reads
// VAT + currency via `PlansDeps.taxPolicy()` (F4 invoice_settings);
// create-invoice-draft reads registration_fee via
// `tenantSettingsRepo`. Integration tests seed fiscal config via the
// shared `seedTenantFiscal(...)` helper.

// ---------------------------------------------------------------------------
// AuditPort — writes F2 audit events into the F1 `audit_log` table
// ---------------------------------------------------------------------------

export type AuditContext = {
  readonly tenant: TenantContext;
  readonly actorUserId: string; // F1 user UUID OR 'system:seed' for scripts
  readonly requestId: string;
  readonly sourceIp: string | null;
};

export interface AuditPort {
  /**
   * Append one audit event. Validates `event` through
   * `auditPayloadSchema` before writing — a shape mismatch returns
   * `err({type: 'invalid_payload'})` instead of corrupting the log.
   */
  record(
    ctx: AuditContext,
    event: F2AuditEvent,
  ): Promise<Result<void, AuditError>>;
}

export type AuditError =
  | { readonly type: 'invalid_payload'; readonly issues: readonly string[] }
  | { readonly type: 'persist_failed'; readonly message: string };

// Re-export for use cases that need to type their audit-event args
export type { F2AuditEvent, F2AuditEventType };

// ---------------------------------------------------------------------------
// ClockPort — injectable clock for deterministic testing
// ---------------------------------------------------------------------------

export interface ClockPort {
  /** Returns the current UTC Date. Tests override with a fixed value. */
  now(): Date;
  /** Returns the current Gregorian year (4-digit). */
  currentYear(): number;
}

// ---------------------------------------------------------------------------
// MemberAttachmentChecker — F3 will replace with a real implementation
// ---------------------------------------------------------------------------

export interface MemberAttachmentChecker {
  /**
   * Count the active members currently attached to `(tenant, planId,
   * year)`. F2 stub always returns 0 (no member table yet). F3 swaps
   * in the real query via the same port.
   *
   * Used by `soft-delete-plan` to enforce FR-010: a plan with
   * attached members cannot be soft-deleted.
   */
  countActivePlanMembers(
    tenant: TenantContext,
    planId: PlanSlug,
    year: PlanYear,
  ): Promise<number>;
}

// ---------------------------------------------------------------------------
// PlansDeps — the bag every Application use case receives
// ---------------------------------------------------------------------------

/**
 * Standard dependency bag for plans use cases. Every use case that
 * reads the catalogue, mutates a plan, or writes audit events takes
 * (a subset of) this shape. The composition root in `plans-deps.ts`
 * provides the defaults; tests pass stubs.
 */
export type PlansDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  /**
   * R8 consolidation final — authoritative tax policy source (F4
   * invoice_settings, via the F4 barrel's `getTenantTaxPolicy`
   * facade wired in `plans-deps.ts`). Returns null for un-onboarded
   * tenants; readers surface a bootstrap error. The previous
   * `feeConfigRepo` dep + FeeConfigRepo port + infrastructure
   * adapter were removed after migration 0028 backfilled every
   * tenant's invoice_settings row.
   */
  readonly taxPolicy: () => Promise<{
    readonly currencyCode: string;
    readonly vatRateRaw: string;
  } | null>;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly members: MemberAttachmentChecker;
};
