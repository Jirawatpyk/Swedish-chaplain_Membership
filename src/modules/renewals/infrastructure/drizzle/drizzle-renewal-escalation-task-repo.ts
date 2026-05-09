/**
 * F8 Phase 4 Wave I2b — Drizzle adapter for `RenewalEscalationTaskRepo`.
 *
 * Implements the F8 port `RenewalEscalationTaskRepo` (Wave E T044)
 * against the `renewal_escalation_tasks` table (Wave C migration 0092).
 * Tenant isolation is enforced by Postgres RLS+FORCE — every method
 * wraps its query in `runInTenant(ctx, …)` which sets `SET LOCAL ROLE
 * chamber_app` + `SET LOCAL app.current_tenant`. NO explicit
 * `WHERE tenant_id = ?` — the policy adds it automatically.
 *
 * Phase 4 directly exercises:
 *   - `listOpenForMemberByType` — by T091 reset-email-unverified
 *     (find `manual_outreach_required` tasks to close)
 *   - `transitionStatus` — by T091 (close found tasks); WHERE
 *     `status='open'` defeats TOCTOU between list + transition
 *   - `insertIfAbsent` — by T088 dispatch-renewal-cycle (Wave I2c) +
 *     T090 detect-bounce-threshold (Wave I2d) when creating new
 *     `manual_outreach_required` tasks; idempotent on the partial
 *     UNIQUE `(tenant, member, cycle, task_type) WHERE status='open'`
 *
 * Wave I8 (T118+ admin task queue) will exercise `list`, `listOpenForUser`,
 * `findById`, `reassign`. Adapter ships full surface so no rework is
 * needed when those waves land.
 */
import { and, eq, sql, asc, desc, isNull, count, lt, or, gt } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { renewalEscalationTasks, type RenewalEscalationTaskRow } from '../schema-renewal-escalation-tasks';
import { renewalCycles } from '../schema-renewal-cycles';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { users } from '@/modules/auth/infrastructure/db/schema';
import {
  ESCALATION_UNASSIGNED_FILTER,
  EscalationTaskNotFoundError,
  InvalidCursorError,
  type EscalationTaskAdminQueuePage,
  type EscalationTaskPage,
  type EscalationTaskWithMember,
  type ListEscalationTasksOpts,
  type NewEscalationTaskInput,
  type RenewalEscalationTaskRepo,
} from '../../application/ports/renewal-escalation-task-repo';
import {
  asTaskId,
  type EscalationAssigneeRole,
  type EscalationTaskStatus,
  type RenewalEscalationTask,
  type TaskId,
} from '../../domain/renewal-escalation-task';

// ---------------------------------------------------------------------------
// Row → Domain translation
// ---------------------------------------------------------------------------

/**
 * Translate a Drizzle row into a typed `RenewalEscalationTask`. The
 * 3-state status union is narrowed via the row's `status` field; DB
 * CHECK constraints guarantee the closure-fields invariants
 * (closedAt + closedByUserId NOT NULL when status terminal,
 * outcomeNote XOR skippedReason). The cast is therefore safe at
 * runtime even though TS can't follow the conditional logic.
 */
