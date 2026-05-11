/**
 * F8 Phase 4 Wave I2c — `DispatchCandidateRepo` Application port.
 *
 * Composite-query reader for the daily dispatcher cron (T088
 * `dispatchRenewalCycle`) + the admin "Send reminder now" button
 * (T089 `sendReminderNow`). Returns enriched rows containing
 * everything `dispatchOneCycle` needs to run its decision tree:
 *
 *   - the renewal cycle (status, expires_at, period_from,
 *     cycle_length_months, tier_at_cycle_start)
 *   - the member (status, plan_id/plan_year, preferred_locale,
 *     email_unverified, renewal_reminders_opted_out, registration_date)
 *   - the primary contact (email, name, preferred_language) — nullable
 *     to handle the FR-019a "no primary contact email" graceful skip
 *   - the tier-bucket schedule policy (steps_jsonb parsed) — nullable
 *     to handle the "tenant_misconfigured" skip when a tenant has not
 *     yet seeded its 5 schedule policies
 *
 * Why a NEW port instead of extending `RenewalCycleRepo`: separation
 * of concerns. `RenewalCycleRepo` is the entity-CRUD surface;
 * `DispatchCandidateRepo` is a presentation-layer composite for the
 * dispatcher (same precedent as `loadPipelinePage` vs `findById`).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { CycleId, RenewalCycle } from '../../domain/renewal-cycle';
import type { TenantRenewalSchedulePolicy } from '../../domain/tenant-renewal-schedule-policy';
import type { SupportedLocale } from './renewal-gateway';

export interface DispatchCandidateMember {
  readonly memberId: string;
  readonly status: 'active' | 'inactive' | 'archived';
  readonly companyName: string;
  readonly preferredLocale: SupportedLocale | null;
  readonly emailUnverified: boolean;
  readonly renewalRemindersOptedOut: boolean;
  /** Used for FR-007a min-tenure-days check on certain reminder steps. */
  readonly registrationDate: string;
}

export interface DispatchCandidatePrimaryContact {
  readonly contactId: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly preferredLanguage: SupportedLocale;
}

export interface DispatchCandidate {
  readonly cycle: RenewalCycle;
  readonly member: DispatchCandidateMember;
  /** Null when the member has no primary contact (FR-019a graceful skip). */
  readonly primaryContact: DispatchCandidatePrimaryContact | null;
  /** Null when the tenant has not seeded a schedule for this tier_bucket. */
  readonly schedulePolicy: TenantRenewalSchedulePolicy | null;
}

export interface DispatchCandidateListArgs {
  /** Upper bound on `expires_at` — typically `now + maxOffsetDays`. */
  readonly cutoffExpiresAt: string;
  /** Maximum offset (positive integer days) any policy step has. */
  readonly maxOffsetDays: number;
  readonly pageSize: number;
  readonly cursor?: string;
}

export interface DispatchCandidatePage {
  readonly items: ReadonlyArray<DispatchCandidate>;
  readonly nextCursor: string | null;
}

export interface DispatchCandidateRepo {
  /**
   * Cursor-paginated list of cycles eligible for dispatch evaluation.
   * Ordered by `(expires_at ASC, cycle_id ASC)` for deterministic
   * batching. Filters out terminal cycle statuses + cycles whose
   * `expires_at` is older than `now - maxOffsetDays` (rare — only
   * relevant if grace period extends past the schedule's last step).
   */
  list(
    tenantId: string,
    args: DispatchCandidateListArgs,
  ): Promise<DispatchCandidatePage>;

  /**
   * Single-cycle lookup for `sendReminderNow`. Returns null when the
   * cycle does not exist OR is RLS-hidden (cross-tenant). The use-case
   * surfaces this as `cycle_not_found`.
   */
  findOne(
    tenantId: string,
    cycleId: CycleId,
  ): Promise<DispatchCandidate | null>;
}
