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
import { db, runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { parseThbDecimal, type ThbDecimal } from '@/lib/money';
import type { TenantContext } from '@/modules/tenants';
import { renewalCycles, type RenewalCycleRow } from '../schema-renewal-cycles';
import { renewalReminderEvents } from '../schema-renewal-reminder-events';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
  InvoiceLinkConflictError,
  type ListMembersWithoutCycleOpts,
  type ListRenewalCyclesOpts,
  type MembersWithoutCyclePage,
  type NewRenewalCycleInput,
  type PipelineQueryOpts,
  type PipelineQueryResult,
  type PipelineRow,
  type PipelineSummary,
  type RenewalCyclePage,
  type RenewalCycleRepo,
  type UrgencyBucket,
} from '../../application/ports/renewal-cycle-repo';
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
import type { TierBucket } from '../../domain/value-objects/tier-bucket';
import {
  foldRawMonths,
  bkkYearMonth,
  addMonthsToYm,
  bkkMonthStartInstant,
} from '../../domain/renewal-month-bucket';
import type { RenewalMonthAggregation } from '../../domain/renewal-month-bucket';

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
    return { expiresAt: parsed.expiresAt, cycleId: parsed.cycleId };
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
// Urgency derivation SQL (DB-side per FR-046)
// ---------------------------------------------------------------------------

