/**
 * F8 Phase 4 Wave I2b — `MemberRenewalFlagsRepo` Application port.
 *
 * F8-internal port for the F8-owned lifecycle of two flags on the F3
 * `members` table: `email_unverified` (BOOLEAN) +
 * `email_unverified_at` (TIMESTAMPTZ). F3 only DEFINES the schema (Phase
 * 2 Wave C migration 0094); F8 OWNS the writes:
 *
 *   - T090 `detectBounceThreshold` (Wave I2d) → `setEmailUnverified`
 *   - T091 `resetEmailUnverified` (this wave) → `clearEmailUnverified`
 *
 * Keeping the surface inside F8 avoids invasive changes to F3's public
 * `MemberRepo` port — F3 stays stable; F8 owns the renewal-relevant
 * mutations through its own port + adapter that deep-imports F3's
 * Drizzle schema (precedent: `drizzle-renewal-cycle-repo.ts` line 26).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 *
 * `tx: TenantTx` brand (J6-H6): the platform-wide Drizzle pg-transaction
 * type from `@/lib/db`. Importing the type alias is permitted by the
 * Application-layer ESLint guard (only the `drizzle-orm` package itself
 * is forbidden, not the project's `@/lib/db` re-export). Replacing the
 * prior `tx: unknown` prevents accidentally passing the wrong arg in
 * the first slot — TS now rejects `null`, the deps object, etc.
 */
import type { TenantTx } from '@/lib/db';
import type { RiskBand } from '../../domain/value-objects/risk-band';
import type { AT_RISK_FACTOR_WEIGHTS } from '../../domain/at-risk-score';

export interface MemberRenewalFlagsMutationResult {
  /**
   * The PRIOR state of `email_unverified` BEFORE the mutation. Lets the
   * use-case branch on "was this a meaningful change" without an extra
   * round-trip read. Adapter computes via single `RETURNING old_value`
   * pattern.
   *
   * NOTE: when the member row is RLS-hidden (cross-tenant probe) or
   * non-existent, the adapter returns `previouslyUnverified=false` AND
   * `affectedRows=0` so the use-case can detect the no-op case.
   */
  readonly previouslyUnverified: boolean;
  /**
   * Number of rows affected by the UPDATE. `0` on RLS-hidden /
   * non-existent member; `1` on successful mutation.
   */
  readonly affectedRows: number;
}

/**
 * Phase 5 Wave A (T124 / T135) — generic toggle-result for boolean
 * flag mutations on `members`. `previousValue` is the prior flag state
 * BEFORE the mutation so the use-case can branch on idempotency
 * without an extra round-trip read.
 */
export interface MemberFlagToggleResult {
  readonly previousValue: boolean;
  readonly affectedRows: number;
}

/**
 * Phase 5 Wave A (T135) — input shape for setting the
 * `blocked_from_auto_reactivation` flag. Migration 0094's CHECK
 * constraint requires `_at IS NOT NULL` AND `_set_by_user_id IS NOT
 * NULL` whenever the flag is TRUE; `_reason` is optional but
 * recommended for forensic clarity. Adapter sets `_at = NOW()`.
 */
export interface SetBlockedFromAutoReactivationInput {
  readonly memberId: string;
  readonly actorUserId: string;
  readonly reason?: string;
}

