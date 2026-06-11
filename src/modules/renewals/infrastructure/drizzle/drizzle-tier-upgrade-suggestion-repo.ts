/**
 * F8 Phase 7 T186 — Drizzle adapter for `TierUpgradeSuggestionRepo`.
 *
 * Implements the F8 port `TierUpgradeSuggestionRepo` (Wave E T043)
 * against the `tier_upgrade_suggestions` table (Wave C migration
 * 0091). Tenant isolation is enforced by Postgres RLS+FORCE — every
 * method wraps its query in `runInTenant(ctx, …)` which sets
 * `SET LOCAL ROLE chamber_app` + `SET LOCAL app.current_tenant`.
 * NO explicit `WHERE tenant_id = ?` — the policy adds it automatically.
 *
 * Pure Infrastructure — only `@/lib/db` + tenants barrel imports
 * (Constitution Principle III).
 */
import { and, eq, sql, desc, isNull, inArray } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import type { TenantTx } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import {
  tierUpgradeSuggestions,
  type TierUpgradeSuggestionRow,
} from '../schema-tier-upgrade-suggestions';
import { renewalCycles } from '../schema-renewal-cycles';
// Round 6 W-002 — JOIN to members.plan_id for manual-plan-change
// orphan detection in `listOrphanedPending`.
import { members } from '@/modules/members/infrastructure/db/schema-members';
import {
  TierUpgradeOpenConflictError,
  TierUpgradeStatusConflictError,
  TierUpgradeSuggestionNotFoundError,
  type NewTierUpgradeSuggestionInput,
  type TierUpgradeSuggestionRepo,
} from '../../application/ports/tier-upgrade-suggestion-repo';
import {
  asSuggestionId,
  type SuggestionId,
  type TierUpgradeSuggestion,
  type TierUpgradeStatus,
  type TierUpgradeReasonCode,
  type TierUpgradeEvidence,
} from '../../domain/tier-upgrade-suggestion';

// ---------------------------------------------------------------------------
// Row → Domain translation
// ---------------------------------------------------------------------------

