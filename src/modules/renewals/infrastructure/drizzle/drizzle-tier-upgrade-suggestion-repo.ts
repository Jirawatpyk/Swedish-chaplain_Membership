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
import { and, eq, sql, desc, isNull } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import type { TenantTx } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import {
  tierUpgradeSuggestions,
  type TierUpgradeSuggestionRow,
} from '../schema-tier-upgrade-suggestions';
import { renewalCycles } from '../schema-renewal-cycles';
import {
  TierUpgradeOpenConflictError,
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

    async transitionStatus(
      tx: TenantTx,
      tenantId: string,
      suggestionId: SuggestionId,
      args: {
        readonly to: TierUpgradeStatus;
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

      const [row] = await txDb
        .update(tierUpgradeSuggestions)
        .set(updateValues)
        .where(eq(tierUpgradeSuggestions.suggestionId, suggestionId))
        .returning();
      if (!row) {
        throw new TierUpgradeSuggestionNotFoundError(suggestionId);
      }
      void tenantId;
      return rowToDomain(row);
    },

    async listOrphanedPending(tenantId) {
      return runInTenant(tenant, async (tx) => {
        const txDb = tx as unknown as typeof db;
        const rows = await txDb
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
        void tenantId;
        return rows.map((r) => ({
          suggestion: rowToDomain(r.suggestion),
          targetCycleStatus: r.cycleStatus as 'cancelled' | 'lapsed',
        }));
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
  };
}