/**
 * Build the SQL CASE expression that maps `(status, expires_at)` to one
 * of 8 urgency buckets. `lapsed` short-circuits on status; everything
 * else is derived from days-until-expiry by direct interval comparison
 * (sargable — uses `expires_at` index instead of EPOCH math per branch).
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
 *   grace: expires_at >= NOW() - 30 days     (post-expiry, in grace window)
 *   lapsed: status='lapsed' OR > 30 days past expiry
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

const URGENCY_CASE_SQL = sql<UrgencyBucket>`
  CASE
    WHEN ${renewalCycles.status} = 'lapsed' THEN 'lapsed'
    WHEN ${renewalCycles.expiresAt} > NOW() + INTERVAL '60 days' THEN 't-90'
    WHEN ${renewalCycles.expiresAt} > NOW() + INTERVAL '30 days' THEN 't-60'
    WHEN ${renewalCycles.expiresAt} > NOW() + INTERVAL '14 days' THEN 't-30'
    WHEN ${renewalCycles.expiresAt} > NOW() + INTERVAL '7 days'  THEN 't-14'
    WHEN ${renewalCycles.expiresAt} > NOW() + INTERVAL '1 day'   THEN 't-7'
    WHEN ${renewalCycles.expiresAt} > NOW()                       THEN 't-0'
    WHEN ${renewalCycles.expiresAt} >= NOW() - INTERVAL '30 days' THEN 'grace'
    ELSE 'lapsed'
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
      _tenantId: string,
      memberIds: readonly string[],
    ): Promise<ReadonlyArray<RenewalCycle>> {
      if (memberIds.length === 0) return [];
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .selectDistinctOn([renewalCycles.memberId])
          .from(renewalCycles)
          .where(inArray(renewalCycles.memberId, [...memberIds]))
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
     */
    async findLatestCycleForMember(
      _tenantId: string,
      memberId: string,
    ): Promise<RenewalCycle | null> {
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select()
          .from(renewalCycles)
          .where(eq(renewalCycles.memberId, memberId))
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

      const updated = await txDb
        .update(renewalCycles)
        .set(setClause)
        .where(
          and(
            eq(renewalCycles.cycleId, cycleId),
            eq(renewalCycles.status, args.from),
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

        // Window definition: active cycles only EXCEPT lapsed tab which
        // explicitly returns lapsed cycles. The window is "next 90 days"
        // for non-lapsed urgency buckets.
        const baseFilters: SQL[] = [
          // COMP-1 H4 — exclude GDPR-erased members from the pipeline
          // window. Drives BOTH the summary aggregate below AND the page
          // query (via `pageFilters = baseFilters.slice()`), so the badge
          // counts always agree with the rows shown. `markCycleComplete-
          // FromInvoicePaid` routes a paid erased member's cycle to the
          // NON-terminal `pending_admin_reactivation`, so erased members
          // are actively pushed into this window without this filter.
          MEMBER_NOT_ERASED_SQL,
        ];
        if (opts.urgency === 'lapsed') {
          baseFilters.push(eq(renewalCycles.status, 'lapsed'));
        } else {
          baseFilters.push(
            sql`${renewalCycles.status} NOT IN ('cancelled','completed')`,
          );
          // 90-day window for the pipeline (FR-046 SC-003 sizing).
          baseFilters.push(
            sql`${renewalCycles.expiresAt} <= NOW() + INTERVAL '90 days'`,
          );
        }
        if (opts.tier) {
          baseFilters.push(eq(renewalCycles.tierAtCycleStart, opts.tier));
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
          .where(and(...baseFilters))
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

        const [summaryRows, lapsedCountRows] = await Promise.all([
          summaryQueryPromise,
          lapsedCountQueryPromise,
        ]);

        const byUrgency: Record<UrgencyBucket, number> = {
          't-90': 0,
          't-60': 0,
          't-30': 0,
          't-14': 0,
          't-7': 0,
          't-0': 0,
          grace: 0,
          lapsed: 0,
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
        //    ignored (the chart aggregation is whole-tenant). Summary +
        //    lapsedCount above stay on `baseFilters` → urgency badges are
        //    unchanged by a month filter (F3, "two independent lenses").
        //  - URGENCY lens (default): unchanged — slice baseFilters + urgency.
        let pageFilters: SQL[];
        if (opts.monthFilter && opts.nowIso) {
          pageFilters = [
            MONTH_PLANNING_MEMBER_SQL,
            monthBoundPredicate(opts.monthFilter, opts.nowIso),
          ];
        } else {
          pageFilters = baseFilters.slice();
          if (opts.urgency && opts.urgency !== 'lapsed') {
            pageFilters.push(eq(URGENCY_CASE_SQL, opts.urgency));
          }
        }
        if (cursor) {
          pageFilters.push(
            or(
              sql`${renewalCycles.expiresAt} > ${cursor.expiresAt}`,
              and(
                eq(renewalCycles.expiresAt, new Date(cursor.expiresAt)),
                sql`${renewalCycles.cycleId} > ${cursor.cycleId}`,
              ),
            )!,
          );
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
            // plan-change-ux seam 1(b) — the rolling-anchor "paid coverage"
            // discriminator. Zero-cost additive projection (already on this
            // table); mapped to the `anchored` boolean below. NO join to
            // `invoices` (anchor_invoice_id is forensic-only + NULL for the
            // R4 backfill, so a document-number join would be fragile).
            anchoredAt: renewalCycles.anchoredAt,
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
          .where(and(...pageFilters))
          .orderBy(
            sql`${renewalCycles.expiresAt} ASC, ${renewalCycles.cycleId} ASC`,
          )
          .limit(limit + 1);

        const hasNextPage = pageRows.length > limit;
        const slicedRows = hasNextPage ? pageRows.slice(0, limit) : pageRows;
        const nextCursor = buildNextCursor(slicedRows, hasNextPage);

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
          // plan-change-ux seam 1(b) — paid-coverage flag from the anchor
          // discriminator. `!= null` catches both a real payment anchor and
          // the R4 backfill (both stamp `anchored_at`).
          anchored: r.anchoredAt != null,
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
     * frontier: `MAX(period_to)` over cycles that represent SETTLED / paid
     * coverage (`status = 'completed' OR anchored_at IS NOT NULL` — the same
     * "paid" predicate `countSettledCyclesForMemberInTx` uses). Status is not
     * otherwise filtered: a paid cycle later CANCELLED by the archive cascade
     * still counts (its `anchored_at` survives the cancel), while an unpaid
     * cancelled/lapsed cycle is excluded because it satisfies neither positive
     * predicate. Returns null when the member has no paid coverage. In-tx so
     * the restore reads a consistent snapshot with `createCycleInTx`. See the
     * port doc for the double-bill rationale.
     */
    async findMaxPaidThroughForMemberInTx(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<string | null> {
      const txDb = tx as typeof db;
      const rows = await txDb
        .select({
          maxPeriodTo: sql<
            Date | string | null
          >`max(${renewalCycles.periodTo})`,
        })
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.memberId, memberId),
            or(
              eq(renewalCycles.status, 'completed'),
              isNotNull(renewalCycles.anchoredAt),
            ),
          ),
        );
      const raw = rows[0]?.maxPeriodTo ?? null;
      // `MAX(timestamptz)` comes back as a Date from postgres.js (like the
      // other timestamptz columns); coerce defensively for a string too.
      return raw === null ? null : new Date(raw).toISOString();
    },

    /**
     * F2 fix (final-review, 2026-07-09) — count of the member's cycles,
     * EXCLUDING `excludeCycleId` (the caller's current open cycle), that
     * represent a SETTLED renewal: status 'completed' OR
     * anchored_at IS NOT NULL. In-tx for the same uncommitted-visibility
     * reason as `countCyclesForMemberInTx` above.
     */
    async countSettledCyclesForMemberInTx(
      tx: unknown,
      _tenantId: string,
      memberId: string,
      excludeCycleId: string,
    ): Promise<number> {
      const txDb = tx as typeof db;
      const rows = await txDb
        .select({ count: sql<number>`count(*)::int` })
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.memberId, memberId),
            ne(renewalCycles.cycleId, excludeCycleId),
            or(
              eq(renewalCycles.status, 'completed'),
              isNotNull(renewalCycles.anchoredAt),
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