function rowToDomain(row: TierUpgradeSuggestionRow): TierUpgradeSuggestion {
  const reasonCode = row.reasonCode as TierUpgradeReasonCode;
  const evidence = row.evidenceJsonb as unknown as TierUpgradeEvidence;
  const base = {
    tenantId: row.tenantId,
    suggestionId: asSuggestionId(row.suggestionId),
    memberId: row.memberId,
    fromPlanId: row.fromPlanId,
    toPlanId: row.toPlanId,
    reasonCode,
    evidence,
    suppressedUntil: row.suppressedUntil?.toISOString() ?? null,
    memberNotifiedAt: row.memberNotifiedAt?.toISOString() ?? null,
    adminVerificationTaskId: row.adminVerificationTaskId,
    createdAt: row.createdAt.toISOString(),
  };
  // Discriminated-union narrowing — relies on DB CHECK constraints to
  // guarantee anchor invariants (`tier_upgrade_suggestions_accepted_check`,
  // `_applied_check`, `_dismissed_check`, `_terminal_closed_at_check`).
  switch (row.status) {
    case 'open':
      return {
        ...base,
        status: 'open',
        acceptedAt: null,
        acceptedByUserId: null,
        targetApplyAtCycleId: null,
        appliedAt: null,
        appliedAtInvoiceId: null,
        dismissedReason: null,
        closedAt: null,
      } as TierUpgradeSuggestion;
    case 'accepted_pending_apply':
      assertNonNull(row.acceptedAt, 'accepted_pending_apply.acceptedAt');
      assertNonNull(
        row.acceptedByUserId,
        'accepted_pending_apply.acceptedByUserId',
      );
      assertNonNull(
        row.targetApplyAtCycleId,
        'accepted_pending_apply.targetApplyAtCycleId',
      );
      return {
        ...base,
        status: 'accepted_pending_apply',
        acceptedAt: row.acceptedAt.toISOString(),
        acceptedByUserId: row.acceptedByUserId,
        targetApplyAtCycleId: row.targetApplyAtCycleId,
        appliedAt: null,
        appliedAtInvoiceId: null,
        dismissedReason: null,
        closedAt: null,
      } as TierUpgradeSuggestion;
    case 'applied':
      assertNonNull(row.acceptedAt, 'applied.acceptedAt');
      assertNonNull(row.acceptedByUserId, 'applied.acceptedByUserId');
      assertNonNull(
        row.targetApplyAtCycleId,
        'applied.targetApplyAtCycleId',
      );
      assertNonNull(row.appliedAt, 'applied.appliedAt');
      assertNonNull(row.appliedAtInvoiceId, 'applied.appliedAtInvoiceId');
      assertNonNull(row.closedAt, 'applied.closedAt');
      return {
        ...base,
        status: 'applied',
        acceptedAt: row.acceptedAt.toISOString(),
        acceptedByUserId: row.acceptedByUserId,
        targetApplyAtCycleId: row.targetApplyAtCycleId,
        appliedAt: row.appliedAt.toISOString(),
        appliedAtInvoiceId: row.appliedAtInvoiceId,
        dismissedReason: null,
        closedAt: row.closedAt.toISOString(),
      } as TierUpgradeSuggestion;
    case 'dismissed':
      assertNonNull(row.closedAt, 'dismissed.closedAt');
      return {
        ...base,
        status: 'dismissed',
        acceptedAt: null,
        acceptedByUserId: null,
        targetApplyAtCycleId: null,
        appliedAt: null,
        appliedAtInvoiceId: null,
        dismissedReason: row.dismissedReason ?? '',
        closedAt: row.closedAt.toISOString(),
      } as TierUpgradeSuggestion;
    case 'superseded':
      assertNonNull(row.closedAt, 'superseded.closedAt');
      // Discriminate which `superseded` arm based on whether the
      // suggestion had been accepted before the manual override.
      if (row.acceptedAt && row.acceptedByUserId && row.targetApplyAtCycleId) {
        return {
          ...base,
          status: 'superseded',
          supersededFrom: 'accepted_pending_apply',
          acceptedAt: row.acceptedAt.toISOString(),
          acceptedByUserId: row.acceptedByUserId,
          targetApplyAtCycleId: row.targetApplyAtCycleId,
          appliedAt: null,
          appliedAtInvoiceId: null,
          dismissedReason: null,
          closedAt: row.closedAt.toISOString(),
        } as TierUpgradeSuggestion;
      }
      return {
        ...base,
        status: 'superseded',
        supersededFrom: 'open',
        acceptedAt: null,
        acceptedByUserId: null,
        targetApplyAtCycleId: null,
        appliedAt: null,
        appliedAtInvoiceId: null,
        dismissedReason: null,
        closedAt: row.closedAt.toISOString(),
      } as TierUpgradeSuggestion;
    case 'auto_resolved':
      assertNonNull(row.closedAt, 'auto_resolved.closedAt');
      return {
        ...base,
        status: 'auto_resolved',
        acceptedAt: null,
        acceptedByUserId: null,
        targetApplyAtCycleId: null,
        appliedAt: null,
        appliedAtInvoiceId: null,
        dismissedReason: null,
        closedAt: row.closedAt.toISOString(),
      } as TierUpgradeSuggestion;
    default:
      throw new Error(
        `F8 invariant violation: unknown tier_upgrade_suggestion status '${row.status}'`,
      );
  }
}

function assertNonNull<T>(
  value: T | null | undefined,
  label: string,
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(
      `F8 invariant violation: tier_upgrade_suggestion ${label} unexpectedly null — DB CHECK regression`,
    );
  }
}

// ---------------------------------------------------------------------------
// Per-tenant factory
// ---------------------------------------------------------------------------