export function rowToDomain(row: RenewalEscalationTaskRow): RenewalEscalationTask {
  const base = {
    tenantId: row.tenantId,
    taskId: asTaskId(row.taskId),
    memberId: row.memberId,
    cycleId: row.cycleId,
    taskType: row.taskType,
    assignedToRole: row.assignedToRole as EscalationAssigneeRole,
    assignedToUserId: row.assignedToUserId,
    dueAt: row.dueAt.toISOString(),
    relatedSuggestionId: row.relatedSuggestionId,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.status === 'open') {
    return {
      ...base,
      status: 'open',
      outcomeNote: null,
      skippedReason: null,
      closedByUserId: null,
      closedAt: null,
    };
  }
  if (row.status === 'done') {
    if (!row.closedAt || !row.closedByUserId) {
      throw new Error(
        `F8 invariant violation: task ${row.taskId} status=done but closedAt or closedByUserId is null — DB CHECK regression`,
      );
    }
    return {
      ...base,
      status: 'done',
      outcomeNote: row.outcomeNote,
      skippedReason: null,
      closedByUserId: row.closedByUserId,
      closedAt: row.closedAt.toISOString(),
    };
  }
  // skipped
  if (!row.closedAt || !row.closedByUserId || !row.skippedReason) {
    throw new Error(
      `F8 invariant violation: task ${row.taskId} status=skipped but closedAt / closedByUserId / skippedReason is null — DB CHECK regression`,
    );
  }
  return {
    ...base,
    status: 'skipped',
    outcomeNote: null,
    skippedReason: row.skippedReason,
    closedByUserId: row.closedByUserId,
    closedAt: row.closedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Per-tenant factory
// ---------------------------------------------------------------------------

export function makeDrizzleRenewalEscalationTaskRepo(
  tenant: TenantContext,
): RenewalEscalationTaskRepo {
  return {
    async insertIfAbsent(tx: unknown, input: NewEscalationTaskInput) {
      const txDb = tx as typeof db;
      // Try insert; ON CONFLICT against the partial UNIQUE
      // (tenant, member, cycle, task_type) WHERE status='open' is
      // handled by the dedicated `open_idem_idx`. The constraint name
      // is provided so Drizzle's targetWhere clause matches the partial
      // index correctly.
      const inserted = await txDb
        .insert(renewalEscalationTasks)
        .values({
          tenantId: tenant.slug,
          taskId: input.taskId,
          memberId: input.memberId,
          cycleId: input.cycleId,
          taskType: input.taskType,
          assignedToRole: input.assignedToRole,
          assignedToUserId: input.assignedToUserId ?? null,
          dueAt: new Date(input.dueAt),
          relatedSuggestionId: input.relatedSuggestionId ?? null,
        })
        .onConflictDoNothing({
          target: [
            renewalEscalationTasks.tenantId,
            renewalEscalationTasks.memberId,
            renewalEscalationTasks.cycleId,
            renewalEscalationTasks.taskType,
          ],
          where: sql`status = 'open'`,
        })
        .returning();
      if (inserted[0]) {
        return { created: true, row: rowToDomain(inserted[0]) };
      }
      // Conflict — fetch the existing open row.
      const existing = await txDb
        .select()
        .from(renewalEscalationTasks)
        .where(
          and(
            eq(renewalEscalationTasks.memberId, input.memberId),
            input.cycleId === null
              ? sql`${renewalEscalationTasks.cycleId} IS NULL`
              : eq(renewalEscalationTasks.cycleId, input.cycleId),
            eq(renewalEscalationTasks.taskType, input.taskType),
            eq(renewalEscalationTasks.status, 'open'),
          ),
        )
        .limit(1);
      if (!existing[0]) {
        throw new Error(
          `insertIfAbsent: ON CONFLICT DO NOTHING returned no row but no existing open task found — RLS or partial-unique-index regression`,
        );
      }
      return { created: false, row: rowToDomain(existing[0]) };
    },

    async findById(_tenantId: string, taskId: TaskId) {
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select()
          .from(renewalEscalationTasks)
          .where(eq(renewalEscalationTasks.taskId, taskId))
          .limit(1);
        return rows[0] ? rowToDomain(rows[0]) : null;
      });
    },

    async list(
      _tenantId: string,
      opts: ListEscalationTasksOpts,
    ): Promise<EscalationTaskPage> {
      return runInTenant(tenant, async (tx) => {
        const whereExpr = buildListWhereExpr(opts);

        const orderExpr =
          opts.sort === 'due_at_desc'
            ? desc(renewalEscalationTasks.dueAt)
            : opts.sort === 'created_at_desc'
            ? desc(renewalEscalationTasks.createdAt)
            : asc(renewalEscalationTasks.dueAt);

        const rows = whereExpr
          ? await tx
              .select()
              .from(renewalEscalationTasks)
              .where(whereExpr)
              .orderBy(orderExpr)
              .limit(opts.pageSize + 1)
          : await tx
              .select()
              .from(renewalEscalationTasks)
              .orderBy(orderExpr)
              .limit(opts.pageSize + 1);
        const hasMore = rows.length > opts.pageSize;
        const items = (hasMore ? rows.slice(0, opts.pageSize) : rows).map(
          rowToDomain,
        );
        // Cursor pagination is not yet wired (Wave I8 admin queue UI
        // will add it). Returning null preserves the port contract.
        return { items, nextCursor: null };
      });
    },

    async listOpenForUser(_tenantId: string, userId: string) {
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select()
          .from(renewalEscalationTasks)
          .where(
            and(
              eq(renewalEscalationTasks.assignedToUserId, userId),
              eq(renewalEscalationTasks.status, 'open'),
            ),
          )
          .orderBy(asc(renewalEscalationTasks.dueAt));
        return rows.map(rowToDomain);
      });
    },

    async listOpenForMemberByType(
      _tenantId: string,
      memberId: string,
      taskType: string,
    ) {
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select()
          .from(renewalEscalationTasks)
          .where(
            and(
              eq(renewalEscalationTasks.memberId, memberId),
              eq(renewalEscalationTasks.taskType, taskType),
              eq(renewalEscalationTasks.status, 'open'),
            ),
          )
          .orderBy(asc(renewalEscalationTasks.dueAt));
        return rows.map(rowToDomain);
      });
    },

    async transitionStatus(
      tx: unknown,
      _tenantId: string,
      taskId: TaskId,
      args: {
        readonly to: Exclude<EscalationTaskStatus, 'open'>;
        readonly closedAt: string;
        readonly closedByUserId?: string;
        readonly outcomeNote?: string;
        readonly skippedReason?: string;
      },
    ) {
      const txDb = tx as typeof db;
      // WHERE status='open' defeats TOCTOU — concurrent transition
      // attempts deterministically produce one winner; the loser sees
      // affectedRows=0 and we throw the typed not-found error.
      const updated = await txDb
        .update(renewalEscalationTasks)
        .set({
          status: args.to,
          closedAt: new Date(args.closedAt),
          closedByUserId: args.closedByUserId ?? null,
          outcomeNote: args.to === 'done' ? args.outcomeNote ?? null : null,
          skippedReason:
            args.to === 'skipped' ? args.skippedReason ?? null : null,
        })
        .where(
          and(
            eq(renewalEscalationTasks.taskId, taskId),
            eq(renewalEscalationTasks.status, 'open'),
          ),
        )
        .returning();
      if (!updated[0]) {
        throw new EscalationTaskNotFoundError(taskId);
      }
      return rowToDomain(updated[0]);
    },

    async reassign(
      tx: unknown,
      _tenantId: string,
      taskId: TaskId,
      newAssigneeUserId: string,
    ) {
      const txDb = tx as typeof db;
      const updated = await txDb
        .update(renewalEscalationTasks)
        .set({ assignedToUserId: newAssigneeUserId })
        .where(
          and(
            eq(renewalEscalationTasks.taskId, taskId),
            eq(renewalEscalationTasks.status, 'open'),
          ),
        )
        .returning();
      if (!updated[0]) {
        throw new EscalationTaskNotFoundError(taskId);
      }
      return rowToDomain(updated[0]);
    },

    async countMatching(
      _tenantId: string,
      opts: Pick<
        ListEscalationTasksOpts,
        'statusFilter' | 'assignedToUserIdFilter' | 'overdueOnly'
      >,
    ): Promise<number> {
      return runInTenant(tenant, async (tx) => {
        const whereExpr = buildListWhereExpr(opts);
        const rows = whereExpr
          ? await tx
              .select({ value: count() })
              .from(renewalEscalationTasks)
              .where(whereExpr)
          : await tx
              .select({ value: count() })
              .from(renewalEscalationTasks);
        return Number(rows[0]?.value ?? 0);
      });
    },

    async listForAdminQueue(
      _tenantId: string,
      opts: ListEscalationTasksOpts,
    ): Promise<EscalationTaskAdminQueuePage> {
      return runInTenant(tenant, async (tx) => {
        const whereParts: Array<ReturnType<typeof eq>> = [];
        const baseWhere = buildListWhereExpr(opts);
        if (baseWhere !== undefined) {
          whereParts.push(baseWhere as ReturnType<typeof eq>);
        }
        // Cursor: opaque "<dueAtIso>|<taskId>" — keyset paginate by
        // (due_at, task_id). Newer cursor format keeps deterministic
        // ordering when many tasks share the same due_at minute.
        //
        // Round 5 I-7 close — a malformed cursor used to silently fall
        // through and return the FIRST page (page-1 stuck-loop hazard).
        // Throw `InvalidCursorError` so the route maps to 400 and the
        // client clears the bad cursor instead of looping.
        if (opts.cursor !== undefined && opts.cursor.length > 0) {
          const sep = opts.cursor.indexOf('|');
          if (sep <= 0) {
            throw new InvalidCursorError(opts.cursor);
          }
          const cursorDueAt = opts.cursor.slice(0, sep);
          const cursorTaskId = opts.cursor.slice(sep + 1);
          const cursorDate = new Date(cursorDueAt);
          if (Number.isNaN(cursorDate.getTime()) || cursorTaskId.length === 0) {
            throw new InvalidCursorError(opts.cursor);
          }
          const cmp =
            opts.sort === 'due_at_desc'
              ? or(
                  lt(renewalEscalationTasks.dueAt, cursorDate),
                  and(
                    eq(renewalEscalationTasks.dueAt, cursorDate),
                    lt(renewalEscalationTasks.taskId, cursorTaskId),
                  ),
                )
              : or(
                  gt(renewalEscalationTasks.dueAt, cursorDate),
                  and(
                    eq(renewalEscalationTasks.dueAt, cursorDate),
                    gt(renewalEscalationTasks.taskId, cursorTaskId),
                  ),
                );
          if (cmp !== undefined) {
            whereParts.push(cmp as ReturnType<typeof eq>);
          }
        }
        const whereExpr =
          whereParts.length === 0
            ? undefined
            : whereParts.length === 1
              ? whereParts[0]
              : and(...whereParts);

        const orderExpr =
          opts.sort === 'due_at_desc'
            ? desc(renewalEscalationTasks.dueAt)
            : opts.sort === 'created_at_desc'
              ? desc(renewalEscalationTasks.createdAt)
              : asc(renewalEscalationTasks.dueAt);

        // LEFT JOIN members + renewal_cycles + membership_plans + users
        // (Round 5 I-13 close — assignee display name) so we surface
        // the AS1-mandated company name + tier bucket + cycle expiry +
        // assignee display name alongside the task row in a single
        // round-trip. RLS+FORCE on `members` + `renewal_cycles` shields
        // cross-tenant rows. `users` is global (MTA model — no per-
        // tenant scope yet).
        const baseQuery = tx
          .select({
            task: renewalEscalationTasks,
            companyName: members.companyName,
            tierBucket: membershipPlans.renewalTierBucket,
            cycleExpiresAt: renewalCycles.expiresAt,
            assigneeDisplayName: users.displayName,
            assigneeEmail: users.email,
          })
          .from(renewalEscalationTasks)
          .leftJoin(
            members,
            and(
              eq(members.tenantId, renewalEscalationTasks.tenantId),
              eq(members.memberId, renewalEscalationTasks.memberId),
            ),
          )
          .leftJoin(
            membershipPlans,
            and(
              eq(membershipPlans.tenantId, members.tenantId),
              eq(membershipPlans.planId, members.planId),
            ),
          )
          .leftJoin(
            renewalCycles,
            and(
              eq(renewalCycles.tenantId, renewalEscalationTasks.tenantId),
              eq(renewalCycles.cycleId, renewalEscalationTasks.cycleId),
            ),
          )
          .leftJoin(
            users,
            eq(users.id, renewalEscalationTasks.assignedToUserId),
          );
        const rows = whereExpr
          ? await baseQuery
              .where(whereExpr)
              .orderBy(
                orderExpr,
                opts.sort === 'due_at_desc'
                  ? desc(renewalEscalationTasks.taskId)
                  : asc(renewalEscalationTasks.taskId),
              )
              .limit(opts.pageSize + 1)
          : await baseQuery
              .orderBy(
                orderExpr,
                opts.sort === 'due_at_desc'
                  ? desc(renewalEscalationTasks.taskId)
                  : asc(renewalEscalationTasks.taskId),
              )
              .limit(opts.pageSize + 1);

        const hasMore = rows.length > opts.pageSize;
        const pageRows = hasMore ? rows.slice(0, opts.pageSize) : rows;
        const items: EscalationTaskWithMember[] = pageRows.map((r) => ({
          ...rowToDomain(r.task),
          memberCompanyName: r.companyName ?? null,
          memberTierBucket: r.tierBucket ?? null,
          cycleExpiresAt: r.cycleExpiresAt
            ? r.cycleExpiresAt.toISOString()
            : null,
          assignedToDisplayName: r.assigneeDisplayName ?? null,
          assignedToEmail: r.assigneeEmail ?? null,
        }));
        const last = items[items.length - 1];
        const nextCursor =
          hasMore && last ? `${last.dueAt}|${last.taskId}` : null;
        return { items, nextCursor };
      });
    },
  };
}