export interface MemberRenewalFlagsRepo {
  /**
   * Set `members.email_unverified=TRUE` + `email_unverified_at=NOW()`.
   * Used by T090 detect-bounce-threshold when bounce thresholds cross.
   * Idempotent — re-setting an already-true flag does NOT update
   * `email_unverified_at` (preserves the original threshold-crossing
   * timestamp).
   */
  setEmailUnverified(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<MemberRenewalFlagsMutationResult>;

  /**
   * Set `members.email_unverified=FALSE` + `email_unverified_at=NULL`.
   * Used by T091 reset-email-unverified when F1 verification flow
   * succeeds. Idempotent — clearing an already-false flag is a no-op
   * silent return (`previouslyUnverified=false`, `affectedRows=1` if
   * the row exists).
   */
  clearEmailUnverified(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<MemberRenewalFlagsMutationResult>;

  /**
   * Phase 5 Wave A (T124) — Set `members.renewal_reminders_opted_out=TRUE`
   * + `renewal_reminders_opted_out_at=NOW()` per FR-016. Member self-
   * service portal route exposes this as a single toggle. Cron skips
   * email but still lists the cycle in pipeline + creates tasks.
   * Idempotent — re-setting preserves the original opt-out timestamp.
   */
  setRenewalRemindersOptedOut(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<MemberFlagToggleResult>;

  /**
   * Phase 5 Wave A (T124) — Clear opt-out (member opts back in).
   * `renewal_reminders_opted_out=FALSE` + `renewal_reminders_opted_out_at=NULL`.
   */
  clearRenewalRemindersOptedOut(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<MemberFlagToggleResult>;

  /**
   * Phase 5 Wave A (T135) — Admin override to block auto-reactivation
   * on lapsed cycles per FR-005b. Sets `blocked_from_auto_reactivation=
   * TRUE` + `_at=NOW()` + `_set_by_user_id=actorUserId` + `_reason=...`
   * atomically. CHECK constraint guarantees the four columns stay
   * consistent. Idempotent — re-block by the same admin preserves
   * original `_at`.
   */
  setBlockedFromAutoReactivation(
    tx: TenantTx,
    tenantId: string,
    input: SetBlockedFromAutoReactivationInput,
  ): Promise<MemberFlagToggleResult>;

  /**
   * Phase 5 Wave A (T135) — Clear block (admin unblocks). All four
   * columns reset to (FALSE, NULL, NULL, NULL) atomically per the
   * CHECK constraint.
   */
  clearBlockedFromAutoReactivation(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<MemberFlagToggleResult>;

  /**
   * Phase 5 Wave B (T123) — read the `blocked_from_auto_reactivation`
   * flag in the same tx as a downstream cycle transition. The F4
   * onPaidCallback uses this to decide whether a paid lapsed cycle
   * should auto-complete (default) or hold in `pending_admin_reactivation`
   * (override). Returns `null` when the member row is RLS-hidden or
   * non-existent.
   */
  readBlockedFromAutoReactivation(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<boolean | null>;

  /**
   * COMP-1 L3 — combined single-round-trip read of BOTH reactivation guards
   * on the F4 invoice-paid hot path: the admin `blocked_from_auto_reactivation`
   * flag AND the GDPR-erased state (`erased_at IS NOT NULL`). Folds what were
   * two separate SELECTs against the SAME `members` row into one.
   *
   * Both guards route a paid lapsed cycle to the admin-hold path instead of
   * auto-reactivating:
   *   - `blocked` — an admin explicitly blocked auto-reactivation (FR-005b).
   *   - `erased` — erasure forces `blocked_from_auto_reactivation = FALSE` (the
   *     0094 CHECK forbids the flag staying TRUE once its provenance is
   *     scrubbed) and keeps `status`, so the block flag alone no longer fences
   *     an erased member; the F4 onPaidCallback must HOLD an erased member's
   *     paid lapsed cycle for admin review rather than silently reactivating an
   *     anonymised tombstone.
   *
   * Returns `null` when the member row is RLS-hidden or non-existent (the
   * caller treats this the same as both-guards-false → auto-complete).
   */
  readReactivationGuardsInTx(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<{ readonly blocked: boolean; readonly erased: boolean } | null>;

  /**
   * C7 review-fix (Phase 5 Wave I): SSR-seed the preferences toggle
   * on `/portal/preferences/renewals`. Reads `renewal_reminders_opted_out`
   * directly so members already opted out see the toggle in the
   * correct state on revisit (F3 Member entity does not expose this
   * F8-owned column). Returns `null` when the member row is RLS-hidden.
   */
  readRenewalRemindersOptedOut(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<boolean | null>;

  /**
   * Phase 6 Wave B (T154) — persist the at-risk score result onto F3
   * `members.risk_score_*` columns. Adapter writes:
   *   - `risk_score = input.score` (smallint)
   *   - `risk_score_band = input.band`
   *   - `risk_score_factors = input.factors` (jsonb)
   *   - `risk_score_last_computed_at = input.computedAt`
   * Atomic UPDATE inside the supplied tx; returns the PRIOR band so the
   * use-case can detect band-crossings and emit
   * `at_risk_score_threshold_crossed` per FR-031. Idempotent — repeat
   * writes with the same band yield `previousBand === input.band` and
   * the use-case skips the threshold-crossed audit.
   */
  setRiskScore(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
    input: SetRiskScoreInput,
  ): Promise<SetRiskScoreResult>;

  /**
   * Phase 6 Wave B (T155) — persist `members.risk_snoozed_until` per
   * FR-032 (admin can snooze 7 / 30 / 90 days from at-risk widget).
   * Atomic UPDATE inside the supplied tx; returns affected-rows so the
   * use-case can detect RLS-hidden / non-existent members. Adapter
   * sets `risk_snoozed_until = input.snoozedUntil` (ISO 8601 UTC).
   */
  setRiskSnoozedUntil(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
    snoozedUntil: string,
  ): Promise<MemberFlagToggleResult>;

  /**
   * Phase 6 Wave C (T161) — list active member IDs for the weekly at-
   * risk recompute cron loop. Filters per FR-007a canonical active
   * definition: `members.status === 'active'` AND member has at least
   * one renewal cycle whose `status NOT IN ('lapsed', 'cancelled')`.
   *
   * Returns a flat string[] (member UUIDs only) ordered by `member_id
   * ASC` for deterministic batch processing. Tenant-scoped via RLS;
   * caller MUST invoke inside `runInTenant`.
   *
   * `limit` is optional — caller passes `undefined` for "all active
   * members" (cron's normal mode) or a small value for testing /
   * pagination. The cron's per-tenant SLO (60s @ 5,000 members per
   * FR-036 + SC-005) is verified by T174 perf test.
   */
  listActiveMemberIdsForAtRiskRecompute(
    tx: TenantTx,
    tenantId: string,
    limit?: number,
  ): Promise<ReadonlyArray<string>>;

  /**
   * Phase 6 Wave G T159b — bulk-write all members' at-risk score
   * results in one round-trip. Used by `recomputeAtRiskScoresBatch`
   * to hit the FR-036 + SC-005 60s @ 5,000 members SLO. Adapter
   * uses `UPDATE … FROM jsonb_to_recordset(...)` to apply N updates
   * in a single SQL statement.
   *
   * `computedAt` is the cron-pass-wide single timestamp (so all rows
   * share `risk_score_last_computed_at` for that pass).
   */
  bulkSetRiskScores(
    tx: TenantTx,
    tenantId: string,
    rows: ReadonlyArray<BulkSetRiskScoreRow>,
    computedAt: Date,
  ): Promise<{ readonly affectedRows: number }>;

  /**
   * Phase 6 Wave G T159b — bulk gather factor inputs for the at-risk
   * recompute cron. Single CTE that joins F3 members + F4 invoices
   * aggregate; filters per FR-007a (active member def). Returns ALL
   * active members' factors in one round-trip.
   */
  gatherAtRiskFactorsForTenant(
    tx: TenantTx,
    tenantId: string,
  ): Promise<ReadonlyArray<AtRiskBatchFactorRow>>;

  /**
   * Phase 6 Wave D (T163) — paginated read of at-risk members for the
   * admin "At-Risk Members" widget at /admin/renewals. Filters:
   *   - `members.risk_score >= 50` (warning + at-risk + critical bands
   *     surface; healthy band hidden)
   *   - `members.risk_snoozed_until IS NULL OR risk_snoozed_until <
   *     NOW()` (auto-expired snoozes re-appear)
   *
   * Optional `band` filter narrows further (warning | at-risk |
   * critical). Cursor pagination on `(risk_score DESC, member_id ASC)`
   * for deterministic ordering — the partial index
   * `members_at_risk_idx` (migration 0094) covers the hot path.
   *
   * Returns a page of widget rows + `nextCursor` (null when last page)
   * + summary aggregate (band counts + f6_active + active_max).
   * Tenant-scoped via RLS.
   */
  listAtRiskWidgetMembers(
    tx: TenantTx,
    tenantId: string,
    opts: ListAtRiskWidgetOpts,
  ): Promise<ListAtRiskWidgetResult>;
}

export interface ListAtRiskWidgetOpts {
  readonly band?: 'warning' | 'at-risk' | 'critical';
  /** Opaque cursor (server-encoded `${score}|${memberId}`); null = first page. */
  readonly cursor?: string | null;
  /** 1–50; default 20. */
  readonly limit?: number;
}

export interface AtRiskWidgetMemberRow {
  readonly memberId: string;
  readonly companyName: string | null;
  readonly riskScore: number;
  readonly riskScoreBand: 'warning' | 'at-risk' | 'critical';
  /**
   * Phase 6 review S3 — typed key constraint matches the write port's
   * `BulkSetRiskScoreRow.factors` shape. Reads + writes use the same
   * factor-key vocabulary drawn from the FR-029 weight table.
   */
  readonly riskScoreFactors: Partial<
    Record<keyof typeof AT_RISK_FACTOR_WEIGHTS, number>
  > | null;
  readonly riskScoreLastComputedAt: string | null;
  readonly riskSnoozedUntil: string | null;
}

export interface ListAtRiskWidgetResult {
  readonly items: ReadonlyArray<AtRiskWidgetMemberRow>;
  readonly nextCursor: string | null;
  readonly summary: {
    readonly warning: number;
    readonly atRisk: number;
    readonly critical: number;
  };
}

/**
 * Phase 6 Wave B (T154) — input shape for `setRiskScore`. Mirrors the
 * F3 `members.risk_score_*` columns added by migration 0094.
 *
 * `factors` is a per-key contribution map keyed by FR-029 factor names
 * (e.g. `{ events_attended_last_12mo_zero: 25,
 * invoices_overdue_count_gt_zero: 25 }`). Adapter serialises to JSONB.
 *
 * `computedAt` is ISO 8601 UTC — the cron's run-start timestamp; one
 * timestamp per cron pass so all members in the same recompute share
 * `risk_score_last_computed_at` and dashboards can group by run.
 */
export interface SetRiskScoreInput {
  readonly score: number;
  readonly band: RiskBand;
  readonly factors: Partial<
    Record<keyof typeof AT_RISK_FACTOR_WEIGHTS, number>
  >;
  readonly computedAt: string;
}

/**
 * Phase 6 Wave G T159b — per-member row shape for `bulkSetRiskScores`.
 * Adapter assembles UPDATE rows from this shape via
 * `jsonb_to_recordset(...)`.
 */
export interface BulkSetRiskScoreRow {
  readonly memberId: string;
  readonly score: number;
  readonly band: RiskBand;
  readonly factors: Partial<
    Record<keyof typeof AT_RISK_FACTOR_WEIGHTS, number>
  >;
}

/**
 * Phase 6 Wave G T159b — per-member factor-input row returned by
 * `gatherAtRiskFactorsForTenant`. Adapter computes the LATERAL JOIN
 * aggregates from F2 + F3 + F4 + F7 + F1 audit_log; the use-case
 * derives AtRiskFactors values in-memory.
 *
 * 6 of 8 FR-029 factors covered by this row shape:
 *   ✓ tenureDays                — derived from memberCreatedAt
 *   ✓ daysSinceContactUpdate    — derived from lastActivityAtIso
 *   ✓ invoicesOverdueCount      — direct
 *   ✓ daysSinceLastPayment      — derived from lastPaidAtIso
 *   ✓ eBlastQuotaPctUsed        — direct (null when plan has no
 *                                  eblast_per_year benefit)
 *   ✓ tierDowngradedLast12Months — direct boolean
 *   ⊘ eventsAttendedLast12Months — F6-dependent (skip via FR-029a)
 *   ⊘ eventsAttendedLast3Months  — F6-dependent
 *   ⊘ culturalTicketQuotaPctUsed — F6-dependent
 */
export interface AtRiskBatchFactorRow {
  readonly memberId: string;
  readonly memberCreatedAt: string; // ISO 8601 UTC
  readonly lastActivityAtIso: string | null; // ISO 8601 UTC or null
  readonly priorRiskBand: RiskBand | null;
  readonly invoicesOverdueCount: number;
  readonly lastPaidAtIso: string | null; // ISO 8601 UTC or null
  /**
   * F7 quota usage percentage (0–100). Null when the member's plan
   * has no `eblast_per_year` benefit (e.g. partnership tier with
   * unmetered quota or thai_alumni with quota=0). Domain skips the
   * factor when null.
   */
  readonly eblastQuotaPctUsed: number | null;
  /**
   * True when the member's plan tier was downgraded in the last 12
   * months (F1 audit_log scan). FR-029 line 8 weight +15.
   */
  readonly tierDowngradedLast12Months: boolean;
}

export interface SetRiskScoreResult {
  /**
   * The PRIOR band BEFORE the mutation, or `null` when the row had no
   * band yet (first compute) OR when the row is RLS-hidden /
   * non-existent (`affectedRows === 0`). Use-case detects threshold
   * crossings by comparing `previousBand` vs `input.band` per FR-031.
   */
  readonly previousBand: RiskBand | null;
  readonly affectedRows: number;
}
