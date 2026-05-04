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
import { and, eq, sql, inArray, or, isNull, type SQL } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { renewalCycles, type RenewalCycleRow } from '../schema-renewal-cycles';
import { renewalReminderEvents } from '../schema-renewal-reminder-events';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
  type ListRenewalCyclesOpts,
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
import type { CycleStatus } from '../../domain/value-objects/cycle-status';
import type { TierBucket } from '../../domain/value-objects/tier-bucket';

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
    frozenPlanPriceThb: row.frozenPlanPriceThb,
    frozenPlanTermMonths: row.frozenPlanTermMonths,
    frozenPlanCurrency: row.frozenPlanCurrency as 'THB',
    linkedCreditNoteId: row.linkedCreditNoteId,
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
        closedReason: closedReason as 'lapsed' | 'pending_reactivation_timed_out',
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
// Cursor encoding (opaque base64 of `expires_at|cycle_id`)
// ---------------------------------------------------------------------------

interface CursorPayload {
  readonly expiresAt: string;
  readonly cycleId: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(
    JSON.stringify(payload),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): CursorPayload | null {
  if (!cursor) return null;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
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
        if (opts.maxDaysUntilExpiry !== undefined) {
          filters.push(
            sql`${renewalCycles.expiresAt} <= NOW() + (${opts.maxDaysUntilExpiry} || ' days')::interval`,
          );
        }
        const whereClause = filters.length > 0 ? and(...filters) : undefined;

        const rows = await tx
          .select()
          .from(renewalCycles)
          .where(whereClause)
          .orderBy(
            opts.sort === 'created_at_desc'
              ? sql`${renewalCycles.createdAt} DESC`
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
          sql`${renewalCycles.status} IN ('upcoming','reminded','awaiting_payment')`,
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
        const baseFilters: SQL[] = [];
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
        const lapsedFilters: SQL[] = [eq(renewalCycles.status, 'lapsed')];
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

        // Page query: filter + cursor + ORDER BY (expires_at, cycle_id) ASC + limit+1
        const pageFilters = baseFilters.slice();
        if (opts.urgency && opts.urgency !== 'lapsed') {
          pageFilters.push(eq(URGENCY_CASE_SQL, opts.urgency));
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
            closedReason: renewalCycles.closedReason,
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
          closedReason: r.closedReason as ClosedReason | null,
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
  };
}

// Suppress unused import warning for `isNull` (kept for future deletion-aware joins)
void isNull;