/**
 * F8 Phase 8 T214 — shared filter-builder used by both `list` and
 * `countMatching` so the queue-top overdue banner counts what the rows
 * below it would actually display.
 */
function buildListWhereExpr(
  opts: Pick<
    ListEscalationTasksOpts,
    'statusFilter' | 'assignedToUserIdFilter' | 'overdueOnly'
  >,
): ReturnType<typeof and> | undefined {
  const conditions: Array<ReturnType<typeof eq>> = [];
  if (opts.statusFilter && opts.statusFilter.length > 0) {
    conditions.push(
      sql`${renewalEscalationTasks.status} IN ${opts.statusFilter}` as unknown as ReturnType<
        typeof eq
      >,
    );
  }
  if (opts.assignedToUserIdFilter !== undefined) {
    if (opts.assignedToUserIdFilter === ESCALATION_UNASSIGNED_FILTER) {
      // Phase 8 T214 — `'__unassigned__'` sentinel matches NULL
      // (tasks assigned by role only). Maps to the per-user partial
      // index's complement.
      conditions.push(
        isNull(renewalEscalationTasks.assignedToUserId) as unknown as ReturnType<
          typeof eq
        >,
      );
    } else {
      conditions.push(
        eq(
          renewalEscalationTasks.assignedToUserId,
          opts.assignedToUserIdFilter,
        ),
      );
    }
  }
  if (opts.overdueOnly === true) {
    conditions.push(
      sql`${renewalEscalationTasks.dueAt} < NOW()` as unknown as ReturnType<
        typeof eq
      >,
    );
  }
  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions);
}
