/**
 * F8 Phase 3 Wave H1 · T060 — Drizzle adapter for `RenewalCycleRepo`.
 *
 * Implements the F8 port `RenewalCycleRepo` (Wave E T041) against the
 * `renewal_cycles` table (Wave C migration 0087). Tenant isolation is
 * enforced by Postgres RLS+FORCE — every method wraps its query in
 * `runInTenant(ctx, …)` which sets `SET LOCAL ROLE chamber_app` +
 * `SET LOCAL app.current_tenant`. NO explicit `WHERE tenant_id = ?` —
 * the policy adds it automatically (research.md § 7.1).
 *
 * Phase 3 (US1) directly exercises:
 *   - `findById` — for cycle-detail view
 *   - `transitionStatus` — for cancel + mark-paid-offline
 *   - `loadPipelinePage` — for /admin/renewals composite query
 *
 * Other methods (`insert`, `findActiveForMember`, `list`,
 * `listEligibleForDispatch`) are implemented for port completeness but
 * are exercised by Phase 4+ user-stories (cron dispatcher, member portal).
 */
import { and, asc, eq, ne, sql, inArray, desc, or, isNull, isNotNull, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { db, runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { parseThbDecimal, type ThbDecimal } from '@/lib/money';
import type { TenantContext } from '@/modules/tenants';
import { renewalCycles, type RenewalCycleRow } from '../schema-renewal-cycles';
import { renewalReminderEvents } from '../schema-renewal-reminder-events';
import { members } from '@/modules/members/infrastructure/db/schema-members';
// Deep import of the F4 invoices SCHEMA (not the invoicing barrel) — the
// pipeline "Covered" projection must know the ANCHOR invoice's effective-paid
// state (see `loadPipelinePage`). Schema-renewal-cycles.ts already deep-imports
// this same table for its composite FK, so this stays inside the existing
// dependency graph and avoids the barrel load-cycle that breaks tsx scripts.
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
// M1 (plan-change-ux, Option 1b) — deep import of the F4 credit_notes SCHEMA
// (not the invoicing barrel) so the effective-paid predicate + L1 pipeline can
// consult `retains_coverage` via a correlated EXISTS. Same deep-import discipline
// as `invoices` above — avoids the barrel load-cycle that breaks tsx scripts.
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
  InvoiceLinkConflictError,
  type AutoDraftEligiblePage,
  type IssuedAutoInvoiceOrphanRow,
  type ListMembersWithoutCycleOpts,
  type ListRenewalCyclesOpts,
  type MembershipInvoiceRef,
  type MembersWithoutCyclePage,
  type NewRenewalCycleInput,
  type StaleAutoDraftRow,
  type PipelineMoneyRaw,
  type PipelineQueryOpts,
  type PipelineQueryResult,
  type PipelineRow,
  type PipelineSort,
  type PipelineSummary,
  type RenewalCyclePage,
  type RenewalCycleRepo,
  type SettlementPreviewRow,
  type UrgencyBucket,
} from '../../application/ports/renewal-cycle-repo';
import type { MembershipBillCoverageRow } from '../../domain/membership-bill-coverage';
import {
  asCycleId,
  type ClosedReason,
  type CycleId,
  type RenewalCycle,
} from '../../domain/renewal-cycle';
import {
  assertCanTransition,
  InvalidCycleTransitionError,
  OPEN_CYCLE_STATUSES,
  OPEN_CYCLE_STATUSES_SQL_LIST,
  type CycleStatus,
} from '../../domain/value-objects/cycle-status';
import { TIER_BUCKETS, type TierBucket } from '../../domain/value-objects/tier-bucket';
import { tierBucketOrdinalCaseSql } from './tier-bucket-ordinal-sql';
import {
  foldRawMonths,
  bkkYearMonth,
  addMonthsToYm,
  bkkMonthStartInstant,
} from '../../domain/renewal-month-bucket';
import type { RenewalMonthAggregation } from '../../domain/renewal-month-bucket';

// ---------------------------------------------------------------------------
// Effective-paid coverage predicate (plan-change-ux task #24, MONEY)
// ---------------------------------------------------------------------------

/**
 * The EFFECTIVE-PAID coverage predicate shared by
 * `findMaxPaidThroughForMemberInTx` (the restore/comeback billing FRONTIER)
 * and `countSettledCyclesForMemberInTx` (the first_payment-vs-renewal
 * classifier). A cycle counts as PAID coverage only when its SETTLING invoice
 * is not fully reversed:
 *
 *   ( status = 'completed'    AND linked_inv NOT void/credited )   -- steady-state
 *   OR
 *   ( anchored_at IS NOT NULL AND anchor_inv NOT void/credited )   -- open-anchored
 *
 * TWO ARMS, because a cycle's settling invoice lives in DIFFERENT columns
 * across its lifecycle: an OPEN anchored cycle references `anchor_invoice_id`;
 * a COMPLETED steady-state cycle's settling invoice is stamped on
 * `linked_invoice_id` (and its `anchored_at` may be NULL). BOTH LEFT JOINs are
 * therefore required — the linked join is NOT optional, since steady-state
 * next-cycle rows (`anchored_at = NULL`) are counted ONLY via the
 * completed+linked arm. Each call site adds both joins with an EXPLICIT
 * `tenant_id` equality (application-layer defence-in-depth atop the isolating
 * RLS on `invoices`, Principle I two-layer). Each join is a PK seek on
 * `invoices(tenant_id, invoice_id)` → ≤1 row, so it never multiplies the
 * aggregate.
 *
 * `IS DISTINCT FROM` makes a NULL invoice status PASS — a LEFT JOIN miss
 * (R4 backfill: settling invoice id NULL, no in-system invoice; or a — never
 * happens for tax docs — hard-deleted invoice). HARD GUARDRAIL: never retract a
 * cycle whose settling invoice id is NULL. A full refund / void / full credit
 * note lands the settling invoice on 'void'/'credited' → RETRACTED; a PARTIAL
 * credit ('partially_credited') still PASSES → covered; 'paid' passes. The rule
 * is reason-agnostic and invoice-status-only (NO `closed_reason`, NO
 * `refunds`/`payments` join).
 *
 * *** M1 (plan-change-ux, Option 1b) — COVERAGE-RETAINED ESCAPE ***
 * A 'credited' settling invoice normally RETRACTS the period, but NOT when the
 * completing credit note was an F4-manual FULL membership 'keep' — a paperwork
 * correction where the member was NOT refunded, so coverage is RETAINED. That
 * intent is persisted on `credit_notes.retains_coverage`; the `credited` arm of
 * BOTH clauses below carries a correlated `EXISTS` escape (NOT a JOIN — the call
 * sites are MAX/COUNT aggregates and a credit_notes JOIN is 1..N per invoice,
 * which would inflate COUNT; `retains_coverage=TRUE` only ever lands on the ONE
 * completing full-membership retention note, so EXISTS is ≤1 per invoice and
 * preserves the ≤1-row-per-cycle aggregate). Each EXISTS carries an EXPLICIT
 * `credit_notes.tenant_id = <settling invoice>.tenant_id` predicate
 * (application-layer defence-in-depth atop the isolating RLS on `credit_notes`,
 * Principle I two-layer).
 *
 * *** DISPLAY + BILLING USE THE SAME EFFECTIVE-PAID RULE ***
 * The pipeline "Covered" cell derives the same notion in `loadPipelinePage`
 * (the `anchored` projection — anchor-only there, since the pipeline shows only
 * OPEN cycles), INCLUDING the M1 retains-coverage escape. If you add or change a
 * gate HERE, mirror it THERE, and vice versa: the moment two sites answer "was
 * this period paid for?" independently they drift, and the cost of drift here is
 * paid in money (mirrors the `refund-credit-note-requirement.ts` cross-reference
 * discipline).
 */
function effectivePaidCoverageSql(
  cycle: { readonly status: AnyPgColumn; readonly anchoredAt: AnyPgColumn },
  linkedInv: {
    readonly status: AnyPgColumn;
    readonly tenantId: AnyPgColumn;
    readonly invoiceId: AnyPgColumn;
  },
  anchorInv: {
    readonly status: AnyPgColumn;
    readonly tenantId: AnyPgColumn;
    readonly invoiceId: AnyPgColumn;
  },
): SQL {
  return sql`(
    (${cycle.status} = 'completed'
       AND ${linkedInv.status} IS DISTINCT FROM 'void'
       AND (${linkedInv.status} IS DISTINCT FROM 'credited'
            OR ${coverageRetainedExistsSql(linkedInv)}))
    OR
    (${cycle.anchoredAt} IS NOT NULL
       AND ${anchorInv.status} IS DISTINCT FROM 'void'
       AND (${anchorInv.status} IS DISTINCT FROM 'credited'
            OR ${coverageRetainedExistsSql(anchorInv)}))
  )`;
}

/**
 * M1 (plan-change-ux, Option 1b) — correlated `EXISTS` that is TRUE when the
 * settling invoice `inv` has a credit note with `retains_coverage = TRUE` (an
 * F4-manual FULL membership 'keep' retention note — member not refunded).
 * Correlated on the outer settling-invoice alias, so it stays ≤1 boolean per
 * outer row and never inflates the MAX/COUNT aggregates the predicate feeds.
 * The explicit `tenant_id` equality is application-layer defence-in-depth atop
 * the RLS on `credit_notes` (Principle I two-layer). Shared by the billing
 * predicate above AND the L1 pipeline read model so the two never diverge.
 */
function coverageRetainedExistsSql(inv: {
  readonly tenantId: AnyPgColumn;
  readonly invoiceId: AnyPgColumn;
}): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${creditNotes}
    WHERE ${creditNotes.tenantId} = ${inv.tenantId}
      AND ${creditNotes.originalInvoiceId} = ${inv.invoiceId}
      AND ${creditNotes.retainsCoverage} = TRUE
  )`;
}

/**
 * The PRE-task-#24 RAW coverage predicate (`status = 'completed' OR
 * anchored_at IS NOT NULL`), kept ONLY as an observability yardstick: computed
 * in the SAME aggregate pass as `effectivePaidCoverageSql` (a second FILTER, no
 * extra scan / round-trip) so `findMaxPaidThroughForMemberInTx` can log when the
 * effective-paid rule RETRACTS the frontier a refund/void reversed — making the
 * first prod occurrences of this silent money-behaviour change visible. This is
 * NOT a billing predicate; do NOT reintroduce it as a coverage filter.
 */
function rawPaidCoverageSql(cycle: {
  readonly status: AnyPgColumn;
  readonly anchoredAt: AnyPgColumn;
}): SQL {
  return sql`(${cycle.status} = 'completed' OR ${cycle.anchoredAt} IS NOT NULL)`;
}

// ---------------------------------------------------------------------------
// Row → Domain translation
// ---------------------------------------------------------------------------

/**
 * Translate a Drizzle row into a typed `RenewalCycle` discriminated
 * union member. The DB CHECK constraints (`closed_at IS NULL ↔
 * status terminal`, `pending_admin_reactivation ↔ entered_pending_at
 * NOT NULL`, `completed → linked_invoice_id NOT NULL`) guarantee the
 * narrowing assertions never fail in practice — but we use `as` here
 * since TS can't follow the conditional logic. Each branch maps the
 * row to exactly one union arm.
 */
/**
 * Asserts a value is non-null. Throws a uniform "F8 invariant violation"
 * error naming the cycleId + field so Sentry triage is trivial. Used to
 * collapse 5 near-identical null-checks across terminal-status arms in
 * `rowToDomain` (Round 3 polish).
 *
 * Round 4: comment correction — the helper preserves IM5's
 * **throw-on-null behaviour + Sentry-triage invariant** (`cycle X
 * status=Y but Z is null`), but the error TEXT changed from the
 * pre-helper combined form ("...closedAt or linkedInvoiceId is null...")
 * to per-field ("...closedAt is null..." then "...linkedInvoiceId is
 * null..."). Tests in tests/unit/renewals/infrastructure/
 * rowToDomain-invariants.test.ts assert the new message format.
 *
 * `asserts value is NonNullable<T>` makes the assertion narrow the type
 * for callers — TS knows the value is non-null after the call.
 */
export function assertPresent<T>(
  value: T,
  cycleId: string,
  status: string,
  field: string,
): asserts value is NonNullable<T> {
  if (value == null) {
    throw new Error(
      `F8 invariant violation: cycle ${cycleId} status=${status} but ${field} is null — DB CHECK constraint regression`,
    );
  }
}

export function rowToDomain(row: RenewalCycleRow): RenewalCycle {
  const base = {
    tenantId: row.tenantId,
    cycleId: asCycleId(row.cycleId),
    memberId: row.memberId,
    periodFrom: row.periodFrom.toISOString(),
    periodTo: row.periodTo.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    cycleLengthMonths: row.cycleLengthMonths,
    tierAtCycleStart: row.tierAtCycleStart as TierBucket,
    planIdAtCycleStart: row.planIdAtCycleStart,
    // Construction boundary (I-1): brand-validate the DB `decimal(12,2)`
    // column value into ThbDecimal. The DB CHECK keeps the stored shape
    // well-formed, so this never throws in practice — it pins the
    // invariant at the row→domain boundary so the frozen price the
    // §86/4 path consumes is brand-typed end to end.
    frozenPlanPriceThb: parseThbDecimal(row.frozenPlanPriceThb),
    frozenPlanTermMonths: row.frozenPlanTermMonths,
    frozenPlanCurrency: row.frozenPlanCurrency as 'THB',
    linkedCreditNoteId: row.linkedCreditNoteId,
    // Rolling-anchor refactor (migration 0238) — anchoredAt is the
    // discriminator; anchorInvoiceId is a forensic-only reference (NULL
    // for the R4 backfill of pre-system payments). Same Date-or-null
    // conversion pattern as closedAt/enteredPendingAt below.
    anchoredAt: row.anchoredAt ? row.anchoredAt.toISOString() : null,
    anchorInvoiceId: row.anchorInvoiceId ?? null,
    // F8-RP follow-up (migration 0243) — async reject-with-refund marker.
    // Same Date-or-null conversion as anchoredAt/closedAt; the id + actor
    // are plain text columns.
    rejectRefundInitiatedAt: row.rejectRefundInitiatedAt
      ? row.rejectRefundInitiatedAt.toISOString()
      : null,
    rejectRefundId: row.rejectRefundId ?? null,
    rejectActorUserId: row.rejectActorUserId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  const status = row.status as CycleStatus;
  const closedAt = row.closedAt ? row.closedAt.toISOString() : null;
  const closedReason = row.closedReason as ClosedReason | null;
  const enteredPendingAt = row.enteredPendingAt
    ? row.enteredPendingAt.toISOString()
    : null;
  const linkedInvoiceId = row.linkedInvoiceId;

  switch (status) {
    case 'upcoming':
    case 'reminded':
    case 'awaiting_payment':
      return {
        ...base,
        status,
        enteredPendingAt: null,
        closedAt: null,
        closedReason: null,
        linkedInvoiceId,
      };
    case 'pending_admin_reactivation': {
      assertPresent(enteredPendingAt, row.cycleId, status, 'enteredPendingAt');
      return {
        ...base,
        status,
        enteredPendingAt,
        closedAt: null,
        closedReason: null,
        linkedInvoiceId,
      };
    }
    case 'completed': {
      assertPresent(closedAt, row.cycleId, status, 'closedAt');
      assertPresent(linkedInvoiceId, row.cycleId, status, 'linkedInvoiceId');
      return {
        ...base,
        status,
        enteredPendingAt: null,
        closedAt,
        closedReason: closedReason as 'paid' | 'completed_offline' | 'admin_reactivated',
        linkedInvoiceId,
      };
    }
    case 'lapsed': {
      assertPresent(closedAt, row.cycleId, status, 'closedAt');
      return {
        ...base,
        status,
        enteredPendingAt: null,
        closedAt,
        // Round 5 staff-review (K24-S1): widened from `'lapsed' |
        // 'pending_reactivation_timed_out'` to include K24's new
        // `'grace_expired'` + `'payment_failed'` discriminants. Domain
        // `LapsedCycleFields.closedReason` already accepts all 4
        // values per `renewal-cycle.ts:158-165`; the narrower row-mapper
        // cast was a stale leftover from pre-K24 when only 2 reasons
        // could land in a `lapsed` row. Future TS narrowing on
        // `cycle.closedReason === 'grace_expired'` now compiles
        // correctly post-`findById`.
        closedReason: closedReason as
          | 'lapsed'
          | 'grace_expired'
          | 'payment_failed'
          | 'pending_reactivation_timed_out',
        linkedInvoiceId,
      };
    }
    case 'cancelled': {
      assertPresent(closedAt, row.cycleId, status, 'closedAt');
      return {
        ...base,
        status,
        enteredPendingAt: null,
        closedAt,
        closedReason: closedReason as 'cancelled' | 'admin_rejected_with_refund',
        linkedInvoiceId,
      };
    }
    default: {
      // Compile-time exhaustiveness + runtime loud-fail for DB enum
      // drift (e.g. a Phase 4+ migration adds a new status that an
      // older app build hasn't been recompiled against).
      const _exhaustive: never = status;
      throw new Error(
        `F8 row-mapper: unknown cycle status "${String(status)}" for cycle ${row.cycleId} — likely DB enum drift, app rebuild required (exhaustive: ${String(_exhaustive)})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Cursor encoding — Phase 3.5 W-08 HMAC-signed cursors
// ---------------------------------------------------------------------------
//
// Round 5 staff review flagged unsigned base64 cursors as a defence-in-
// depth gap: a malicious admin in tenant A who knows a cycleId from
// tenant B (via guessing or a previous probe) could craft a cursor
// that shifts the pagination window to that arbitrary position. RLS
// blocks the actual rows from being returned, but the crafted cursor
// produces an empty page WITHOUT any error signal — silent attack-
// surface noise.
//
// Phase 3.5 W-08 fix: HMAC-SHA256 sign the cursor payload with the
// existing `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` (already used by F8
// renewal-link tokens). Cursors include a 16-byte (base64url-encoded,
// 22-char) MAC tag; decode rejects on signature mismatch.
//
// Token format: `<base64url-payload>.<base64url-mac>`
// MAC input: payload bytes (NOT including the dot separator).

import { createHmac, timingSafeEqual } from 'node:crypto';

interface CursorPayload {
  readonly expiresAt: string;
  readonly cycleId: string;
  /**
   * Task 8 — the row's tier ordinal, carried ONLY for the tier sorts
   * (`tier_asc`/`tier_desc`) so the keyset comparison can be a lexicographic
   * `(tier_ord, expires_at, cycle_id)`. Absent for the expiry sorts (whose
   * key is just `(expires_at, cycle_id)`) and for `list()` /
   * `listEligibleForDispatch()` cursors — those callers pass a payload
   * without it, `encodeCursor` omits the field, and they never read it, so
   * their wire format is byte-unchanged.
   */
  readonly tierOrd?: number;
}

const CURSOR_MAC_BYTES = 16; // 128-bit truncation — tampering detection only

// Round 9 W-R8-3 — domain-separation prefix. The HMAC secret
// `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` is shared with renewal-link
// tokens (different wire format `v1.<payload>.<mac>`). The two message
// domains are structurally disjoint TODAY but lack explicit context
// binding — a future change to either format could create cross-purpose
// MAC reuse. Adding a constant `cursor-v1:` prefix to the HMAC input
// guarantees a renewal-link MAC NEVER verifies as a cursor MAC even if
// the payload bytes happen to coincide.
const CURSOR_MAC_DOMAIN_PREFIX = 'cursor-v1:';

function cursorMac(payloadB64: string): string {
  const secret = env.renewals.linkTokenSecretPrimary;
  return createHmac('sha256', secret)
    .update(CURSOR_MAC_DOMAIN_PREFIX, 'utf8')
    .update(payloadB64, 'utf8')
    .digest()
    .subarray(0, CURSOR_MAC_BYTES)
    .toString('base64url');
}

export function encodeCursor(payload: CursorPayload): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const mac = cursorMac(payloadB64);
  return `${payloadB64}.${mac}`;
}

export function decodeCursor(
  cursor: string | null | undefined,
): CursorPayload | null {
  if (!cursor) return null;
  try {
    const dotIdx = cursor.lastIndexOf('.');
    if (dotIdx <= 0) return null;
    const payloadB64 = cursor.slice(0, dotIdx);
    const macB64 = cursor.slice(dotIdx + 1);
    const expectedMac = cursorMac(payloadB64);
    // Constant-time compare to avoid timing side-channel on MAC verify.
    const got = Buffer.from(macB64, 'base64url');
    const want = Buffer.from(expectedMac, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      return null;
    }
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<CursorPayload>;
    if (
      typeof parsed.expiresAt !== 'string' ||
      typeof parsed.cycleId !== 'string'
    ) {
      return null;
    }
    const base = { expiresAt: parsed.expiresAt, cycleId: parsed.cycleId };
    // Carry `tierOrd` only when the payload actually had a finite one — a
    // legacy (pre-Task-8) cursor never encodes it, so the tier-sort keyset
    // guard in `loadPipelinePage` treats such a cursor as sort-incompatible
    // and resets to the first page rather than mis-comparing (exactOptional:
    // never attach an `undefined` field).
    return typeof parsed.tierOrd === 'number' && Number.isFinite(parsed.tierOrd)
      ? { ...base, tierOrd: parsed.tierOrd }
      : base;
  } catch {
    return null;
  }
}

/**
 * Build the next-cursor token for a paginated cycle query.
 * `pageRows` is the page-sized slice; `hasNextPage` is true when the
 * adapter fetched limit+1 rows and at least one was excluded.
 *
 * SCOPE the returned token encodes `(expiresAt, cycleId)` and is therefore
 * only meaningful for `expires_at`-ORDERED queries (`listEligibleForDispatch`,
 * `loadPipelinePage`), whose keyset WHERE/ORDER BY is `(expires_at, cycle_id)`.
 * It is NOT a valid cursor for the `created_at_desc` arm of `list()` — that
 * query orders by `(created_at DESC, cycle_id DESC)`, so paginating it with
 * this cursor would compare the wrong key and skip/repeat rows. This is benign
 * today: `ListRenewalCyclesOpts` has no `cursor` field, and the only
 * `created_at_desc` caller (`loadMemberRenewalStatus`) reads `items[0]` with
 * `pageSize: 1` and discards `nextCursor`. Do NOT start paginating a
 * `created_at_desc` query with the returned `nextCursor`.
 */
function buildNextCursor(
  pageRows: ReadonlyArray<{ expiresAt: Date; cycleId: string }>,
  hasNextPage: boolean,
): string | null {
  if (!hasNextPage || pageRows.length === 0) return null;
  const lastRow = pageRows[pageRows.length - 1]!;
  return encodeCursor({
    expiresAt: lastRow.expiresAt.toISOString(),
    cycleId: lastRow.cycleId,
  });
}

// ---------------------------------------------------------------------------
// Task 8 — sort-aware ORDER BY + keyset cursor for `loadPipelinePage`
// ---------------------------------------------------------------------------
//
// The pipeline keyset cursor MUST match the ACTIVE sort in all three places
// or "Next 50" dups/skips rows: the ORDER BY, the WHERE comparison, and the
// emitted next-cursor key. These three helpers are the single source of that
// agreement — change one, change all three.

/**
 * Raw `CASE tier … END` ordinal expression over `renewal_cycles.tier_at_cycle_start`,
 * built ONCE from the drift-guarded `tierBucketOrdinalCaseSql` (which mirrors
 * the Domain `TIER_BUCKETS` tuple). Reused verbatim in the tier ORDER BY and
 * the tier keyset WHERE so they can never disagree.
 */
const PIPELINE_TIER_ORDINAL_SQL = tierBucketOrdinalCaseSql(
  'renewal_cycles.tier_at_cycle_start',
);

/**
 * JS mirror of {@link PIPELINE_TIER_ORDINAL_SQL} — the tier ordinal for a bucket
 * value, with the SAME high sentinel (tuple length) the SQL CASE uses for an
 * unknown/NULL bucket. Feeds `buildPipelineNextCursor` so the encoded cursor
 * ordinal equals what the DB CASE would compute for that row.
 */
function pipelineTierOrdinal(bucket: string): number {
  const i = (TIER_BUCKETS as readonly string[]).indexOf(bucket);
  return i === -1 ? TIER_BUCKETS.length : i;
}

/** True for the two sorts whose keyset key includes the tier ordinal. */
function isTierSort(sort: PipelineSort): boolean {
  return sort === 'tier_asc' || sort === 'tier_desc';
}

/** ORDER BY clause for the active sort. Tiebreak is always `(expires_at, cycle_id)`. */
function pipelineOrderBySql(sort: PipelineSort): SQL {
  switch (sort) {
    case 'expires_at_desc':
      return sql`${renewalCycles.expiresAt} DESC, ${renewalCycles.cycleId} DESC`;
    case 'tier_asc':
      return sql`${sql.raw(PIPELINE_TIER_ORDINAL_SQL)} ASC, ${renewalCycles.expiresAt} ASC, ${renewalCycles.cycleId} ASC`;
    case 'tier_desc':
      return sql`${sql.raw(PIPELINE_TIER_ORDINAL_SQL)} DESC, ${renewalCycles.expiresAt} ASC, ${renewalCycles.cycleId} ASC`;
    case 'expires_at_asc':
    default:
      return sql`${renewalCycles.expiresAt} ASC, ${renewalCycles.cycleId} ASC`;
  }
}

/**
 * Keyset predicate: "this row sorts STRICTLY AFTER `cursor` under `sort`".
 * Direction-correct per column (a mixed-direction tier sort has a DESC
 * primary but an ASC tiebreak), so paginating a non-default sort never
 * dups/skips. The caller (`loadPipelinePage`) guarantees `cursor.tierOrd`
 * is present whenever `sort` is a tier sort.
 */
function pipelineKeysetWhereSql(sort: PipelineSort, cursor: CursorPayload): SQL {
  const expiresAtDate = new Date(cursor.expiresAt);
  // Shared `(expires_at, cycle_id)` ASC tiebreak — used by expires_at_asc AND
  // by both tier sorts (whose tiebreak the ORDER BY pins ASC).
  const expiresCycleAsc = or(
    sql`${renewalCycles.expiresAt} > ${cursor.expiresAt}`,
    and(
      eq(renewalCycles.expiresAt, expiresAtDate),
      sql`${renewalCycles.cycleId} > ${cursor.cycleId}`,
    ),
  )!;
  switch (sort) {
    case 'expires_at_desc':
      return or(
        sql`${renewalCycles.expiresAt} < ${cursor.expiresAt}`,
        and(
          eq(renewalCycles.expiresAt, expiresAtDate),
          sql`${renewalCycles.cycleId} < ${cursor.cycleId}`,
        ),
      )!;
    case 'tier_asc': {
      const tierOrd = cursor.tierOrd ?? 0;
      return or(
        sql`${sql.raw(PIPELINE_TIER_ORDINAL_SQL)} > ${tierOrd}`,
        and(sql`${sql.raw(PIPELINE_TIER_ORDINAL_SQL)} = ${tierOrd}`, expiresCycleAsc),
      )!;
    }
    case 'tier_desc': {
      const tierOrd = cursor.tierOrd ?? 0;
      return or(
        sql`${sql.raw(PIPELINE_TIER_ORDINAL_SQL)} < ${tierOrd}`,
        and(sql`${sql.raw(PIPELINE_TIER_ORDINAL_SQL)} = ${tierOrd}`, expiresCycleAsc),
      )!;
    }
    case 'expires_at_asc':
    default:
      return expiresCycleAsc;
  }
}

/**
 * Emit the next-cursor for the pipeline, sort-aware: it carries the tier
 * ordinal (computed to match {@link PIPELINE_TIER_ORDINAL_SQL}) for tier sorts
 * so the next page's keyset comparison has the full lexicographic key.
 */
function buildPipelineNextCursor(
  pageRows: ReadonlyArray<{ expiresAt: Date; cycleId: string; tierBucket: string }>,
  hasNextPage: boolean,
  sort: PipelineSort,
): string | null {
  if (!hasNextPage || pageRows.length === 0) return null;
  const lastRow = pageRows[pageRows.length - 1]!;
  return encodeCursor({
    expiresAt: lastRow.expiresAt.toISOString(),
    cycleId: lastRow.cycleId,
    ...(isTierSort(sort)
      ? { tierOrd: pipelineTierOrdinal(lastRow.tierBucket) }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Urgency derivation SQL (DB-side per FR-046)
// ---------------------------------------------------------------------------

/**
 * Build the SQL CASE expression that maps `(status, expires_at)` to one
 * of 8 urgency buckets. The access-state tail ('terminated'/'suspended')
 * short-circuits on status (mirroring deriveMembershipAccess); the pre-deadline
 * `t-*` countdown is derived from days-until-expiry by direct interval
 * comparison (sargable — uses `expires_at` index instead of EPOCH math).
 *
 * Bucket boundaries (FR-046, half-open windows so each cycle lands in
 * exactly one bucket):
 *   t-90:  expires_at  > NOW() + 60 days     (60..90 days — outer rim of the
 *                                              90-day pipeline window. Bucket
 *                                              name reflects "as of T-minus 90
 *                                              days from expiry"; the upper
 *                                              bound is enforced by the
 *                                              surrounding `expires_at <= NOW()
 *                                              + 90 days` baseFilter so cycles
 *                                              90+ days out never enter the
 *                                              result set.)
 *   t-60:  expires_at  > NOW() + 30 days     (30..60 days)
 *   t-30:  expires_at  > NOW() + 14 days     (14..30 days)
 *   t-14:  expires_at  > NOW() +  7 days     (7..14 days)
 *   t-7:   expires_at  > NOW() +  1 day      (1..7 days)
 *   t-0:   expires_at  > NOW()               (0..1 day, due today/tomorrow)
 *
 * The two access-state tail buckets are STATUS-first (no date window) and
 * mirror deriveMembershipAccess (renewal-cycle.ts) — the old 30-day 'grace'
 * window was removed (policy 059/065 dropped benefit-bearing grace):
 *   suspended:  status IN ('awaiting_payment','pending_admin_reactivation'),
 *               OR an expired non-terminal cycle (upcoming/reminded past
 *               expiry — the CASE ELSE arm)
 *   terminated: status='lapsed'
 */
/**
 * COMP-1 H4 — correlated "member is NOT GDPR-erased" predicate for the
 * cycle-only aggregate queries (pipeline summary + lapsed count) that do
 * NOT join `members`. Erasure keeps `members.status` + the cycle and stamps
 * only `erased_at`, so a cycle whose owning member was erased must be
 * dropped from every OPERATIONAL admin enumeration. Expressed as
 * `NOT EXISTS (... erased_at IS NOT NULL)` so it can be AND-ed into a
 * `GROUP BY` aggregate WITHOUT adding a join (which would otherwise force
 * the joined member columns into the GROUP BY). LEFT-JOIN-safe by
 * construction: a cycle with no member row at all has no erased member →
 * the NOT EXISTS passes → the cycle is kept (same semantics as the
 * `isNull(members.erasedAt)` filter used on the member-joined page query).
 */
const MEMBER_NOT_ERASED_SQL = sql`NOT EXISTS (
  SELECT 1 FROM ${members} m
  WHERE m.tenant_id = ${renewalCycles.tenantId}
    AND m.member_id = ${renewalCycles.memberId}
    AND m.erased_at IS NOT NULL
)`;

/**
 * Renewals-by-month planning set — the SINGLE predicate shared by the
 * `countCyclesByExpiryMonth` aggregation AND the month-filtered pipeline
 * rows, so `sum(all buckets) === count(this) === rows-per-bucket`
 * (reconciliation invariant). `OPEN_CYCLE_STATUSES` = the module's canonical
 * "an upcoming renewal that will actually happen" set; it deliberately
 * EXCLUDES `lapsed` (terminal — surfaced by the Lapsed tab) and
 * `pending_admin_reactivation` (a reopened money-hold). `MEMBER_NOT_ERASED_SQL`
 * (COMP-1 H4) is non-negotiable — dropping it would re-admit a GDPR-erased
 * member and break reconciliation with the month-filtered pipeline.
 */
const MONTH_PLANNING_MEMBER_SQL: SQL = and(
  inArray(renewalCycles.status, [...OPEN_CYCLE_STATUSES]),
  MEMBER_NOT_ERASED_SQL,
)!;

/** BKK wall-clock `'YYYY-MM'` bucket key for a cycle's `expires_at`. */
const EXPIRY_MONTH_SQL = sql<string>`to_char(${renewalCycles.expiresAt} AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM')`;

/**
 * Half-open `expires_at` bound for a `?month` bucket, in BKK. Used by the
 * month-filtered pipeline rows (Task 5) so the row set matches the bucket's
 * counted set exactly. Bounds are BKK month-start instants bound as ISO 8601
 * UTC strings (matching the `sql\`${expiresAt} <= ${nowIso}\`` string-bind
 * pattern used elsewhere in this repo — postgres.js cannot serialize a raw
 * `Date` interpolated into a `sql` fragment). No `to_char` in the WHERE, so
 * the `expires_at` index stays usable.
 */
function monthBoundPredicate(key: string, nowIso: string): SQL {
  const currentYm = bkkYearMonth(nowIso);
  if (key === 'overdue') {
    return sql`${renewalCycles.expiresAt} < ${bkkMonthStartInstant(currentYm).toISOString()}`;
  }
  if (key === 'later') {
    return sql`${renewalCycles.expiresAt} >= ${bkkMonthStartInstant(addMonthsToYm(currentYm, 12)).toISOString()}`;
  }
  return and(
    sql`${renewalCycles.expiresAt} >= ${bkkMonthStartInstant(key).toISOString()}`,
    sql`${renewalCycles.expiresAt} < ${bkkMonthStartInstant(addMonthsToYm(key, 1)).toISOString()}`,
  )!;
}

// The post-deadline tail of this CASE is a hand-written SQL encoding of the
// benefit-access SSOT `deriveMembershipAccess(cycle, now)` (renewal-cycle.ts
// :399-436). It is checked STATUS-FIRST, exactly as the domain predicate does,
// so the urgency pill/tabs never contradict the member's REAL access:
//   status='lapsed'                                   → 'terminated'
//   status IN (awaiting_payment, pending_admin_react) → 'suspended'
//   expired non-terminal (upcoming/reminded)          → 'suspended'  (ELSE)
//   not-yet-expired non-terminal (access = full)      → 't-*' countdown
// COLUMN PARITY (the anti-drift contract): deriveMembershipAccess reads ONLY
// `status` + `expiresAt` — the same two columns bound here — so this SQL can
// mirror it faithfully. A live-Neon reconciliation test seeds a status×expiry
// matrix and asserts this CASE agrees with deriveMembershipAccess, locking the
// two against silent drift (the CASE string literals are NOT type-checked).
// NB: 'completed'/'cancelled' never reach this CASE — the pipeline baseFilters
// exclude them (status NOT IN ('cancelled','completed')), the terminated tab is
// eq(status,'lapsed'), and the month lens uses OPEN_CYCLE_STATUSES — so the five
// statuses above are the entire domain of this expression.
const URGENCY_CASE_SQL = sql<UrgencyBucket>`
  CASE
    WHEN ${renewalCycles.status} = 'lapsed' THEN 'terminated'
    WHEN ${renewalCycles.status} IN ('awaiting_payment','pending_admin_reactivation') THEN 'suspended'
    WHEN ${renewalCycles.expiresAt} > NOW() + INTERVAL '60 days' THEN 't-90'
    WHEN ${renewalCycles.expiresAt} > NOW() + INTERVAL '30 days' THEN 't-60'
    WHEN ${renewalCycles.expiresAt} > NOW() + INTERVAL '14 days' THEN 't-30'
    WHEN ${renewalCycles.expiresAt} > NOW() + INTERVAL '7 days'  THEN 't-14'
    WHEN ${renewalCycles.expiresAt} > NOW() + INTERVAL '1 day'   THEN 't-7'
    WHEN ${renewalCycles.expiresAt} > NOW()                       THEN 't-0'
    ELSE 'suspended'
  END
`;

// ---------------------------------------------------------------------------
// Adapter factory (per-call, mirrors F7 broadcasts-deps pattern)
// ---------------------------------------------------------------------------

export function makeDrizzleRenewalCycleRepo(
  tenant: TenantContext,
): RenewalCycleRepo {
  return {
    async insert(
      tx: unknown,
      _tenantId: string,
      input: NewRenewalCycleInput,
    ): Promise<RenewalCycle> {
      const txDb = tx as typeof db;
      const inserted = await txDb
        .insert(renewalCycles)
        .values({
          tenantId: tenant.slug,
          cycleId: input.cycleId,
          memberId: input.memberId,
          // F8-completion Slice 1 — default 'upcoming' (the column
          // default + steady-state entry points); Slice 3 passes
          // 'awaiting_payment' for the admin lapsed-comeback fresh cycle.
          status: input.startStatus ?? 'upcoming',
          periodFrom: new Date(input.periodFrom),
          periodTo: new Date(input.periodTo),
          // expires_at trigger denormalises from period_to.
          expiresAt: new Date(input.periodTo),
          cycleLengthMonths: input.cycleLengthMonths,
          tierAtCycleStart: input.tierAtCycleStart,
          planIdAtCycleStart: input.planIdAtCycleStart,
          frozenPlanPriceThb: input.frozenPlanPriceThb,
          frozenPlanTermMonths: input.frozenPlanTermMonths,
        })
        .returning();
      const row = inserted[0];
      if (!row) {
        throw new Error('insert: returning produced no row');
      }
      return rowToDomain(row);
    },

    async findById(
      _tenantId: string,
      cycleId: CycleId,
    ): Promise<RenewalCycle | null> {
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select()
          .from(renewalCycles)
          .where(eq(renewalCycles.cycleId, cycleId))
          .limit(1);
        return rows[0] ? rowToDomain(rows[0]) : null;
      });
    },

    /**
     * Tx-bound variant of `findById` — Round 5 staff review B2 fix.
     * Uses the caller's tx handle so the read participates in the
     * surrounding transaction (and any advisory lock held in it).
     * Critical for the cancel-cycle + mark-paid-offline lock-protected
     * re-read to defeat TOCTOU. Tenant context is established by the
     * caller via `runInTenant` — this method does NOT re-open the
     * scope, so it MUST only be called from inside a `runInTenant`
     * block where `SET LOCAL app.current_tenant` is already set.
     *
     * Round 6 S-R5-6: `_tenantId` is intentionally unused — RLS
     * isolation comes from the inherited GUC, not a WHERE clause.
     * Adding a `WHERE tenant_id = $1` predicate would be redundant
     * AND would mask future RLS policy changes (the policy is the
     * single source of truth for tenant scope). Future maintainers:
     * do NOT add a tenant_id predicate, and do NOT remove the
     * surrounding `runInTenant` wrapping at the use-case layer — the
     * GUC chain is load-bearing.
     */
    async findByIdInTx(
      tx: unknown,
      _tenantId: string,
      cycleId: CycleId,
    ): Promise<RenewalCycle | null> {
      const txDb = tx as typeof db;
      const rows = await txDb
        .select()
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1);
      return rows[0] ? rowToDomain(rows[0]) : null;
    },

    /**
     * Phase 5 Wave B (T123) — F4 onPaidCallback dispatch helper. Looks
     * up the cycle by `linked_invoice_id` inside the F4 tx so the read +
     * subsequent transition see a consistent snapshot. RLS isolation
     * comes from the inherited tenant GUC.
     */
    async findByInvoiceIdInTx(
      tx: unknown,
      _tenantId: string,
      invoiceId: string,
    ): Promise<RenewalCycle | null> {
      const txDb = tx as typeof db;
      const rows = await txDb
        .select()
        .from(renewalCycles)
        .where(eq(renewalCycles.linkedInvoiceId, invoiceId))
        .limit(1);
      return rows[0] ? rowToDomain(rows[0]) : null;
    },

    async findActiveForMember(
      _tenantId: string,
      memberId: string,
    ): Promise<RenewalCycle | null> {
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select()
          .from(renewalCycles)
          .where(
            and(
              eq(renewalCycles.memberId, memberId),
              sql`${renewalCycles.status} NOT IN ('lapsed','cancelled','completed')`,
            ),
          )
          .limit(1);
        return rows[0] ? rowToDomain(rows[0]) : null;
      });
    },

    async findMostRecentForMember(
      _tenantId: string,
      memberId: string,
    ): Promise<RenewalCycle | null> {
      // Same tenant/RLS scoping as `findActiveForMember`, but INCLUDES a
      // `completed` cycle (only `lapsed`/`cancelled` are excluded) and orders
      // by newest `period_from` so the post-payment success page can display
      // the just-completed cycle. See the port doc (070).
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select()
          .from(renewalCycles)
          .where(
            and(
              eq(renewalCycles.memberId, memberId),
              sql`${renewalCycles.status} NOT IN ('lapsed','cancelled')`,
            ),
          )
          .orderBy(desc(renewalCycles.periodFrom))
          .limit(1);
        return rows[0] ? rowToDomain(rows[0]) : null;
      });
    },

    /**
     * F8-completion Slice 1 — tx-bound variant of `findActiveForMember`.
     * Uses the caller's tx handle so the read participates in the
     * surrounding transaction: it sees an uncommitted prior-cycle
     * `→completed` flip made earlier in the SAME tx (F4
     * `f8OnPaidCallbacks[0]` before `withTx` commits). Threads the F4
     * tx — NO `runInTenant` (the caller already established the tenant
     * GUC). MUST only be called from inside a `runInTenant` block where
     * `SET LOCAL app.current_tenant` is already set. Tenant scope comes
     * from the inherited GUC, NOT a `WHERE tenant_id` predicate — same
     * RLS precedent as `findByIdInTx`; `_tenantId` is intentionally
     * unused.
     */
    async findActiveForMemberInTx(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<RenewalCycle | null> {
      const txDb = tx as typeof db;
      const rows = await txDb
        .select()
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.memberId, memberId),
            sql`${renewalCycles.status} NOT IN ('lapsed','cancelled','completed')`,
          ),
        )
        .limit(1);
      return rows[0] ? rowToDomain(rows[0]) : null;
    },

    async findLatestCyclesForMembers(
      tenantId: string,
      memberIds: readonly string[],
    ): Promise<ReadonlyArray<RenewalCycle>> {
      if (memberIds.length === 0) return [];
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .selectDistinctOn([renewalCycles.memberId])
          .from(renewalCycles)
          .where(
            and(
              eq(renewalCycles.tenantId, tenantId),
              inArray(renewalCycles.memberId, [...memberIds]),
            ),
          )
          // DISTINCT ON requires the leading ORDER BY key to match the distinct
          // column; created_at DESC + cycle_id DESC picks the latest, deterministic
          // tiebreak. The single-read path (loadMemberRenewalStatus → list()
          // with sort:'created_at_desc') applies the SAME created_at DESC,
          // cycle_id DESC ordering, so both paths resolve the identical latest
          // cycle on an equal created_at (S1 speckit-review).
          .orderBy(
            renewalCycles.memberId,
            desc(renewalCycles.createdAt),
            desc(renewalCycles.cycleId),
          );
        return rows.map(rowToDomain);
      });
    },

    /**
     * 059-membership-suspension Task 2 — single-row sibling of
     * `findLatestCyclesForMembers`. NO status filter (unlike
     * `findMostRecentForMember`, which excludes lapsed/cancelled) — the
     * whole point is to let `deriveMembershipAccess` see a `lapsed`/
     * `cancelled` row so it can gate access. Same ordering key
     * (`created_at DESC, cycle_id DESC`) as the batch method above so the
     * suspension gate and the admin badge never disagree on "latest".
     *
     * 107-auto-invoice Task 14 review (IMPORTANT) — two-layer tenant
     * isolation (Constitution Principle I, NON-NEGOTIABLE). This is a
     * system-wide membership-access GATE, not an isolated read: 8 call
     * sites across `membership-access-bridge.ts` (F3/F4/F6/F7),
     * `mark-paid-offline.ts`, `lapsed-portal-scope.ts`, and
     * `load-latest-cycle.ts`. RLS+FORCE already made cross-tenant reads
     * return nothing, but Principle I requires the explicit app-layer
     * filter too — same fix already applied to the batched twin
     * `findLatestCyclesForMembers` above.
     */
    async findLatestCycleForMember(
      tenantId: string,
      memberId: string,
    ): Promise<RenewalCycle | null> {
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select()
          .from(renewalCycles)
          .where(
            and(
              eq(renewalCycles.tenantId, tenantId),
              eq(renewalCycles.memberId, memberId),
            ),
          )
          .orderBy(desc(renewalCycles.createdAt), desc(renewalCycles.cycleId))
          .limit(1);
        return rows[0] ? rowToDomain(rows[0]) : null;
      });
    },

    async list(
      _tenantId: string,
      opts: ListRenewalCyclesOpts,
    ): Promise<RenewalCyclePage> {
      return runInTenant(tenant, async (tx) => {
        const filters: SQL[] = [];
        if (opts.statusFilter && opts.statusFilter.length > 0) {
          filters.push(inArray(renewalCycles.status, opts.statusFilter as unknown as string[]));
        }
        if (opts.memberIdFilter) {
          filters.push(eq(renewalCycles.memberId, opts.memberIdFilter));
        }
        if (opts.excludeCycleId) {
          filters.push(ne(renewalCycles.cycleId, opts.excludeCycleId));
        }
        if (opts.maxDaysUntilExpiry !== undefined) {
          filters.push(
            sql`${renewalCycles.expiresAt} <= NOW() + (${opts.maxDaysUntilExpiry} || ' days')::interval`,
          );
        }
        if (opts.excludeErasedMembers === true) {
          // COMP-1 H4 — drop cycles whose member is GDPR-erased. Opt-in so
          // ONLY the operational pending-reactivation-review queue filters;
          // the reconcile cron + per-member detail callers keep reading the
          // erased member's own cycles. Correlated NOT EXISTS keeps `list`
          // join-free (see `MEMBER_NOT_ERASED_SQL`).
          filters.push(MEMBER_NOT_ERASED_SQL);
        }
        const whereClause = filters.length > 0 ? and(...filters) : undefined;

        const rows = await tx
          .select()
          .from(renewalCycles)
          .where(whereClause)
          .orderBy(
            // `created_at_desc` adds `cycle_id DESC` as a deterministic
            // tiebreak so this single-read path (used by
            // loadMemberRenewalStatus) picks the SAME latest cycle as the
            // batch `findLatestCyclesForMembers` DISTINCT-ON when two cycles
            // share an identical `created_at` — otherwise the portal chip
            // and admin badge could disagree (S1 speckit-review).
            //
            // NOTE: the `nextCursor` returned below encodes `(expires_at,
            // cycle_id)` — valid ONLY for the expires_at-ordered sorts. It
            // is meaningless for THIS `created_at_desc` ordering and MUST NOT
            // be used to paginate it (see `buildNextCursor`). Harmless today:
            // `ListRenewalCyclesOpts` has no cursor field and the lone
            // created_at_desc caller reads `items[0]` with `pageSize: 1`.
            opts.sort === 'created_at_desc'
              ? sql`${renewalCycles.createdAt} DESC, ${renewalCycles.cycleId} DESC`
              : opts.sort === 'expires_at_desc'
                ? sql`${renewalCycles.expiresAt} DESC`
                : sql`${renewalCycles.expiresAt} ASC`,
          )
          .limit(opts.pageSize + 1);

        const hasNextPage = rows.length > opts.pageSize;
        const pageRows = hasNextPage ? rows.slice(0, opts.pageSize) : rows;
        return {
          items: pageRows.map(rowToDomain),
          nextCursor: buildNextCursor(pageRows, hasNextPage),
        };
      });
    },

    async updateFrozenPlan(
      tx: unknown,
      _tenantId: string,
      cycleId: CycleId,
      args: {
        readonly planIdAtCycleStart: string;
        readonly tierAtCycleStart: TierBucket;
        readonly frozenPlanPriceThb: ThbDecimal;
        readonly frozenPlanTermMonths: number;
        readonly frozenPlanCurrency: 'THB' | 'SEK' | 'EUR' | 'USD';
      },
    ): Promise<RenewalCycle> {
      const txDb = tx as typeof db;
      const updated = await txDb
        .update(renewalCycles)
        .set({
          planIdAtCycleStart: args.planIdAtCycleStart,
          tierAtCycleStart: args.tierAtCycleStart,
          frozenPlanPriceThb: args.frozenPlanPriceThb,
          frozenPlanTermMonths: args.frozenPlanTermMonths,
          frozenPlanCurrency: args.frozenPlanCurrency,
        })
        .where(
          and(
            eq(renewalCycles.cycleId, cycleId),
            eq(renewalCycles.status, 'awaiting_payment'),
          ),
        )
        .returning();
      const row = updated[0];
      if (!row) {
        // Either cycle moved out of awaiting_payment or RLS hid it.
        // Re-read to surface the actual status in the conflict error so
        // the use-case can render a precise user-friendly message.
        const reread = await txDb
          .select({ status: renewalCycles.status })
          .from(renewalCycles)
          .where(eq(renewalCycles.cycleId, cycleId))
          .limit(1);
        const actualStatus = reread[0]?.status;
        if (!actualStatus) {
          throw new CycleNotFoundError(cycleId);
        }
        throw new CycleTransitionConflictError(
          cycleId,
          'awaiting_payment',
          actualStatus as CycleStatus,
        );
      }
      return rowToDomain(row);
    },

    async refreezeOpenCycleForPlanChangeInTx(
      tx: unknown,
      tenantId: string,
      cycleId: CycleId,
      args: {
        readonly planIdAtCycleStart: string;
        readonly tierAtCycleStart: TierBucket;
        readonly frozenPlanPriceThb: ThbDecimal;
        readonly frozenPlanTermMonths: number;
        readonly frozenPlanCurrency: 'THB' | 'SEK' | 'EUR' | 'USD';
      },
    ): Promise<RenewalCycle | null> {
      // Plan-change immediate re-freeze (Phase 2, Step 2.2). GUARDED single
      // UPDATE: only an OPEN (upcoming|reminded|awaiting_payment) cycle whose
      // §86/4 has NOT yet been issued+linked (`linked_invoice_id IS NULL`)
      // qualifies. 0 rows -> `null` (raced into terminal/linked/issued state);
      // the caller DEFERS rather than throwing — an issued tax invoice is never
      // rewritten (tax-safe). The explicit `tenant_id` predicate is
      // application-layer defence-in-depth alongside RLS (Principle I § 1).
      // Term-length changes are gated OUT by the caller (period re-derivation is
      // out of scope), so the frozen fields are written verbatim from `args`.
      const txDb = tx as typeof db;
      const updated = await txDb
        .update(renewalCycles)
        .set({
          planIdAtCycleStart: args.planIdAtCycleStart,
          tierAtCycleStart: args.tierAtCycleStart,
          frozenPlanPriceThb: args.frozenPlanPriceThb,
          frozenPlanTermMonths: args.frozenPlanTermMonths,
          frozenPlanCurrency: args.frozenPlanCurrency,
        })
        .where(
          and(
            eq(renewalCycles.cycleId, cycleId),
            eq(renewalCycles.tenantId, tenantId),
            inArray(renewalCycles.status, [...OPEN_CYCLE_STATUSES]),
            isNull(renewalCycles.linkedInvoiceId),
          ),
        )
        .returning();
      const row = updated[0];
      return row ? rowToDomain(row) : null;
    },

    async linkInvoice(
      tx: unknown,
      _tenantId: string,
      cycleId: CycleId,
      invoiceId: string,
    ): Promise<RenewalCycle> {
      // I1 review-fix: atomic race-guard. The previous implementation
      // unconditionally overwrote `linked_invoice_id`, which silently
      // orphaned the previous invoice if a concurrent confirmRenewal
      // already linked one. This `WHERE (linked_invoice_id IS NULL OR
      // linked_invoice_id = $newId)` makes the link:
      //   - idempotent (re-link with same invoice succeeds; covers
      //     F4-callback retries that re-enter the use-case)
      //   - race-safe (concurrent confirm with a DIFFERENT invoice id
      //     gets 0 rows updated → InvoiceLinkConflictError, which the
      //     use-case maps to server_error so support voids the orphan)
      const txDb = tx as typeof db;
      const updated = await txDb
        .update(renewalCycles)
        .set({ linkedInvoiceId: invoiceId })
        .where(
          and(
            eq(renewalCycles.cycleId, cycleId),
            or(
              isNull(renewalCycles.linkedInvoiceId),
              eq(renewalCycles.linkedInvoiceId, invoiceId),
            ),
          ),
        )
        .returning();
      const row = updated[0];
      if (!row) {
        // 0 rows updated — disambiguate "cycle missing" from "already
        // linked to a different invoice" so the use-case can map the
        // forensic-log line correctly.
        const probe = await txDb
          .select({ linkedInvoiceId: renewalCycles.linkedInvoiceId })
          .from(renewalCycles)
          .where(eq(renewalCycles.cycleId, cycleId))
          .limit(1);
        if (probe.length === 0) {
          throw new CycleNotFoundError(cycleId);
        }
        throw new InvoiceLinkConflictError(
          cycleId,
          invoiceId,
          probe[0]!.linkedInvoiceId ?? '<unexpected-null>',
        );
      }
      return rowToDomain(row);
    },

    async linkInvoiceAndReconcileFrozenPlanInTx(
      tx: unknown,
      tenantId: string,
      cycleId: CycleId,
      invoiceId: string,
      billed: {
        readonly planIdAtCycleStart: string;
        readonly tierAtCycleStart: TierBucket;
        readonly frozenPlanPriceThb: ThbDecimal;
        readonly frozenPlanTermMonths: number;
        readonly frozenPlanCurrency: 'THB' | 'SEK' | 'EUR' | 'USD';
      },
    ): Promise<{ readonly cycle: RenewalCycle; readonly previous: RenewalCycle }> {
      // Finding #20 — atomic link + reconcile-frozen-to-billed. The caller
      // (confirm-renewal Step-4) holds the per-cycle advisory lock, so the
      // pre-read + guarded UPDATE below are race-free against every other
      // frozen-price writer (they all take `renewals:<tenant>:<cycle>`). The
      // pre-read captures the CURRENT (possibly concurrently-refrozen) frozen
      // fields so the use-case can emit a corrective audit ONLY when a real
      // divergence was healed. The UPDATE's link CAS mirrors `linkInvoice`
      // exactly (WHERE linked_invoice_id IS NULL OR = $invoiceId) — 0 rows means
      // nothing is written (no partial reconcile). The explicit `tenant_id`
      // predicate is application-layer defence-in-depth alongside RLS (Principle
      // I § 1).
      const txDb = tx as typeof db;
      const beforeRows = await txDb
        .select()
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.cycleId, cycleId),
            eq(renewalCycles.tenantId, tenantId),
          ),
        )
        .limit(1);
      const before = beforeRows[0];
      if (!before) {
        throw new CycleNotFoundError(cycleId);
      }
      const updated = await txDb
        .update(renewalCycles)
        .set({
          linkedInvoiceId: invoiceId,
          planIdAtCycleStart: billed.planIdAtCycleStart,
          tierAtCycleStart: billed.tierAtCycleStart,
          frozenPlanPriceThb: billed.frozenPlanPriceThb,
          frozenPlanTermMonths: billed.frozenPlanTermMonths,
          frozenPlanCurrency: billed.frozenPlanCurrency,
        })
        .where(
          and(
            eq(renewalCycles.cycleId, cycleId),
            eq(renewalCycles.tenantId, tenantId),
            or(
              isNull(renewalCycles.linkedInvoiceId),
              eq(renewalCycles.linkedInvoiceId, invoiceId),
            ),
          ),
        )
        .returning();
      const row = updated[0];
      if (!row) {
        // The row exists (pre-read succeeded) but the link CAS matched 0 rows —
        // a concurrent writer already linked a DIFFERENT invoice. Mirror
        // `linkInvoice`'s conflict shape so the use-case maps it identically.
        throw new InvoiceLinkConflictError(
          cycleId,
          invoiceId,
          before.linkedInvoiceId ?? '<unexpected-null>',
        );
      }
      return { cycle: rowToDomain(row), previous: rowToDomain(before) };
    },

    async clearLinkedInvoiceForVoidInTx(
      tx: unknown,
      tenantId: string,
      cycleId: CycleId,
      expectedInvoiceId: string,
    ): Promise<boolean> {
      // Plan-change / void-on-reissue unlink (Phase 2, Step 2.4). GUARDED
      // single UPDATE — mirrors `clearRejectRefundMarkerInTx`'s CAS shape:
      //   - CAS on `linked_invoice_id = expectedInvoiceId` so a concurrent
      //     relink to a DIFFERENT invoice is never clobbered (0 rows → false).
      //   - Restricted to the OPEN cycle statuses. A `completed` cycle MUST NOT
      //     be cleared: `renewal_cycles_completed_requires_invoice_check`
      //     (migration 0087) forbids a NULL `linked_invoice_id` when
      //     status='completed', so a NULL-write there aborts the whole void tx.
      //     The reissue workflow this serves only touches an OPEN cycle whose
      //     §86/4 is issued-but-unpaid — the paid→void edge (completed cycle) is
      //     a no-op here (returns false; the void proceeds unchanged).
      // The explicit `tenant_id` predicate is defence-in-depth alongside RLS
      // (Principle I § 1) — same convention as `refreezeOpenCycleForPlanChangeInTx`.
      const txDb = tx as typeof db;
      const updated = await txDb
        .update(renewalCycles)
        .set({ linkedInvoiceId: null })
        .where(
          and(
            eq(renewalCycles.cycleId, cycleId),
            eq(renewalCycles.tenantId, tenantId),
            inArray(renewalCycles.status, [...OPEN_CYCLE_STATUSES]),
            eq(renewalCycles.linkedInvoiceId, expectedInvoiceId),
          ),
        )
        .returning({ cycleId: renewalCycles.cycleId });
      return updated.length > 0;
    },

    async acquireCycleLockInTx(
      tx: unknown,
      tenantId: string,
      cycleId: CycleId,
    ): Promise<void> {
      const txDb = tx as typeof db;
      const lockKey = `renewals:${tenantId}:${cycleId}`;
      await txDb.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );
    },

    async markRejectRefundInitiatedInTx(
      tx: unknown,
      _tenantId: string,
      cycleId: CycleId,
      args: {
        readonly initiatedAt: string;
        readonly refundId: string;
        readonly actorUserId: string;
      },
    ): Promise<boolean> {
      // F8-RP follow-up (migration 0243). GUARDED write: only stamp the marker
      // while the cycle is STILL `pending_admin_reactivation` (CAS). If the
      // cycle moved out of pending in the race window, 0 rows match → `false`.
      // RLS scope comes from the inherited GUC; `_tenantId` intentionally
      // unused (same precedent as findByIdInTx — no WHERE tenant_id predicate).
      //
      // M1 fix (reliability review): the additional `reject_refund_initiated_at
      // IS NULL` predicate makes the stamp FIRST-WRITER-WINS at the DB layer.
      // The admin-reject caller decides "no marker yet" from a STALE app-level
      // read (`lockedCycle.rejectRefundInitiatedAt === null`, taken before the
      // lock was released + the refund ran), so two admins rejecting the same
      // UNMARKED cycle concurrently could both pass that check and both stamp —
      // with only the status guard, the second overwrote `reject_actor_user_id`
      // to the LAST writer's (racy attribution; money-safe — same in-flight
      // refund, cron still converges). With `IS NULL`, the second concurrent
      // stamp matches 0 rows (`false`) and the caller's existing `!marked`
      // handler logs the benign already-stamped warning. NORMAL first stamp
      // (marker null → true) and post-clear re-stamp (marker cleared → null →
      // true) are unaffected — `clearRejectRefundMarkerInTx` sets the column
      // back to NULL.
      const txDb = tx as typeof db;
      const updated = await txDb
        .update(renewalCycles)
        .set({
          rejectRefundInitiatedAt: new Date(args.initiatedAt),
          rejectRefundId: args.refundId,
          rejectActorUserId: args.actorUserId,
        })
        .where(
          and(
            eq(renewalCycles.cycleId, cycleId),
            eq(renewalCycles.status, 'pending_admin_reactivation'),
            isNull(renewalCycles.rejectRefundInitiatedAt),
          ),
        )
        .returning({ cycleId: renewalCycles.cycleId });
      return updated.length > 0;
    },

    async clearRejectRefundMarkerInTx(
      tx: unknown,
      _tenantId: string,
      cycleId: CycleId,
      expectedRefundId: string,
    ): Promise<boolean> {
      // F8-RP follow-up (migration 0243) — idempotent marker clear on the
      // settled-`failed` path. GUARDED: only clears a still-pending, still-
      // marked cycle so a concurrent transition (admin re-handled it) is a
      // no-op (`false`). RLS scope via inherited GUC.
      //
      // Finding 5 (F8-RP-2 review): the additional `reject_refund_id =
      // expectedRefundId` predicate makes this a CAS on the SPECIFIC refund the
      // caller resolved OUTSIDE the lock (R1). If a concurrent re-reject stamped
      // a fresh refund (R2) via `markRejectRefundInitiatedInTx` in the caller's
      // read→clear window, this UPDATE matches 0 rows (`false`) instead of wiping
      // R2's marker — so R2's own settlement still converges the cycle.
      const txDb = tx as typeof db;
      const updated = await txDb
        .update(renewalCycles)
        .set({
          rejectRefundInitiatedAt: null,
          rejectRefundId: null,
          rejectActorUserId: null,
        })
        .where(
          and(
            eq(renewalCycles.cycleId, cycleId),
            eq(renewalCycles.status, 'pending_admin_reactivation'),
            isNotNull(renewalCycles.rejectRefundInitiatedAt),
            eq(renewalCycles.rejectRefundId, expectedRefundId),
          ),
        )
        .returning({ cycleId: renewalCycles.cycleId });
      return updated.length > 0;
    },

    async listCyclesEligibleForLapse(
      _tenantId: string,
      args: {
        readonly pageSize: number;
      },
    ): Promise<RenewalCyclePage> {
      return runInTenant(tenant, async (tx) => {
        // 065 §5.2 — candidate = ALL `awaiting_payment` cycles; the
        // per-cycle decision (defer / terminate@due+60 / no-invoice
        // backstop) is made in the use-case from the member's oldest-due
        // unpaid membership invoice `due_date`. We MUST NOT pre-filter by
        // `expires_at`: a §5.3 born-`awaiting_payment` new member has
        // `expires_at ≈ now + 12 months`, so the former
        // `expires_at < now - grace` gate would hide that cohort for ~12
        // months and the due+60 clock would never fire for the exact
        // members this feature targets. RLS scopes to the tenant context.
        // Order by `expires_at ASC` so oldest expiries are processed first
        // (smallest blast radius if the cron is partially executed).
        // Scaling LIMITATION (065 final-review V3 — the earlier "lands a
        // run or two late" wording here UNDERSTATED it): `nextCursor` is
        // hardwired null and the caller does not page, while the deferred
        // outcomes leave rows in `awaiting_payment` — so under a SUSTAINED
        // overload of more than `pageSize` concurrent awaiting cycles, the
        // same first page re-fills every run and the §5.3 born-awaiting
        // cohort (far-future `expires_at`, sorted LAST by this ASC order)
        // is STARVED for as long as the overload lasts — its due+60
        // termination does not fire at all during that period, and nothing
        // in the response distinguishes a truncated pass from a complete
        // one. Immaterial at TSCC's ~110 members vs default pageSize 1000;
        // the tracked fix (design doc § Post-review follow-ups) is keyset
        // pagination on `(expires_at, cycle_id)` + a page loop with a time
        // budget in the use-case + batching the per-member invoice probe.
        const rows = await tx
          .select()
          .from(renewalCycles)
          .where(eq(renewalCycles.status, 'awaiting_payment'))
          .orderBy(sql`${renewalCycles.expiresAt} ASC`)
          .limit(args.pageSize);

        return {
          items: rows.map(rowToDomain),
          nextCursor: null,
        };
      });
    },

    async listCyclesEligibleForAwaitingPayment(
      _tenantId: string,
      args: {
        readonly nowIso: string;
        readonly pageSize: number;
      },
    ): Promise<RenewalCyclePage> {
      return runInTenant(tenant, async (tx) => {
        // F8-completion slice 2 — eligible = cycles still in
        // `upcoming`/`reminded` whose `expires_at <= nowIso` (reached
        // T-0). RLS scopes to the tenant context. `<= now` (vs the lapse
        // cron's `< now - grace`) keeps the two crons disjoint in a
        // single pass: a cycle becomes `awaiting_payment` here at T-0,
        // and only later (after grace) does the lapse cron see it. Order
        // by `expires_at ASC` so oldest expiries are flipped first
        // (smallest blast radius on a partial cron run).
        const rows = await tx
          .select()
          .from(renewalCycles)
          .where(
            and(
              sql`${renewalCycles.status} IN ('upcoming','reminded')`,
              sql`${renewalCycles.expiresAt} <= ${args.nowIso}`,
            ),
          )
          .orderBy(sql`${renewalCycles.expiresAt} ASC`)
          .limit(args.pageSize);

        return {
          items: rows.map(rowToDomain),
          nextCursor: null,
        };
      });
    },

    async listCyclesEligibleForAutoDraft(
      _tenantId: string,
      args: {
        readonly nowIso: string;
        readonly leadDaysRolling: number;
        readonly leadDaysCalendar: number;
        readonly pageSize: number;
      },
    ): Promise<AutoDraftEligiblePage> {
      return runInTenant(tenant, async (tx) => {
        // 107-auto-invoice Task 6 — see the port doc comment for the full
        // eligibility predicate + the rationale for each clause. Two
        // correlated subqueries (rather than an actual SQL JOIN) keep the
        // row shape flat `renewal_cycles.*` so `rowToDomain` — which
        // expects a bare `RenewalCycleRow` — stays reusable unchanged; a
        // real JOIN against `.select()` would nest columns under
        // per-table keys and break that mapper.
        //
        // Member-side gate: enrolled + not archived + within the
        // member's own lead window (`leadDaysCalendar` for a
        // `billing_cycle = 'calendar'` member, else `leadDaysRolling`).
        // The `expires_at` upper bound is correlated to the OUTER
        // `renewal_cycles` row since the lead-day figure depends on
        // `members.billing_cycle`.
        const eligibleMemberSql = sql`EXISTS (
          SELECT 1 FROM ${members} m
          WHERE m.tenant_id = ${renewalCycles.tenantId}
            AND m.member_id = ${renewalCycles.memberId}
            AND m.auto_invoice_enrolled_at IS NOT NULL
            AND m.archived_at IS NULL
            AND m.status <> 'archived'
            -- Task 15 review (Important) — a GDPR/PDPA-erased member must
            -- never be auto-billed. scrubPiiInTx now NULLs
            -- auto_invoice_enrolled_at, but that is a ONE-SHOT fix: nothing
            -- stops a later bulk enrol from re-stamping an erased row, and
            -- the scrub deliberately leaves status/archived_at alone
            -- (erasure is orthogonal to archive), so the two gates above do
            -- NOT cover this. Filtering at the repo predicate covers every
            -- present and future enrolment path, where a write-path filter
            -- would only cover the one that exists today. Same concept as
            -- excludeErasedMembers in drizzle-member-renewal-flags-repo.ts.
            -- NOTE: no backticks in this comment — it lives inside a JS
            -- template literal, where a backtick would terminate the string.
            AND m.erased_at IS NULL
            AND ${renewalCycles.expiresAt} <= ${args.nowIso}::timestamptz + (
              CASE WHEN m.billing_cycle = 'calendar'
                THEN ${args.leadDaysCalendar}::int
                ELSE ${args.leadDaysRolling}::int
              END
            ) * INTERVAL '1 day'
        )`;

        // Dedup gate — coarse, MEMBER-scoped (not plan_year-scoped: a
        // cycle's plan_year is derived, not a column — see port doc).
        // draft/issued ONLY: `paid`/`credited`/`partially_credited` are
        // deliberately EXCLUDED from this NOT EXISTS — every eligible
        // member has a paid prior-cycle membership invoice by
        // construction (that payment is WHY this cycle is `upcoming`),
        // so including `paid` here would zero out every candidate.
        const noLiveMembershipInvoiceSql = sql`NOT EXISTS (
          SELECT 1 FROM ${invoices} inv
          WHERE inv.tenant_id = ${renewalCycles.tenantId}
            AND inv.member_id = ${renewalCycles.memberId}
            AND inv.invoice_subject = 'membership'
            AND inv.status IN ('draft', 'issued')
        )`;

        const rows = await tx
          .select()
          .from(renewalCycles)
          .where(
            and(
              sql`${renewalCycles.status} IN ('upcoming','reminded')`,
              sql`${renewalCycles.expiresAt} > ${args.nowIso}`,
              eligibleMemberSql,
              noLiveMembershipInvoiceSql,
            ),
          )
          .orderBy(sql`${renewalCycles.expiresAt} ASC`)
          .limit(args.pageSize);

        return {
          cycles: rows.map(rowToDomain),
          nextCursor: null,
        };
      });
    },

    async hasLiveMembershipInvoiceForPlanYearInTx(
      tx: unknown,
      tenantId: string,
      memberId: string,
      planYear: number,
    ): Promise<boolean> {
      const txDb = tx as typeof db;
      const rows = await txDb
        .select({ one: sql<number>`1` })
        .from(invoices)
        .where(
          and(
            // Review I1 fix — explicit app-layer tenant filter, matching
            // this same file's `listCyclesEligibleForAutoDraft` sibling
            // query (Task 6) — Constitution Principle I two-layer
            // isolation (RLS FORCE + app-layer filter), not RLS alone.
            eq(invoices.tenantId, tenantId),
            eq(invoices.memberId, memberId),
            eq(invoices.invoiceSubject, 'membership'),
            eq(invoices.planYear, planYear),
            inArray(invoices.status, ['draft', 'issued']),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async findMembershipInvoiceInTx(
      tx: unknown,
      tenantId: string,
      invoiceId: string,
    ): Promise<(MembershipInvoiceRef & { readonly planId: string | null }) | null> {
      const txDb = tx as typeof db;
      const [row] = await txDb
        .select({
          invoiceId: invoices.invoiceId,
          memberId: invoices.memberId,
          planYear: invoices.planYear,
          planId: invoices.planId,
          status: invoices.status,
          origin: invoices.origin,
        })
        .from(invoices)
        .where(
          and(
            // Explicit app-layer tenant filter alongside RLS+FORCE — same
            // two-layer isolation as the sibling reads in this file.
            eq(invoices.tenantId, tenantId),
            eq(invoices.invoiceId, invoiceId),
            // An event-fee invoice is never an auto-renewal membership draft;
            // filtering here means the use-case cannot be handed one.
            eq(invoices.invoiceSubject, 'membership'),
          ),
        )
        .limit(1);
      if (!row) return null;
      // `member_id`/`plan_year` are NOT NULL for `invoice_subject='membership'`
      // (invoices_subject_fields_ck), but Drizzle types them nullable because
      // the columns are nullable for the event subject. Treat a violation as
      // "not a usable membership invoice" rather than coercing past it.
      if (row.memberId === null || row.planYear === null) return null;
      return {
        invoiceId: row.invoiceId,
        memberId: row.memberId,
        planYear: row.planYear,
        planId: row.planId,
        status: row.status,
        origin: row.origin,
      };
    },

    async clearStaleLinkedInvoiceInTx(
      tx: unknown,
      tenantId: string,
      cycleId: CycleId,
      expectedInvoiceId: string,
    ): Promise<boolean> {
      const txDb = tx as typeof db;
      const cleared = await txDb
        .update(renewalCycles)
        .set({ linkedInvoiceId: null })
        .where(
          and(
            eq(renewalCycles.tenantId, tenantId),
            eq(renewalCycles.cycleId, cycleId),
            // CAS on the exact id the caller observed — a concurrent writer
            // that re-linked the cycle since then matches 0 rows and is left
            // alone rather than silently unlinked.
            eq(renewalCycles.linkedInvoiceId, expectedInvoiceId),
          ),
        )
        .returning({ cycleId: renewalCycles.cycleId });
      return cleared.length > 0;
    },

    async findByAutoDraftInvoiceIdInTx(
      tx: unknown,
      tenantId: string,
      invoiceId: string,
    ): Promise<RenewalCycle | null> {
      const txDb = tx as typeof db;
      const [row] = await txDb
        .select()
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.tenantId, tenantId),
            eq(renewalCycles.autoDraftInvoiceId, invoiceId),
          ),
        )
        .limit(1);
      return row ? rowToDomain(row) : null;
    },

    async findCyclesByAutoDraftInvoiceIds(
      tenantId: string,
      invoiceIds: readonly string[],
    ): Promise<ReadonlyMap<string, RenewalCycle>> {
      const out = new Map<string, RenewalCycle>();
      if (invoiceIds.length === 0) return out;
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select()
          .from(renewalCycles)
          .where(
            and(
              eq(renewalCycles.tenantId, tenantId),
              inArray(renewalCycles.autoDraftInvoiceId, [...invoiceIds]),
            ),
          );
        for (const row of rows) {
          if (row.autoDraftInvoiceId !== null) {
            out.set(row.autoDraftInvoiceId, rowToDomain(row));
          }
        }
        return out;
      });
    },

    async listMembershipInvoicesForPlanYearInTx(
      tx: unknown,
      tenantId: string,
      memberId: string,
      planYear: number,
    ): Promise<ReadonlyArray<MembershipInvoiceRef>> {
      const txDb = tx as typeof db;
      const rows = await txDb
        .select({
          invoiceId: invoices.invoiceId,
          memberId: invoices.memberId,
          planYear: invoices.planYear,
          status: invoices.status,
          origin: invoices.origin,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenantId),
            eq(invoices.memberId, memberId),
            eq(invoices.invoiceSubject, 'membership'),
            eq(invoices.planYear, planYear),
          ),
        );
      // No status filter in SQL — the caller applies TWO different status
      // predicates to this one result set (the paid-inclusive content guard
      // and the auto-renewal-draft discard scan). Keeping the classification
      // in the use-case keeps both tax-critical predicates readable side by
      // side instead of split across a query and a filter.
      return rows.flatMap((row) =>
        row.memberId === null || row.planYear === null
          ? []
          : [
              {
                invoiceId: row.invoiceId,
                memberId: row.memberId,
                planYear: row.planYear,
                status: row.status,
                origin: row.origin,
              },
            ],
      );
    },

    async listMembershipCoverageForMemberInTx(
      tx: unknown,
      tenantId: string,
      memberId: string,
    ): Promise<ReadonlyArray<MembershipBillCoverageRow>> {
      // membership-coverage-exclude-guard (mig 0281) — the pre-flight twin of
      // the DB EXCLUDE. MEMBER-scoped (no plan_year filter): the anchored
      // plan_year pin lags a full term behind the coverage a §86/4 charges, so
      // a plan_year-keyed read would miss the very bill the guard must see.
      // `tenantId` is an explicit app-layer WHERE (Principle I two-layer
      // isolation) on top of the RLS GUC threaded by this `tx`.
      const txDb = tx as typeof db;
      const rows = await txDb
        .select({
          invoiceId: invoices.invoiceId,
          status: invoices.status,
          coverageFrom: invoices.coverageFrom,
          coverageTo: invoices.coverageTo,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenantId),
            eq(invoices.memberId, memberId),
            eq(invoices.invoiceSubject, 'membership'),
          ),
        );
      return rows.map((row) => ({
        invoiceId: row.invoiceId,
        status: row.status,
        coverage:
          row.coverageFrom !== null && row.coverageTo !== null
            ? { from: row.coverageFrom.toISOString(), to: row.coverageTo.toISOString() }
            : null,
      }));
    },

    async listMembershipCoverageForMembers(
      tenantId: string,
      memberIds: readonly string[],
    ): Promise<ReadonlyMap<string, ReadonlyArray<MembershipBillCoverageRow>>> {
      const byMember = new Map<string, MembershipBillCoverageRow[]>();
      if (memberIds.length === 0) return byMember;
      // MEMBER-scoped (no plan_year filter) — same rationale as
      // `listMembershipCoverageForMemberInTx`, batched for the review-queue
      // prediction. `tenantId` is an explicit app-layer WHERE (Principle I
      // two-layer isolation) on top of the RLS GUC threaded by runInTenant.
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select({
            invoiceId: invoices.invoiceId,
            memberId: invoices.memberId,
            status: invoices.status,
            coverageFrom: invoices.coverageFrom,
            coverageTo: invoices.coverageTo,
          })
          .from(invoices)
          .where(
            and(
              eq(invoices.tenantId, tenantId),
              inArray(invoices.memberId, [...memberIds]),
              eq(invoices.invoiceSubject, 'membership'),
            ),
          );
        for (const row of rows) {
          if (row.memberId === null) continue;
          const bucket = byMember.get(row.memberId) ?? [];
          bucket.push({
            invoiceId: row.invoiceId,
            status: row.status,
            coverage:
              row.coverageFrom !== null && row.coverageTo !== null
                ? { from: row.coverageFrom.toISOString(), to: row.coverageTo.toISOString() }
                : null,
          });
          byMember.set(row.memberId, bucket);
        }
        return byMember;
      });
    },

    async stampAutoDraftInvoiceIdInTx(
      tx: unknown,
      _tenantId: string,
      cycleId: CycleId,
      invoiceId: string,
    ): Promise<void> {
      const txDb = tx as typeof db;
      await txDb
        .update(renewalCycles)
        .set({ autoDraftInvoiceId: invoiceId })
        .where(eq(renewalCycles.cycleId, cycleId));
    },

    async listStaleAutoDrafts(
      tenantId: string,
    ): Promise<ReadonlyArray<StaleAutoDraftRow>> {
      return runInTenant(tenant, async (tx) => {
        // INNER JOIN, not a correlated subquery (unlike
        // `listCyclesEligibleForAutoDraft`'s sibling EXISTS clauses) — this
        // query's FROM is `invoices` (an F4 table), so a plain join back to
        // `renewal_cycles` via the Task 7 `auto_draft_invoice_id` stamp is
        // the natural shape, and the result needs columns from BOTH sides
        // (no `rowToDomain` re-mapping constraint applies here, unlike the
        // pure-`renewal_cycles` queries).
        const rows = await tx
          .select({
            invoiceId: invoices.invoiceId,
            cycleId: renewalCycles.cycleId,
            memberId: renewalCycles.memberId,
          })
          .from(invoices)
          .innerJoin(
            renewalCycles,
            and(
              eq(renewalCycles.tenantId, invoices.tenantId),
              eq(renewalCycles.autoDraftInvoiceId, invoices.invoiceId),
            ),
          )
          .where(
            and(
              // Explicit app-layer tenant filter alongside RLS+FORCE on
              // BOTH tables — Constitution Principle I two-layer isolation,
              // matching the sibling Task 6/7/9 cross-module queries.
              eq(invoices.tenantId, tenantId),
              eq(renewalCycles.tenantId, tenantId),
              eq(invoices.invoiceSubject, 'membership'),
              eq(invoices.origin, 'auto_renewal'),
              eq(invoices.status, 'draft'),
              sql`${renewalCycles.status} NOT IN ('upcoming','reminded')`,
            ),
          );
        return rows.map((r) => ({
          invoiceId: r.invoiceId,
          cycleId: asCycleId(r.cycleId),
          memberId: r.memberId,
        }));
      });
    },

    async listIssuedAutoInvoiceOrphans(
      tenantId: string,
    ): Promise<ReadonlyArray<IssuedAutoInvoiceOrphanRow>> {
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select({
            invoiceId: invoices.invoiceId,
            cycleId: renewalCycles.cycleId,
            memberId: renewalCycles.memberId,
          })
          .from(invoices)
          .innerJoin(
            renewalCycles,
            and(
              eq(renewalCycles.tenantId, invoices.tenantId),
              eq(renewalCycles.autoDraftInvoiceId, invoices.invoiceId),
            ),
          )
          .where(
            and(
              eq(invoices.tenantId, tenantId),
              eq(renewalCycles.tenantId, tenantId),
              eq(invoices.invoiceSubject, 'membership'),
              eq(invoices.origin, 'auto_renewal'),
              eq(invoices.status, 'issued'),
              isNull(renewalCycles.linkedInvoiceId),
            ),
          );
        return rows.map((r) => ({
          invoiceId: r.invoiceId,
          cycleId: asCycleId(r.cycleId),
          memberId: r.memberId,
        }));
      });
    },

    async loadPipelineMoneyRaw(
      _tenantId: string,
      opts: {
        readonly nowIso: string;
        readonly windowDays: number;
        readonly fiscalYearStartMonth: number;
      },
    ): Promise<PipelineMoneyRaw> {
      return runInTenant(tenant, async (tx) => {
        // ---- BKK boundaries, all derived from nowIso (deterministic) ----
        const nowBkk = sql`(${opts.nowIso}::timestamptz AT TIME ZONE 'Asia/Bangkok')`;
        const today = sql`(${nowBkk})::date`;
        const windowEnd = sql`((${today}) + (${opts.windowDays} * INTERVAL '1 day'))::date`;
        const monthStart = sql`date_trunc('month', ${nowBkk})`;
        const nextMonth = sql`(date_trunc('month', ${nowBkk}) + INTERVAL '1 month')`;
        // Replicates deriveFiscalYear() (src/lib/fiscal-year.ts) IN SQL: FY n
        // starts on the 1st of `startMonth` of CE year n (Bangkok wall time);
        // a `today` before `startMonth` belongs to the previous FY. NEVER use
        // `invoices.fiscal_year` — that column is ISSUE-date-based (schema
        // comment ~L111), and this is a DUE-date cohort.
        const fyStart = sql`make_date(
          CASE WHEN EXTRACT(MONTH FROM ${today})::int >= ${opts.fiscalYearStartMonth}
               THEN EXTRACT(YEAR FROM ${today})::int
               ELSE EXTRACT(YEAR FROM ${today})::int - 1 END,
          ${opts.fiscalYearStartMonth}, 1)`;

        // Explicit tenant_id predicate = two-layer isolation on top of RLS.
        const membership = and(
          eq(invoices.tenantId, tenant.slug),
          eq(invoices.invoiceSubject, 'membership'),
        )!;

        // Fix round 2 #9 — reconciliation note: `status` is filtered to
        // 'issued' (overdue/dueSoon) or 'paid'/'partially_credited'/'credited'
        // (settledRows/collectedRows) in every leg below, so 'void' is
        // excluded from ALL FOUR. A membership invoice that was PAID and then
        // voided therefore drops out of every leg of this money band
        // entirely — it is neither "collected" nor "settled" nor "overdue"
        // any more, even though real cash may still be sitting unrefunded
        // (voiding a paid invoice writes nothing to `payments`/`refunds` —
        // see memory `project_void_paid_invoice_money_dead_end`). This is a
        // KNOWN, documented interaction of an existing money dead-end, not a
        // gap introduced by this band — noted here so a future reader
        // doesn't mistake the drop for a bug in this query.
        // ---- Scalar legs (overdue + dueSoon): raw Σ(total), FY-scoped ----
        const [scalars] = await tx
          .select({
            overdue: sql<string>`COALESCE(SUM(${invoices.totalSatang}) FILTER (
              WHERE ${invoices.status} = 'issued'
                AND ${invoices.dueDate} IS NOT NULL
                AND ${invoices.dueDate} >= ${fyStart}
                AND ${invoices.dueDate} <  ${today}), 0)`,
            dueSoon: sql<string>`COALESCE(SUM(${invoices.totalSatang}) FILTER (
              WHERE ${invoices.status} = 'issued'
                AND ${invoices.dueDate} IS NOT NULL
                AND ${invoices.dueDate} >= ${today}
                AND ${invoices.dueDate} <= ${windowEnd}), 0)`,
            // renewals-overdue-prior-fy-subline — unpaid bills whose due_date
            // pre-dates the CURRENT fiscal year (no lower bound; `< fyStart`
            // is inherently `< today` since fyStart ≤ today by construction).
            // Deliberately DISJOINT from the FY-scoped `overdue` leg above so
            // the Past-due tile's reviewed definition stays untouched — this
            // pair only feeds the "+ overdue from prior years" sub-line.
            overdueBeforeFy: sql<string>`COALESCE(SUM(${invoices.totalSatang}) FILTER (
              WHERE ${invoices.status} = 'issued'
                AND ${invoices.dueDate} IS NOT NULL
                AND ${invoices.dueDate} < ${fyStart}), 0)`,
            overdueBeforeFyCount: sql<number>`(COUNT(*) FILTER (
              WHERE ${invoices.status} = 'issued'
                AND ${invoices.dueDate} IS NOT NULL
                AND ${invoices.dueDate} < ${fyStart}))::int`,
            // renewals-suspended-visibility-audit Task 3 — the SAME
            // `fyStart` boundary the legs above filtered on, surfaced as
            // `YYYY-MM-DD` so the band's prior-FY drill-down can pass it as
            // `?dueBefore=`. Selected FROM the SQL expression itself (not
            // recomputed in JS) so the link's bound can never drift from
            // the cohort the sub-line counted.
            fyStartDate: sql<string>`(${fyStart})::text`,
          })
          .from(invoices)
          .where(membership);

        // ---- Settled rows (due-cohort this FY): (id, total − credited) ----
        const settledRows = await tx
          .select({
            invoiceId: invoices.invoiceId,
            netOfCredit: sql<string>`(${invoices.totalSatang} - ${invoices.creditedTotalSatang})`,
          })
          .from(invoices)
          .where(sql`
            ${invoices.tenantId} = ${tenant.slug}
            AND ${invoices.invoiceSubject} = 'membership'
            AND ${invoices.status} IN ('paid','partially_credited','credited')
            AND ${invoices.dueDate} IS NOT NULL
            AND ${invoices.dueDate} >= ${fyStart}
            AND ${invoices.dueDate} <  ${today}`);

        // ---- Collected rows (paid this BKK month): (id, total − credited) ----
        const collectedRows = await tx
          .select({
            invoiceId: invoices.invoiceId,
            netOfCredit: sql<string>`(${invoices.totalSatang} - ${invoices.creditedTotalSatang})`,
          })
          .from(invoices)
          .where(sql`
            ${invoices.tenantId} = ${tenant.slug}
            AND ${invoices.invoiceSubject} = 'membership'
            AND ${invoices.status} IN ('paid','partially_credited','credited')
            AND ${invoices.paidAt} IS NOT NULL
            AND (${invoices.paidAt} AT TIME ZONE 'Asia/Bangkok') >= ${monthStart}
            AND (${invoices.paidAt} AT TIME ZONE 'Asia/Bangkok') <  ${nextMonth}`);

        return {
          overdueSatang: BigInt(scalars?.overdue ?? '0'),
          dueSoonSatang: BigInt(scalars?.dueSoon ?? '0'),
          overdueBeforeFySatang: BigInt(scalars?.overdueBeforeFy ?? '0'),
          overdueBeforeFyCount: Number(scalars?.overdueBeforeFyCount ?? 0),
          // An aggregate query with no GROUP BY always yields exactly one
          // row, so the fallback is unreachable — kept only for the `?.`
          // type-narrowing symmetry with the legs above.
          fyStartDate: scalars?.fyStartDate ?? '',
          settledRows: settledRows.map((r) => ({
            invoiceId: r.invoiceId,
            netOfCreditSatang: BigInt(r.netOfCredit),
          })),
          collectedRows: collectedRows.map((r) => ({
            invoiceId: r.invoiceId,
            netOfCreditSatang: BigInt(r.netOfCredit),
          })),
        };
      });
    },

    /**
     * 059-membership-suspension Task 9 — settlement-preview join for the
     * bulk "Mark paid" confirm dialog. Mirrors `loadPipelinePage`'s
     * members/invoices LEFT JOIN shape (tenant-scoped predicates on both
     * cross-module tables — Principle I two-layer isolation), but keyed
     * by `linked_invoice_id` (the LINKED, issue-time invoice) rather than
     * `anchor_invoice_id` (the paid-coverage anchor `loadPipelinePage`
     * reads) — settlement preview is about "what does this cycle still
     * owe", not "is this period already covered".
     */
    async loadSettlementPreview(input: {
      readonly tenantId: string;
      readonly cycleIds: ReadonlyArray<string>;
    }): Promise<ReadonlyArray<SettlementPreviewRow>> {
      if (input.cycleIds.length === 0) return [];
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select({
            cycleId: renewalCycles.cycleId,
            companyName: members.companyName,
            invoiceId: invoices.invoiceId,
            invoiceStatus: invoices.status,
            totalSatang: invoices.totalSatang,
            creditedTotalSatang: invoices.creditedTotalSatang,
            currency: invoices.currency,
          })
          .from(renewalCycles)
          .leftJoin(
            members,
            and(
              eq(members.tenantId, renewalCycles.tenantId),
              eq(members.memberId, renewalCycles.memberId),
            ),
          )
          .leftJoin(
            invoices,
            and(
              // Explicit tenant predicate = application-layer
              // defence-in-depth atop RLS on this cross-module table
              // (Principle I two-layer isolation) — matches
              // `loadPipelinePage`'s anchorInvoice join.
              eq(invoices.tenantId, renewalCycles.tenantId),
              eq(invoices.invoiceId, renewalCycles.linkedInvoiceId),
            ),
          )
          .where(inArray(renewalCycles.cycleId, input.cycleIds));

        return rows.map((r): SettlementPreviewRow => {
          const cycleId = asCycleId(r.cycleId);
          const companyName = r.companyName ?? '';
          // The ONLY previewable gate: a real linked invoice whose status
          // is still 'issued' — i.e. a truthful, still-collectible total.
          // 'draft' has no finalised total; 'paid'/'void'/'credited'/
          // 'partially_credited' are STALE (settled, reversed, or
          // superseded) — a stale link must never surface its amount
          // (money-safety fix; see `SettlementPreviewRow.previewable`).
          //
          // speckit-review #4 — build the correct discriminated-union arm.
          // Inlining the gate into the `if` narrows `r.invoiceId` to a
          // non-null `string` for the previewable arm (no const-alias
          // narrowing dependency).
          if (r.invoiceId !== null && r.invoiceStatus === 'issued') {
            return {
              cycleId,
              companyName,
              previewable: true,
              invoiceId: r.invoiceId,
              // `- creditedTotalSatang` is DEFENSIVE, not load-bearing: a
              // genuine `issued` invoice always has creditedTotalSatang = 0
              // (crediting requires status 'paid'/'partially_credited', both
              // excluded by the gate above), so for every row that reaches
              // this branch today the term is always 0 — it exists only to
              // stay correct if the gate is ever widened.
              amountThbMinor: Number(
                (r.totalSatang ?? 0n) - (r.creditedTotalSatang ?? 0n),
              ),
              // `invoices.currency` is a notNull column, so a matched
              // 'issued' invoice row always carries a real 3-char code. The
              // `!` only bridges Drizzle's LEFT-JOIN `string | null` typing
              // to the union arm's `currency: string` — it compiles away, so
              // the runtime value is identical (never a fallback).
              currency: r.currency!,
            };
          }
          return {
            cycleId,
            companyName,
            previewable: false,
            invoiceId: null,
            amountThbMinor: null,
            currency: null,
          };
        });
      });
    },

    async transitionStatus(
      tx: unknown,
      _tenantId: string,
      cycleId: CycleId,
      args: {
        readonly from: CycleStatus;
        readonly to: CycleStatus;
        readonly closedAt?: string;
        readonly closedReason?: ClosedReason;
        readonly enteredPendingAt?: string;
        readonly linkedInvoiceId?: string;
        readonly linkedCreditNoteId?: string;
      },
    ): Promise<RenewalCycle> {
      // G5b (F8-completion slice 0) — defence-in-depth: assert the
      // (from → to) edge is DECLARED in the domain TRANSITIONS map BEFORE
      // the optimistic CAS below. An illegal edge fails fast here
      // (InvalidCycleTransitionError) so the map stays the single source
      // of truth for what a writer may do; a legal-but-STALE `from`
      // (concurrent flip) still surfaces a CycleTransitionConflictError
      // from the CAS `WHERE status = from` probe. Both guards run — the
      // domain edge check first, optimistic concurrency second.
      const guard = assertCanTransition(args.from, args.to);
      if (!guard.ok) {
        throw new InvalidCycleTransitionError(args.from, args.to);
      }
      const txDb = tx as typeof db;
      const setClause: Record<string, unknown> = {
        status: args.to,
      };
      const TERMINAL_STATUSES = new Set([
        'completed',
        'lapsed',
        'cancelled',
      ]);
      const fromTerminal = TERMINAL_STATUSES.has(args.from);
      const toTerminal = TERMINAL_STATUSES.has(args.to);
      if (args.closedAt !== undefined) {
        setClause.closedAt = new Date(args.closedAt);
      } else if (fromTerminal && !toTerminal) {
        // Auto-clear when leaving terminal — DB CHECK constraint
        // `closed_at IS NULL ↔ status terminal` would otherwise fail.
        setClause.closedAt = null;
      }
      if (args.closedReason !== undefined) {
        setClause.closedReason = args.closedReason;
      } else if (fromTerminal && !toTerminal) {
        setClause.closedReason = null;
      }
      if (args.enteredPendingAt !== undefined) {
        setClause.enteredPendingAt = new Date(args.enteredPendingAt);
      }
      // Clear enteredPendingAt when leaving pending_admin_reactivation
      if (
        args.from === 'pending_admin_reactivation' &&
        args.to !== 'pending_admin_reactivation' &&
        args.enteredPendingAt === undefined
      ) {
        setClause.enteredPendingAt = null;
      }
      if (args.linkedInvoiceId !== undefined) {
        setClause.linkedInvoiceId = args.linkedInvoiceId;
      }
      if (args.linkedCreditNoteId !== undefined) {
        setClause.linkedCreditNoteId = args.linkedCreditNoteId;
      }

      // 107-auto-invoice Task 9 (review Minor 4) — when this call ALSO writes
      // `linked_invoice_id`, carry `linkInvoice`'s own CAS predicate
      // (`IS NULL OR = $1`). Both methods write that column, and without this
      // `transitionStatus` would overwrite an existing, DIFFERENT link blind
      // (it CASes on status only) while `linkInvoice` refuses — two writers of
      // one column with contradictory concurrency contracts. A mismatch here
      // surfaces as a CycleTransitionConflictError rather than a silent
      // clobber of another invoice's claim on the cycle.
      const linkGuard =
        args.linkedInvoiceId !== undefined
          ? or(
              isNull(renewalCycles.linkedInvoiceId),
              eq(renewalCycles.linkedInvoiceId, args.linkedInvoiceId),
            )
          : undefined;
      const updated = await txDb
        .update(renewalCycles)
        .set(setClause)
        .where(
          and(
            eq(renewalCycles.cycleId, cycleId),
            eq(renewalCycles.status, args.from),
            ...(linkGuard ? [linkGuard] : []),
          ),
        )
        .returning();

      if (updated.length === 0) {
        // Either RLS-hidden (cross-tenant), already in different status,
        // or missing. Probe the row to disambiguate for the caller's
        // error narrowing.
        const probe = await txDb
          .select({ status: renewalCycles.status })
          .from(renewalCycles)
          .where(eq(renewalCycles.cycleId, cycleId))
          .limit(1);
        if (probe.length === 0) {
          throw new CycleNotFoundError(cycleId);
        }
        const actual = probe[0]!.status as CycleStatus;
        throw new CycleTransitionConflictError(cycleId, args.from, actual);
      }
      return rowToDomain(updated[0]!);
    },

    async listEligibleForDispatch(
      _tenantId: string,
      args: {
        readonly cutoff: string;
        readonly pageSize: number;
        readonly cursor?: string;
      },
    ): Promise<RenewalCyclePage> {
      return runInTenant(tenant, async (tx) => {
        const cursor = decodeCursor(args.cursor);
        const filters: SQL[] = [
          sql`${renewalCycles.status} IN (${sql.raw(OPEN_CYCLE_STATUSES_SQL_LIST)})`,
          sql`${renewalCycles.expiresAt} >= ${args.cutoff}`,
        ];
        if (cursor) {
          filters.push(
            or(
              sql`${renewalCycles.expiresAt} > ${cursor.expiresAt}`,
              and(
                eq(renewalCycles.expiresAt, new Date(cursor.expiresAt)),
                sql`${renewalCycles.cycleId} > ${cursor.cycleId}`,
              ),
            )!,
          );
        }
        const rows = await tx
          .select()
          .from(renewalCycles)
          .where(and(...filters))
          .orderBy(
            sql`${renewalCycles.expiresAt} ASC, ${renewalCycles.cycleId} ASC`,
          )
          .limit(args.pageSize + 1);

        const hasNextPage = rows.length > args.pageSize;
        const pageRows = hasNextPage ? rows.slice(0, args.pageSize) : rows;
        return {
          items: pageRows.map(rowToDomain),
          nextCursor: buildNextCursor(pageRows, hasNextPage),
        };
      });
    },

    async listMembersWithoutCycle(
      _tenantId: string,
      opts: ListMembersWithoutCycleOpts,
    ): Promise<MembersWithoutCyclePage> {
      // DV-18 — members with NO renewal_cycles row, EXCLUDING archived +
      // GDPR-erased. RLS+FORCE on BOTH tables; threading `tx` from
      // runInTenant keeps the anti-join tenant-scoped (NO global db).
      return runInTenant(tenant, async (tx) => {
        const limit = Math.max(1, Math.min(opts.limit, 200));

        // Correlated NOT EXISTS: the member owns NO cycle. Reads only
        // `renewal_cycles` in the subquery (RLS-scoped) — no join widens
        // the `members` projection.
        const noCycle = sql`NOT EXISTS (
          SELECT 1 FROM ${renewalCycles} rc
          WHERE rc.tenant_id = ${members.tenantId}
            AND rc.member_id = ${members.memberId}
        )`;

        const filters: SQL[] = [
          noCycle,
          // Archived members are intentionally hidden — an archived row is
          // not an operational "renewal gap" the admin needs to act on.
          ne(members.status, 'archived'),
          // COMP-1 H4 — erasure keeps status='active' and stamps only
          // erased_at, so a status filter alone does NOT hide an erased
          // member. Drop them from this operational enumeration.
          isNull(members.erasedAt),
        ];

        // `totalCount` is the WHOLE anti-join size via a separate `count(*)`
        // aggregate, run in parallel with the (single, capped) page query to
        // save a round-trip. The tray shows it as "N members" and flags when
        // the rendered page is truncated past the cap.
        const countQueryPromise = tx
          .select({ count: sql<number>`count(*)::int` })
          .from(members)
          .where(and(...filters));

        const pageQueryPromise = tx
          .select({
            memberId: members.memberId,
            companyName: members.companyName,
            registrationDate: members.registrationDate,
          })
          .from(members)
          .where(and(...filters))
          .orderBy(desc(members.registrationDate), asc(members.memberId))
          .limit(limit);

        const [countRows, rows] = await Promise.all([
          countQueryPromise,
          pageQueryPromise,
        ]);

        return {
          // The select projects exactly { memberId, companyName,
          // registrationDate } = MemberWithoutCycleRow, so the rows ARE the
          // page items — no identity re-map needed.
          items: rows,
          totalCount: countRows[0]?.count ?? 0,
        };
      });
    },

    async loadPipelinePage(
      _tenantId: string,
      opts: PipelineQueryOpts,
    ): Promise<PipelineQueryResult> {
      return runInTenant(tenant, async (tx) => {
        const cursor = decodeCursor(opts.cursor);
        const limit = Math.max(1, Math.min(opts.limit, 200));
        // Task 8 — additive sort; absent ⇒ the pre-existing `expires_at_asc`.
        const sort: PipelineSort = opts.sort ?? 'expires_at_asc';

        // Window definition: active cycles only EXCEPT lapsed tab which
        // explicitly returns lapsed cycles. The window is "next 90 days"
        // for non-lapsed urgency buckets.
        //
        // renewals-suspended-visibility-audit — the FR-046 window boundary
        // is now a SINGLE fragment shared by the page filter, the summary
        // filter AND the new outside-window count below, so the "90" can
        // never fork between the tab badges and the bridge strip.
        const windowEnd = sql`NOW() + INTERVAL '90 days'`;
        const baseFilters: SQL[] = [
          // COMP-1 H4 — exclude GDPR-erased members from the pipeline
          // window. `markCycleCompleteFromInvoicePaid` routes a paid erased
          // member's cycle to the NON-terminal `pending_admin_reactivation`,
          // so erased members are actively pushed into this window without
          // this filter.
          MEMBER_NOT_ERASED_SQL,
        ];
        if (opts.urgency === 'terminated') {
          // The 'terminated' urgency bucket ⟺ status='lapsed' within this
          // pipeline window: 'cancelled'/'completed' are excluded upstream, and
          // deriveMembershipAccess only returns 'terminated' for status='lapsed'
          // here — so the row filter stays keyed on the cycle STATUS (the DB
          // enum is unchanged; only the user-facing bucket label was renamed).
          baseFilters.push(eq(renewalCycles.status, 'lapsed'));
        } else {
          baseFilters.push(
            sql`${renewalCycles.status} NOT IN ('cancelled','completed')`,
          );
          // 90-day window for the pipeline (FR-046 SC-003 sizing).
          baseFilters.push(sql`${renewalCycles.expiresAt} <= ${windowEnd}`);
        }
        if (opts.tier) {
          baseFilters.push(eq(renewalCycles.tierAtCycleStart, opts.tier));
        }
        // `baseFilters` above is PAGE-ROWS-ONLY from here on (feeds
        // `pageFilters` further down) — it is intentionally tab-dependent
        // (terminated ⇒ status='lapsed' only).

        // Fix #63 — the tab-badge summary must be a STABLE navigation count,
        // independent of which urgency tab is currently selected. It used to
        // share `baseFilters` with the page-rows query above, so selecting
        // the Terminated tab (which restricts rows to status='lapsed') also
        // restricted the summary aggregate: every non-terminated badge
        // (t-90…t-0, suspended) silently computed to 0 while that tab was
        // active. `summaryFilters` is therefore ALWAYS the non-lapsed 90-day
        // window shape (+ tier), never the terminated-specific restriction.
        const summaryFilters: SQL[] = [
          MEMBER_NOT_ERASED_SQL,
          sql`${renewalCycles.status} NOT IN ('cancelled','completed')`,
          sql`${renewalCycles.expiresAt} <= ${windowEnd}`,
        ];
        if (opts.tier) {
          summaryFilters.push(eq(renewalCycles.tierAtCycleStart, opts.tier));
        }

        // The summary is computed BEFORE the pagination cursor — admins
        // see accurate totals across the whole window even when paging.
        // Tenant-scoped automatically by the surrounding runInTenant
        // RLS context.
        //
        // Round 5 W-13 — summary + lapsedCount run in parallel via
        // Promise.all (independent queries). Saves ~5-10ms per page
        // render under Neon serverless round-trip cost.
        const summaryQueryPromise = tx
          .select({
            urgency: URGENCY_CASE_SQL.as('urgency'),
            count: sql<number>`count(*)::int`,
          })
          .from(renewalCycles)
          .where(and(...summaryFilters))
          .groupBy(URGENCY_CASE_SQL);

        // Lapsed count is queried separately because the window filter
        // for non-lapsed pages excludes lapsed cycles entirely.
        // Round 5 W-06 — apply the active tier filter so the lapsed
        // badge reflects the SAME slice the user is viewing. Without
        // this, the badge silently shows whole-tenant lapsed total
        // even when the user filtered by tier.
        const lapsedFilters: SQL[] = [
          eq(renewalCycles.status, 'lapsed'),
          // COMP-1 H4 — keep the lapsed badge count in lock-step with the
          // pipeline rows: an erased member's lapsed cycle must not inflate
          // the badge.
          MEMBER_NOT_ERASED_SQL,
        ];
        if (opts.tier) {
          lapsedFilters.push(eq(renewalCycles.tierAtCycleStart, opts.tier));
        }
        const lapsedCountQueryPromise = tx
          .select({ count: sql<number>`count(*)::int` })
          .from(renewalCycles)
          .where(and(...lapsedFilters));

        // renewals-suspended-visibility-audit — the "suspended population
        // bridge": benefit-access-suspended cycles OUTSIDE the FR-046 work
        // window (first-bill collection cases whose fixed-anchor expiry is
        // far in the future — awaiting_payment or pending_admin_
        // reactivation with expires_at beyond the shared `windowEnd`).
        // These members show as Suspended on the Members page but appear in
        // NO urgency bucket, so the pipeline's Suspended tab under-counts
        // relative to the Members page; the strip on the pipeline page uses
        // this pair to make the two numbers explain themselves.
        //
        // TENANT-GLOBAL by design (#292 review A3): the strip reconciles the
        // pipeline against the Members page's GLOBAL Suspended number, so
        // BOTH its legs deliberately ignore the tier/urgency filters — a
        // tier-sliced bridge would "explain" the badge with numbers that no
        // longer sum to what the Members page says (the exact confusion the
        // strip exists to remove). W-06's slice-consistency reasoning applies
        // to the BADGES, not this bridge. The in-window leg reuses
        // `URGENCY_CASE_SQL` (the badge's own bucket derivation) + the same
        // status/window predicates as `summaryFilters`, so the unfiltered
        // Suspended badge always equals this leg — pinned by the
        // load-pipeline integration test.
        const suspendedGlobalQueryPromise = tx
          .select({
            inWindow: sql<number>`(COUNT(*) FILTER (
              WHERE ${URGENCY_CASE_SQL} = 'suspended'
                AND ${renewalCycles.status} NOT IN ('cancelled','completed')
                AND ${renewalCycles.expiresAt} <= ${windowEnd}))::int`,
            outsideWindow: sql<number>`(COUNT(*) FILTER (
              WHERE ${renewalCycles.status} IN ('awaiting_payment','pending_admin_reactivation')
                AND ${renewalCycles.expiresAt} > ${windowEnd}))::int`,
          })
          .from(renewalCycles)
          .where(MEMBER_NOT_ERASED_SQL);

        const [summaryRows, lapsedCountRows, suspendedGlobalRows] =
          await Promise.all([
            summaryQueryPromise,
            lapsedCountQueryPromise,
            suspendedGlobalQueryPromise,
          ]);

        const byUrgency: Record<UrgencyBucket, number> = {
          't-90': 0,
          't-60': 0,
          't-30': 0,
          't-14': 0,
          't-7': 0,
          't-0': 0,
          suspended: 0,
          terminated: 0,
        };
        let totalInWindow = 0;
        for (const r of summaryRows) {
          const k = r.urgency as UrgencyBucket;
          if (k in byUrgency) {
            byUrgency[k] = r.count;
            totalInWindow += r.count;
          }
        }
        const lapsedCount = lapsedCountRows[0]?.count ?? 0;

        // Page query filters. Two mutually-exclusive shapes:
        //  - MONTH lens (opts.monthFilter present): REBUILD from
        //    MONTH_PLANNING_MEMBER_SQL — NOT baseFilters.slice(). baseFilters
        //    carries `status NOT IN (cancelled,completed)` (keeps lapsed) AND
        //    the 90-day ceiling; the month bounds ARE the window and lapsed
        //    must not leak into an `overdue` click. Tier is intentionally
        //    ignored (the chart aggregation is whole-tenant). Summary
        //    (`summaryFilters`) + lapsedCount are independent queries computed
        //    above and never rebuilt here → urgency badges are unchanged by a
        //    month filter (F3, "two independent lenses").
        //  - URGENCY lens (default): unchanged — slice baseFilters + urgency.
        let pageFilters: SQL[];
        if (opts.monthFilter && opts.nowIso) {
          pageFilters = [
            MONTH_PLANNING_MEMBER_SQL,
            monthBoundPredicate(opts.monthFilter, opts.nowIso),
          ];
        } else {
          pageFilters = baseFilters.slice();
          if (opts.urgency && opts.urgency !== 'terminated') {
            pageFilters.push(eq(URGENCY_CASE_SQL, opts.urgency));
          }
        }
        // Sort-aware keyset (Task 8). The WHERE comparison, the ORDER BY below,
        // and the emitted next-cursor all derive from `sort`, so paging "Next
        // 50" under a non-default sort never dups/skips. A tier sort needs the
        // cursor's tier ordinal; a legacy/expiry cursor lacks it, so such a
        // cursor is treated as sort-incompatible and dropped (reset to page 1)
        // rather than mis-paging — the page layer already deletes the cursor on
        // a sort change, so a live tier-sort cursor always carries `tierOrd`.
        const cursorMatchesSort =
          cursor !== null &&
          (!isTierSort(sort) || cursor.tierOrd !== undefined);
        if (cursorMatchesSort) {
          pageFilters.push(pipelineKeysetWhereSql(sort, cursor));
        }

        // Lateral subquery for last reminder
        const lastReminderSubq = tx
          .select({
            cycleId: renewalReminderEvents.cycleId,
            dispatchedAt: sql<Date | null>`MAX(${renewalReminderEvents.dispatchedAt})`.as(
              'last_reminder_at',
            ),
            stepId: sql<
              string | null
            >`(ARRAY_AGG(${renewalReminderEvents.stepId} ORDER BY ${renewalReminderEvents.dispatchedAt} DESC NULLS LAST))[1]`.as(
              'last_reminder_step_id',
            ),
          })
          .from(renewalReminderEvents)
          .where(eq(renewalReminderEvents.status, 'sent'))
          .groupBy(renewalReminderEvents.cycleId)
          .as('lr');

        // plan-change-ux L1 — the anchor invoice, joined so the "Covered"
        // projection reflects whether that invoice is still EFFECTIVELY-PAID.
        // `anchored_at` is a set-once discriminator that is NOT cleared when the
        // anchor invoice is later VOIDED (F4) or fully credit-noted / refunded
        // (F5 → §86/10 → invoice status 'credited'). Keying "Covered" purely on
        // `anchored_at IS NOT NULL` therefore renders a green "Covered" cell for
        // a member whose anchoring payment was reversed. The LEFT JOIN is a
        // PK-indexed seek on `invoices(tenant_id, invoice_id)` (≤1 row per cycle,
        // page capped at 200), so the cost is negligible. Aliased because the
        // pipeline query does not otherwise touch `invoices`.
        const anchorInvoice = alias(invoices, 'anchor_invoice');
        const pageRows = await tx
          .select({
            cycleId: renewalCycles.cycleId,
            memberId: renewalCycles.memberId,
            companyName: members.companyName,
            tierBucket: renewalCycles.tierAtCycleStart,
            expiresAt: renewalCycles.expiresAt,
            urgency: URGENCY_CASE_SQL.as('urgency'),
            status: renewalCycles.status,
            lastReminderAt: lastReminderSubq.dispatchedAt,
            lastReminderStepId: lastReminderSubq.stepId,
            linkedInvoiceId: renewalCycles.linkedInvoiceId,
            // plan-change-ux seam 1(b) + L1 — the rolling-anchor "paid coverage"
            // discriminator PLUS the anchor invoice's status, folded into the
            // `anchored` boolean below. The status is NULL for the R4 backfill
            // cohort (anchor_invoice_id IS NULL → LEFT JOIN miss) and for a
            // hard-deleted invoice (never happens for tax docs) — both treated
            // as still-covered by the null-tolerant predicate in the mapper.
            anchoredAt: renewalCycles.anchoredAt,
            anchorInvoiceStatus: anchorInvoice.status,
            // M1 (plan-change-ux, Option 1b) — the SAME correlated EXISTS the
            // billing predicate uses (coverageRetainedExistsSql), on the aliased
            // anchor invoice. TRUE when a coverage-retaining F4-manual 'keep' CN
            // exists → the `anchored` mapper below keeps "Covered" even on a
            // 'credited' anchor. Explicit tenant predicate = two-layer isolation.
            anchorRetainsCoverage:
              coverageRetainedExistsSql(anchorInvoice).as('anchor_retains_coverage'),
            closedReason: renewalCycles.closedReason,
            // J4-H13: surface members.email_unverified to the UI
            // — already JOIN'd above, so adding the column to the
            // projection is zero extra cost.
            emailUnverified: members.emailUnverified,
          })
          .from(renewalCycles)
          .leftJoin(
            members,
            and(
              eq(members.tenantId, renewalCycles.tenantId),
              eq(members.memberId, renewalCycles.memberId),
            ),
          )
          .leftJoin(
            lastReminderSubq,
            eq(lastReminderSubq.cycleId, renewalCycles.cycleId),
          )
          .leftJoin(
            anchorInvoice,
            and(
              // Explicit tenant predicate = application-layer defence-in-depth
              // atop the isolating RLS on `invoices` (Principle I two-layer).
              eq(anchorInvoice.tenantId, renewalCycles.tenantId),
              eq(anchorInvoice.invoiceId, renewalCycles.anchorInvoiceId),
            ),
          )
          .where(and(...pageFilters))
          .orderBy(pipelineOrderBySql(sort))
          .limit(limit + 1);

        const hasNextPage = pageRows.length > limit;
        const slicedRows = hasNextPage ? pageRows.slice(0, limit) : pageRows;
        const nextCursor = buildPipelineNextCursor(slicedRows, hasNextPage, sort);

        const rowsOut: PipelineRow[] = slicedRows.map((r) => ({
          cycleId: asCycleId(r.cycleId),
          memberId: r.memberId,
          companyName: r.companyName ?? '',
          tierBucket: r.tierBucket as TierBucket,
          expiresAt: r.expiresAt.toISOString(),
          urgency: r.urgency as UrgencyBucket,
          status: r.status as CycleStatus,
          lastReminderAt:
            r.lastReminderAt instanceof Date
              ? r.lastReminderAt.toISOString()
              : (r.lastReminderAt as string | null),
          lastReminderStepId: r.lastReminderStepId ?? null,
          linkedInvoiceId: r.linkedInvoiceId,
          // plan-change-ux seam 1(b) + L1 — paid-coverage flag. TRUE only when
          // the cycle is anchored AND the anchor invoice is still
          // EFFECTIVELY-PAID. A voided ('void') or FULLY credit-noted /
          // refunded ('credited') anchor no longer covers the period → not
          // "Covered". A PARTIAL credit ('partially_credited') still leaves the
          // period paid-for → still covered. A NULL status (R4 backfill with no
          // in-system invoice, or a — practically impossible — hard-deleted tax
          // invoice) is null-tolerant and stays covered: `anchored_at` alone
          // stands for the backfill cohort.
          //
          // M1 (plan-change-ux, Option 1b) — the 'credited' retraction is ESCAPED
          // when the completing credit note was an F4-manual FULL membership
          // 'keep' (member NOT refunded → coverage retained): `anchorRetainsCoverage`
          // is the SAME correlated EXISTS the billing predicate uses, so a
          // coverage-retaining 'credited' anchor still reads "Covered".
          //
          // DISPLAY + BILLING USE THE SAME EFFECTIVE-PAID RULE. This is the
          // ANCHOR-only projection of `effectivePaidCoverageSql` (task #24 + M1)
          // — the pipeline only shows OPEN cycles, so it never needs the
          // completed→linked arm. If you add or change a coverage gate HERE,
          // mirror it in `effectivePaidCoverageSql` (billing frontier + settled
          // count), and vice versa — the two must not drift.
          anchored:
            r.anchoredAt != null &&
            r.anchorInvoiceStatus !== 'void' &&
            (r.anchorInvoiceStatus !== 'credited' ||
              r.anchorRetainsCoverage === true),
          closedReason: r.closedReason as ClosedReason | null,
          // J4-H13: defaults to false when the LEFT JOIN didn't match
          // (orphan cycle without a member row — should never happen
          // under normal F8 operation; defensive).
          emailUnverified: r.emailUnverified ?? false,
        }));

        const summary: PipelineSummary = {
          totalInWindow,
          byUrgency,
          lapsedCount,
          suspendedInWindowGlobalCount: suspendedGlobalRows[0]?.inWindow ?? 0,
          suspendedOutsideWindowCount:
            suspendedGlobalRows[0]?.outsideWindow ?? 0,
        };

        return {
          rows: rowsOut,
          nextCursor,
          summary,
        };
      });
    },

    /**
     * Renewals-by-month aggregation (Task 2). Groups the shared
     * `MONTH_PLANNING_MEMBER_SQL` planning set by BKK wall-clock month,
     * then folds into overdue / 12-month window / later via the pure
     * Domain `foldRawMonths` helper.
     */
    async countCyclesByExpiryMonth(
      _tenantId: string,
      opts: { nowIso: string; timezone: 'Asia/Bangkok' },
    ): Promise<RenewalMonthAggregation> {
      // Threads `tx` from runInTenant — RLS auto-scopes; NEVER global db.
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select({
            month: EXPIRY_MONTH_SQL.as('month'),
            count: sql<number>`count(*)::int`,
          })
          .from(renewalCycles)
          .where(MONTH_PLANNING_MEMBER_SQL)
          .groupBy(EXPIRY_MONTH_SQL);
        return foldRawMonths(rows, opts.nowIso);
      });
    },

    /**
     * Rolling-anchor refactor (migration 0238) — ALL cycle rows for the
     * member, any status. In-tx (NOT `runInTenant`) so the classification
     * caller sees uncommitted writes made earlier in the SAME tx, mirroring
     * `findActiveForMemberInTx`'s in-tx-visibility rationale above.
     */
    async countCyclesForMemberInTx(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<number> {
      const txDb = tx as typeof db;
      const rows = await txDb
        .select({ count: sql<number>`count(*)::int` })
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, memberId));
      return rows[0]?.count ?? 0;
    },

    /**
     * Cluster 4 review-fix (money BLOCKER) — the member's PAID-THROUGH
     * frontier: `MAX(period_to)` over cycles that represent EFFECTIVE-PAID
     * coverage (`effectivePaidCoverageSql` — the SAME predicate
     * `countSettledCyclesForMemberInTx` uses). plan-change-ux task #24: a cycle
     * whose SETTLING invoice (linked for a completed cycle, anchor for an open
     * one) was later fully refunded / voided / credit-noted ('void'/'credited')
     * NO LONGER counts — otherwise the frontier over-reaches the refunded period
     * and the restore/comeback under-bills it. A partial credit / backfill (NULL
     * settling id) still counts (see the helper docstring). A paid cycle later
     * CANCELLED by the archive cascade still counts (its `anchored_at` survives
     * the cancel + its anchor invoice is unreversed); an unpaid cancelled/lapsed
     * cycle is excluded because it satisfies neither arm. Returns null when the
     * member has no effective-paid coverage. In-tx so the restore reads a
     * consistent snapshot with `createCycleInTx`. See the port doc for the
     * double-bill rationale.
     */
    async findMaxPaidThroughForMemberInTx(
      tx: unknown,
      tenantId: string,
      memberId: string,
    ): Promise<string | null> {
      const txDb = tx as typeof db;
      // Two LEFT JOINs — the cycle's settling invoice lives on either
      // linked_invoice_id (completed steady-state) OR anchor_invoice_id (open
      // anchored). Each is a PK seek on invoices(tenant_id, invoice_id) → ≤1 row
      // (no MAX inflation). Explicit tenant_id equality mirrors the L1 pipeline
      // join (application-layer defence-in-depth atop RLS, Principle I).
      const linkedInvoice = alias(invoices, 'linked_invoice');
      const anchorInvoice = alias(invoices, 'anchor_invoice');
      // Both frontiers in ONE pass over the member's cycles (no extra scan or
      // round-trip): `effectiveMax` is the returned billing frontier; `rawMax`
      // (the pre-task-#24 predicate) is compared to it purely to LOG a refund
      // retraction of the frontier — see rawPaidCoverageSql.
      const rows = await txDb
        .select({
          effectiveMax: sql<
            Date | string | null
          >`max(${renewalCycles.periodTo}) FILTER (WHERE ${effectivePaidCoverageSql(renewalCycles, linkedInvoice, anchorInvoice)})`,
          rawMax: sql<
            Date | string | null
          >`max(${renewalCycles.periodTo}) FILTER (WHERE ${rawPaidCoverageSql(renewalCycles)})`,
        })
        .from(renewalCycles)
        .leftJoin(
          linkedInvoice,
          and(
            eq(linkedInvoice.tenantId, renewalCycles.tenantId),
            eq(linkedInvoice.invoiceId, renewalCycles.linkedInvoiceId),
          ),
        )
        .leftJoin(
          anchorInvoice,
          and(
            eq(anchorInvoice.tenantId, renewalCycles.tenantId),
            eq(anchorInvoice.invoiceId, renewalCycles.anchorInvoiceId),
          ),
        )
        .where(eq(renewalCycles.memberId, memberId));
      // `MAX(timestamptz)` comes back as a Date from postgres.js (like the
      // other timestamptz columns); coerce defensively for a string too.
      const effectiveRaw = rows[0]?.effectiveMax ?? null;
      const rawRaw = rows[0]?.rawMax ?? null;
      const effectiveIso =
        effectiveRaw === null ? null : new Date(effectiveRaw).toISOString();
      const rawIso = rawRaw === null ? null : new Date(rawRaw).toISOString();
      // Effective ⊆ raw always, so any divergence ⟺ a void/credited settling
      // invoice retracted the frontier (a silent money-behaviour change: the
      // restore/comeback now re-bills a period the old rule treated as paid).
      // Log it so the first prod occurrences are visible. No PII — tenant/member
      // ids + ISO instants only.
      if (rawIso !== effectiveIso) {
        logger.info(
          {
            tenantId,
            memberId,
            effectivePaidThrough: effectiveIso,
            rawPaidThrough: rawIso,
          },
          'renewals.effective_paid_frontier_retracted',
        );
      }
      return effectiveIso;
    },

    /**
     * F2 fix (final-review, 2026-07-09) — count of the member's cycles,
     * EXCLUDING `excludeCycleId` (the caller's current open cycle), that
     * represent EFFECTIVE-PAID coverage (`effectivePaidCoverageSql` — the SAME
     * predicate `findMaxPaidThroughForMemberInTx` uses). plan-change-ux task
     * #24: a cycle whose settling invoice was fully refunded / voided /
     * credit-noted no longer counts, so a member whose only prior cycle was
     * refunded classifies `first_payment` (not `renewal`) on their next
     * payment. In-tx for the same uncommitted-visibility reason as
     * `countCyclesForMemberInTx` above.
     */
    async countSettledCyclesForMemberInTx(
      tx: unknown,
      _tenantId: string,
      memberId: string,
      excludeCycleId: string,
    ): Promise<number> {
      const txDb = tx as typeof db;
      // Same two-arm effective-paid join as findMaxPaidThroughForMemberInTx —
      // each PK seek yields ≤1 row so count(*) is not inflated.
      const linkedInvoice = alias(invoices, 'linked_invoice');
      const anchorInvoice = alias(invoices, 'anchor_invoice');
      const rows = await txDb
        .select({ count: sql<number>`count(*)::int` })
        .from(renewalCycles)
        .leftJoin(
          linkedInvoice,
          and(
            eq(linkedInvoice.tenantId, renewalCycles.tenantId),
            eq(linkedInvoice.invoiceId, renewalCycles.linkedInvoiceId),
          ),
        )
        .leftJoin(
          anchorInvoice,
          and(
            eq(anchorInvoice.tenantId, renewalCycles.tenantId),
            eq(anchorInvoice.invoiceId, renewalCycles.anchorInvoiceId),
          ),
        )
        .where(
          and(
            eq(renewalCycles.memberId, memberId),
            ne(renewalCycles.cycleId, excludeCycleId),
            effectivePaidCoverageSql(
              renewalCycles,
              linkedInvoice,
              anchorInvoice,
            ),
          ),
        );
      return rows[0]?.count ?? 0;
    },

    /**
     * Rolling-anchor refactor (migration 0238) — the member's open cycle
     * (status IN upcoming|reminded|awaiting_payment), or null. At most one
     * by the `renewal_cycles_active_member_uniq` partial-unique invariant;
     * `'reminded'` is folded into the open set defensively even though it's
     * a vestigial status no current writer produces.
     */
    async findOpenCycleForMemberInTx(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<RenewalCycle | null> {
      const txDb = tx as typeof db;
      const rows = await txDb
        .select()
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.memberId, memberId),
            inArray(renewalCycles.status, [...OPEN_CYCLE_STATUSES]),
          ),
        )
        .limit(1);
      return rows[0] ? rowToDomain(rows[0]) : null;
    },

    // 066 F-5 review — in-tx latest cycle across ALL statuses. Mirrors
    // `findLatestCycleForMember`'s ORDER key but threads the caller's tx
    // (no nested runInTenant) so the terminal_only net can derive access on
    // the payment tx's own connection (RLS already SET on it).
    async findLatestCycleForMemberInTx(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<RenewalCycle | null> {
      const txDb = tx as typeof db;
      const rows = await txDb
        .select()
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, memberId))
        .orderBy(desc(renewalCycles.createdAt), desc(renewalCycles.cycleId))
        .limit(1);
      return rows[0] ? rowToDomain(rows[0]) : null;
    },

    /**
     * Rolling-anchor refactor (migration 0238) — rolling first-payment
     * re-anchor (spec rev 2 §2). Guarded single UPDATE: only an
     * un-anchored open cycle qualifies (`anchoredAt IS NULL` + status IN
     * the active set). `status` is force-reset to `'upcoming'` regardless
     * of the cycle's current active status — a SANCTIONED bypass of
     * `transitionStatus`'s `assertCanTransition` guard, because re-anchor
     * restarts the reminder ladder from its beginning rather than
     * following a normal lifecycle edge. `linkedInvoiceId` is cleared so
     * the member's actual next renewal invoice can link cleanly through
     * the `linkInvoice` I1 idempotent-or-conflict guard. Frozen-plan
     * fields are overwritten with the caller-supplied values (pass the
     * cycle's current values when no re-resolution is needed).
     *
     * Returns `null` when the guard matched 0 rows — either the cycle no
     * longer exists, was already anchored (race), moved to a terminal
     * status, or belongs to a different tenant (RLS hides it). The caller
     * re-reads and reclassifies rather than treating this as a hard error.
     *
     * Deletes the cycle's `renewal_reminder_events` rows in the SAME tx
     * ONLY WHEN `period_to` actually moves (the moved period invalidates any
     * dispatch history logged against the old one, and its stale
     * `year_in_cycle` keys would collide with — and silently suppress — the
     * NEW period's reminders). Under fixed-anchor a first payment normally
     * KEEPS the period, so nothing is deleted; the delete fires only on a
     * period-moving re-anchor (the comeback exception and the CSV backfill).
     * Returns the deleted count so the caller can audit `reminderEventsReset`
     * (review H-1, 2026-07-22).
     */
    async reanchorPeriodInTx(
      tx: unknown,
      _tenantId: string,
      cycleId: CycleId,
      args: {
        readonly periodFrom: string;
        readonly periodTo: string;
        readonly anchoredAt: string;
        readonly anchorInvoiceId: string | null;
        readonly frozenPlanPriceThb: ThbDecimal;
        readonly frozenPlanTermMonths: number;
      },
    ): Promise<{ readonly cycle: RenewalCycle; readonly reminderEventsReset: number } | null> {
      const txDb = tx as typeof db;
      // Read the CURRENT period_to (same tx) before the UPDATE so we can tell a
      // period-KEEPING re-anchor (fixed-anchor normal first payment) from a
      // period-MOVING one (the comeback exception or the CSV backfill). Only
      // the latter must reset the reminder ladder (review H-1).
      const existing = await txDb
        .select({ periodTo: renewalCycles.periodTo })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1);
      const oldPeriodTo = existing[0]?.periodTo ?? null;

      const updated = await txDb
        .update(renewalCycles)
        .set({
          periodFrom: new Date(args.periodFrom),
          periodTo: new Date(args.periodTo),
          status: 'upcoming', // sanctioned TRANSITIONS bypass — spec rev 2 §2
          anchoredAt: new Date(args.anchoredAt),
          anchorInvoiceId: args.anchorInvoiceId,
          linkedInvoiceId: null,
          frozenPlanPriceThb: args.frozenPlanPriceThb,
          frozenPlanTermMonths: args.frozenPlanTermMonths,
        })
        .where(
          and(
            eq(renewalCycles.cycleId, cycleId),
            inArray(renewalCycles.status, [
              'upcoming',
              'reminded',
              'awaiting_payment',
            ]),
            isNull(renewalCycles.anchoredAt),
          ),
        )
        .returning();
      const row = updated[0];
      if (!row) return null;

      // FIXED-ANCHOR (2026-07-22): first payment normally KEEPS the cycle's
      // registration/backfill period (only stamps `anchored_at` + activates the
      // status), so its reminder events stay valid and are NOT deleted. But when
      // the period actually MOVES — the comeback exception grants a fresh period,
      // or the CSV backfill re-anchors a pre-system member — the old period's
      // reminder rows must be purged: their `year_in_cycle` keys would otherwise
      // collide with the new period's reminders and suppress them as
      // already-sent (silent renewal-lapse; review H-1).
      const periodMoved =
        oldPeriodTo === null || oldPeriodTo.getTime() !== new Date(args.periodTo).getTime();
      if (!periodMoved) {
        return { cycle: rowToDomain(row), reminderEventsReset: 0 };
      }
      const deleted = await txDb
        .delete(renewalReminderEvents)
        .where(eq(renewalReminderEvents.cycleId, cycleId))
        .returning({ id: renewalReminderEvents.reminderEventId });
      return { cycle: rowToDomain(row), reminderEventsReset: deleted.length };
    },
  };
}