export function makeDrizzleTierUpgradeSuggestionRepo(
  tenant: TenantContext,
): TierUpgradeSuggestionRepo {
  return {
    async insertOpen(
      tx: TenantTx,
      input: NewTierUpgradeSuggestionInput,
    ): Promise<TierUpgradeSuggestion> {
      const txDb = tx as unknown as typeof db;
      try {
        const [row] = await txDb
          .insert(tierUpgradeSuggestions)
          .values({
            tenantId: input.tenantId,
            suggestionId: input.suggestionId,
            memberId: input.memberId,
            fromPlanId: input.fromPlanId,
            toPlanId: input.toPlanId,
            reasonCode: input.reasonCode,
            evidenceJsonb: input.evidence as unknown as Record<
              string,
              unknown
            >,
            status: 'open',
          })
          .returning();
        if (!row) {
          throw new Error(
            'tier_upgrade_suggestions.insertOpen: INSERT returned no row',
          );
        }
        return rowToDomain(row);
      } catch (e) {
        // Drizzle wraps PostgresError under e.cause; check both layers.
        const outerMessage = (e as Error)?.message ?? '';
        const cause = (e as { cause?: unknown }).cause;
        const causeMessage =
          cause instanceof Error ? cause.message : String(cause ?? '');
        if (
          outerMessage.includes('tier_upgrade_suggestions_member_open_uniq') ||
          causeMessage.includes('tier_upgrade_suggestions_member_open_uniq')
        ) {
          throw new TierUpgradeOpenConflictError(input.memberId);
        }
        throw e;
      }
    },

    async findById(
      tenantId: string,
      suggestionId: SuggestionId,
    ): Promise<TierUpgradeSuggestion | null> {
      return runInTenant(tenant, async (tx) => {
        const txDb = tx as unknown as typeof db;
        const [row] = await txDb
          .select()
          .from(tierUpgradeSuggestions)
          .where(eq(tierUpgradeSuggestions.suggestionId, suggestionId))
          .limit(1);
        if (!row) return null;
        // Defence-in-depth — RLS already filters cross-tenant rows but
        // assert tenantId match anyway.
        if (row.tenantId !== tenantId) return null;
        return rowToDomain(row);
      });
    },

    async findActiveForMember(
      tenantId: string,
      memberId: string,
    ): Promise<TierUpgradeSuggestion | null> {
      return runInTenant(tenant, async (tx) => {
        const txDb = tx as unknown as typeof db;
        const [row] = await txDb
          .select()
          .from(tierUpgradeSuggestions)
          .where(
            and(
              eq(tierUpgradeSuggestions.memberId, memberId),
              sql`${tierUpgradeSuggestions.status} IN ('open','accepted_pending_apply')`,
            ),
          )
          .limit(1);
        if (!row) return null;
        if (row.tenantId !== tenantId) return null;
        return rowToDomain(row);
      });
    },

    async isSuppressedForMember(
      tenantId: string,
      memberId: string,
      nowIso: string,
    ): Promise<boolean> {
      return runInTenant(tenant, async (tx) => {
        const txDb = tx as unknown as typeof db;
        const [row] = await txDb
          .select({ id: tierUpgradeSuggestions.suggestionId })
          .from(tierUpgradeSuggestions)
          .where(
            and(
              eq(tierUpgradeSuggestions.memberId, memberId),
              eq(tierUpgradeSuggestions.status, 'dismissed'),
              sql`${tierUpgradeSuggestions.suppressedUntil} > ${nowIso}::timestamptz`,
            ),
          )
          .limit(1);
        // Surface tenantId for type-narrowing — defence-in-depth.
        void tenantId;
        return Boolean(row);
      });
    },

    async findPendingForCycle(
      tenantId: string,
      cycleId: string,
    ): Promise<ReadonlyArray<TierUpgradeSuggestion>> {
      return runInTenant(tenant, async (tx) => {
        const txDb = tx as unknown as typeof db;
        const rows = await txDb
          .select()
          .from(tierUpgradeSuggestions)
          .where(
            and(
              eq(tierUpgradeSuggestions.targetApplyAtCycleId, cycleId),
              eq(tierUpgradeSuggestions.status, 'accepted_pending_apply'),
            ),
          );
        void tenantId;
        return rows.map(rowToDomain);
      });
    },

    async hasSupersededSuggestionForCycle(
      tenantId: string,
      cycleId: string,
    ): Promise<boolean> {
      // 065 Fix A (S1 retry-heal) — existence probe for a `superseded`
      // suggestion targeting this cycle. Only the
      // `superseded_from_accepted` arm retains `target_apply_at_cycle_id`
      // (set at accept-time, preserved by the manual-override supersede),
      // so this match precisely identifies the cancelled-upgrade orphan
      // the F2 finaliser must NOT re-bill. Explicit `eq(tenant_id, …)`
      // belt-and-suspenders over RLS (S9 house style on this aggregate).
      return runInTenant(tenant, async (tx) => {
        const txDb = tx as unknown as typeof db;
        const [row] = await txDb
          .select({ id: tierUpgradeSuggestions.suggestionId })
          .from(tierUpgradeSuggestions)
          .where(
            and(
              eq(tierUpgradeSuggestions.tenantId, tenantId),
              eq(tierUpgradeSuggestions.targetApplyAtCycleId, cycleId),
              eq(tierUpgradeSuggestions.status, 'superseded'),
            ),
          )
          .limit(1);
        return Boolean(row);
      });
    },

    async transitionStatus(
      tx: TenantTx,
      tenantId: string,
      suggestionId: SuggestionId,
      args: {
        readonly to: TierUpgradeStatus;
        readonly expectedFrom?: TierUpgradeStatus;
        readonly expectedFromIn?: readonly TierUpgradeStatus[];
        readonly acceptedAt?: string;
        readonly acceptedByUserId?: string;
        readonly targetApplyAtCycleId?: string;
        readonly appliedAt?: string;
        readonly appliedAtInvoiceId?: string;
        readonly memberNotifiedAt?: string;
        readonly adminVerificationTaskId?: string;
        readonly suppressedUntil?: string;
        readonly dismissedReason?: string;
        readonly closedAt?: string;
      },
    ): Promise<TierUpgradeSuggestion> {
      const txDb = tx as unknown as typeof db;
      const updateValues: Record<string, unknown> = { status: args.to };
      if (args.acceptedAt !== undefined)
        updateValues.acceptedAt = new Date(args.acceptedAt);
      if (args.acceptedByUserId !== undefined)
        updateValues.acceptedByUserId = args.acceptedByUserId;
      if (args.targetApplyAtCycleId !== undefined)
        updateValues.targetApplyAtCycleId = args.targetApplyAtCycleId;
      if (args.appliedAt !== undefined)
        updateValues.appliedAt = new Date(args.appliedAt);
      if (args.appliedAtInvoiceId !== undefined)
        updateValues.appliedAtInvoiceId = args.appliedAtInvoiceId;
      if (args.memberNotifiedAt !== undefined)
        updateValues.memberNotifiedAt = new Date(args.memberNotifiedAt);
      if (args.adminVerificationTaskId !== undefined)
        updateValues.adminVerificationTaskId = args.adminVerificationTaskId;
      if (args.suppressedUntil !== undefined)
        updateValues.suppressedUntil = new Date(args.suppressedUntil);
      if (args.dismissedReason !== undefined)
        updateValues.dismissedReason = args.dismissedReason;
      if (args.closedAt !== undefined)
        updateValues.closedAt = new Date(args.closedAt);

      // 065 Fix 1 (W-011 double-accept TOCTOU) + 065 S7 (supersede
      // set-membership CAS) — compare-and-swap: the UPDATE matches only
      // while the row is still in the expected FROM state. A concurrent
      // transition that committed after the caller's read makes this
      // match 0 rows instead of silently re-applying the transition over
      // the winner's write. The FROM predicate is either a value-pin
      // (`status = expectedFrom`) or a set-membership guard
      // (`status IN (...expectedFromIn)`) — see the port contract for
      // which callers use which (exactly one MUST be supplied).
      if (
        (args.expectedFrom === undefined) ===
        (args.expectedFromIn === undefined)
      ) {
        throw new Error(
          'transitionStatus: supply EXACTLY ONE of expectedFrom / expectedFromIn',
        );
      }
      const fromPredicate =
        args.expectedFromIn !== undefined
          ? inArray(tierUpgradeSuggestions.status, [...args.expectedFromIn])
          : eq(tierUpgradeSuggestions.status, args.expectedFrom!);
      // Human-readable FROM descriptor for the conflict-error message.
      const expectedFromLabel =
        args.expectedFromIn !== undefined
          ? args.expectedFromIn.join('|')
          : args.expectedFrom!;
      // 065 S9 — explicit `tenant_id` scoping on BOTH the CAS UPDATE and
      // the disambiguation SELECT below. RLS already filters cross-tenant
      // rows (every method runs under `SET LOCAL app.current_tenant`),
      // but the house style on this aggregate (`findById` /
      // `findActiveForMember`) is belt-and-suspenders: an explicit
      // `eq(tenantId, …)` predicate so a future RLS-policy regression or
      // a BYPASSRLS connection can't silently CAS a foreign-tenant row.
      const [row] = await txDb
        .update(tierUpgradeSuggestions)
        .set(updateValues)
        .where(
          and(
            eq(tierUpgradeSuggestions.suggestionId, suggestionId),
            eq(tierUpgradeSuggestions.tenantId, tenantId),
            fromPredicate,
          ),
        )
        .returning();
      if (!row) {
        // 0 rows — distinguish "row missing" from "CAS lost" with a
        // follow-up read in the same tx (failure path only; the
        // success path stays single-RTT). A 0-row UPDATE is NOT a SQL
        // error, so the surrounding tx is not poisoned by this probe.
        // 065 S9 — scope the probe to the tenant too: a foreign-tenant
        // row (RLS bypassed) is treated as not-found, mirroring the
        // `findById` `row.tenantId !== tenantId → null` guard.
        const [existing] = await txDb
          .select({
            status: tierUpgradeSuggestions.status,
            tenantId: tierUpgradeSuggestions.tenantId,
          })
          .from(tierUpgradeSuggestions)
          .where(
            and(
              eq(tierUpgradeSuggestions.suggestionId, suggestionId),
              eq(tierUpgradeSuggestions.tenantId, tenantId),
            ),
          );
        if (!existing) {
          throw new TierUpgradeSuggestionNotFoundError(suggestionId);
        }
        throw new TierUpgradeStatusConflictError(
          suggestionId,
          expectedFromLabel,
          existing.status,
        );
      }
      return rowToDomain(row);
    },

    async listOrphanedPending(tenantId) {
      return runInTenant(tenant, async (tx) => {
        const txDb = tx as unknown as typeof db;
        // Round 6 W-002 — UNION two orphan detection paths:
        //   (a) terminal-cycle orphans (cancelled/lapsed) — original
        //   (b) manual-plan-change orphans — members.plan_id no longer
        //       matches EITHER suggestion.from_plan_id OR to_plan_id.
        //       Catches the case where the F2 supersede listener
        //       failed silently after admin manually changed the plan.
        const terminalRows = await txDb
          .select({
            suggestion: tierUpgradeSuggestions,
            cycleStatus: renewalCycles.status,
          })
          .from(tierUpgradeSuggestions)
          .innerJoin(
            renewalCycles,
            and(
              eq(
                tierUpgradeSuggestions.targetApplyAtCycleId,
                renewalCycles.cycleId,
              ),
              eq(tierUpgradeSuggestions.tenantId, renewalCycles.tenantId),
            ),
          )
          .where(
            and(
              eq(
                tierUpgradeSuggestions.status,
                'accepted_pending_apply',
              ),
              sql`${renewalCycles.status} IN ('cancelled','lapsed')`,
            ),
          );

        const planDivergedRows = await txDb
          .select({ suggestion: tierUpgradeSuggestions })
          .from(tierUpgradeSuggestions)
          .innerJoin(
            members,
            and(
              eq(tierUpgradeSuggestions.memberId, members.memberId),
              eq(tierUpgradeSuggestions.tenantId, members.tenantId),
            ),
          )
          .where(
            and(
              eq(
                tierUpgradeSuggestions.status,
                'accepted_pending_apply',
              ),
              // members.plan_id has diverged from BOTH from_plan_id and
              // to_plan_id — so neither the original snapshot NOR the
              // pending upgrade target reflects the member's actual plan.
              sql`${members.planId} IS DISTINCT FROM ${tierUpgradeSuggestions.fromPlanId}`,
              sql`${members.planId} IS DISTINCT FROM ${tierUpgradeSuggestions.toPlanId}`,
            ),
          );

        // De-dupe by suggestionId — a suggestion that's BOTH terminal-
        // cycle AND plan-diverged shows up in terminalRows; we keep the
        // terminal discriminator since that's the upstream cause.
        const seen = new Set<string>();
        const out: Array<{
          suggestion: TierUpgradeSuggestion;
          targetCycleStatus: 'cancelled' | 'lapsed' | 'manual_plan_change';
        }> = [];
        for (const r of terminalRows) {
          if (seen.has(r.suggestion.suggestionId)) continue;
          seen.add(r.suggestion.suggestionId);
          out.push({
            suggestion: rowToDomain(r.suggestion),
            targetCycleStatus: r.cycleStatus as 'cancelled' | 'lapsed',
          });
        }
        for (const r of planDivergedRows) {
          if (seen.has(r.suggestion.suggestionId)) continue;
          seen.add(r.suggestion.suggestionId);
          out.push({
            suggestion: rowToDomain(r.suggestion),
            targetCycleStatus: 'manual_plan_change' as const,
          });
        }
        void tenantId;
        return out;
      });
    },

    async listForAdminQueue(tenantId, args) {
      return runInTenant(tenant, async (tx) => {
        const txDb = tx as unknown as typeof db;
        const limit = Math.min(Math.max(args?.limit ?? 50, 1), 200);
        const rows = await txDb
          .select()
          .from(tierUpgradeSuggestions)
          .where(
            sql`${tierUpgradeSuggestions.status} IN ('open','accepted_pending_apply')`,
          )
          .orderBy(
            desc(tierUpgradeSuggestions.createdAt),
            desc(tierUpgradeSuggestions.suggestionId),
          )
          .limit(limit + 1);
        void tenantId;
        const items = rows.slice(0, limit).map(rowToDomain);
        const nextCursor =
          rows.length > limit ? rows[limit]!.suggestionId : null;
        // Reference unused param to keep symmetry — cursor pagination
        // is a Phase 7 polish item; for MVP queue size <50 the
        // first-page response is sufficient.
        void args;
        void isNull;
        return { items, nextCursor };
      });
    },

    async bulkGetSuppressedMembers(tx, memberIds, nowIso) {
      // F8 Phase 10 T262 batched-write — single-RTT alternative to
      // N-call isSuppressedForMember. Uses the partial suppressed_idx
      // (migration 0091) for an index-only scan.
      if (memberIds.length === 0) {
        return new Set<string>();
      }
      const txDb = tx as unknown as typeof db;
      const rows = await txDb
        .select({ memberId: tierUpgradeSuggestions.memberId })
        .from(tierUpgradeSuggestions)
        .where(
          and(
            inArray(tierUpgradeSuggestions.memberId, [...memberIds]),
            eq(tierUpgradeSuggestions.status, 'dismissed'),
            sql`${tierUpgradeSuggestions.suppressedUntil} > ${nowIso}::timestamptz`,
          ),
        );
      return new Set(rows.map((r) => r.memberId));
    },

    async bulkInsertOpenIfAbsent(tx, inputs) {
      // F8 Phase 10 T262 batched-write — single multi-row INSERT
      // ON CONFLICT DO NOTHING leveraging the
      // tier_upgrade_suggestions_member_open_uniq partial UNIQUE index
      // (migration 0091) so members with an existing open/pending row
      // are silently skipped.
      if (inputs.length === 0) {
        return { inserted: [], conflicted: [] };
      }
      // R6-H2-err: tenantId guard symmetric with sister
      // RenewalReminderEventRepo.bulkInsertIfAbsent (R5-C2). Without
      // this, a future caller passing mixed-tenant inputs would let
      // them all collapse onto whichever tenant the input.tenantId
      // claimed — undetectable cross-tenant write because RLS scopes
      // by `app.current_tenant` (set via runInTenant) which is the
      // ADAPTER-bound tenant, NOT the input.tenantId. Constitution
      // Principle I clause 1 (application-layer tenant scoping) is
      // the binding rule here.
      for (const input of inputs) {
        if (input.tenantId !== tenant.slug) {
          throw new Error(
            `bulkInsertOpenIfAbsent: input.tenantId='${input.tenantId}' ≠ adapter tenant.slug='${tenant.slug}' — cross-tenant write blocked (Constitution Principle I)`,
          );
        }
      }
      const txDb = tx as unknown as typeof db;
      const insertValues = inputs.map((input) => ({
        tenantId: input.tenantId,
        suggestionId: input.suggestionId,
        memberId: input.memberId,
        fromPlanId: input.fromPlanId,
        toPlanId: input.toPlanId,
        reasonCode: input.reasonCode,
        evidenceJsonb: input.evidence as unknown as Record<string, unknown>,
        status: 'open' as const,
      }));
      const insertedRows = await txDb
        .insert(tierUpgradeSuggestions)
        .values(insertValues)
        .onConflictDoNothing({
          // R5-C1 fix: explicit conflict target so a PK collision (or
          // any other future unique constraint) is NOT silently
          // swallowed as "member already open". The only conflict path
          // we want to absorb is the partial unique index
          // `tier_upgrade_suggestions_member_open_uniq` covering
          // `(tenant_id, member_id) WHERE status IN ('open',
          // 'accepted_pending_apply')`. Naming it explicitly closes
          // the bug-class where a future migration adds another
          // unique constraint and silently turns its violations into
          // "conflicted" no-ops.
          target: [
            tierUpgradeSuggestions.tenantId,
            tierUpgradeSuggestions.memberId,
          ],
          where: sql`tier_upgrade_suggestions.status IN ('open','accepted_pending_apply')`,
        })
        .returning();
      const inserted = insertedRows.map(rowToDomain);
      const insertedMemberIds = new Set(inserted.map((s) => s.memberId));
      // R5-MED1 fix: return full input shape for conflicted rows
      // (symmetric with bulkInsertIfAbsent on RenewalReminderEventRepo).
      // Pre-fix returned just memberId strings.
      const conflicted = inputs.filter(
        (i) => !insertedMemberIds.has(i.memberId),
      );
      return { inserted, conflicted };
    },
  };
}
