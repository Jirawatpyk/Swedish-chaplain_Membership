/**
 * Display-data fetchers for `/admin/renewals/[cycleId]` server
 * component. Extracted from the page module (Phase 6 review-round 2
 * A2) so they're testable in isolation — the page-internal versions
 * were unreachable from a test runner.
 *
 * Both fetchers compose existing barrel exports (`@/modules/members`
 * `f3DrizzleMemberRepo` + `getMemberPrimaryContact`, `@/modules/plans`
 * `membershipPlans` schema) — same surface as the production
 * `loadPlanFrozenFields` + member lookup paths.
 *
 * Error semantics (from the C4 fix):
 *   - `null` → row legitimately missing (member archived, plan deleted)
 *     OR JSONB parse failed; caller renders fallback "—".
 *   - throws → infrastructure error (RLS reject / connection / timeout);
 *     caller's `Promise.allSettled` rejected branch logs at warn level.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { runInTenant, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { asTenantContext } from '@/modules/tenants';
import {
  asMemberId,
  f3DrizzleMemberRepo,
  getMemberPrimaryContact,
  type Member,
} from '@/modules/members';
import { membershipPlans, type LocaleText } from '@/modules/plans';

// Phase 6 review-round 2 TD1 — zod parser for the F2 plan_name JSONB
// column. `LocaleText` shape is `{ en: string; th?: string; sv?: string }`
// (`@/modules/plans`). Without runtime validation a malformed row
// would crash on `.en` access deep inside fetchPlanDisplay.
export const planNameSchema = z
  .object({
    en: z.string().min(1),
    th: z.string().optional(),
    sv: z.string().optional(),
  })
  .passthrough();

export interface MemberDisplay {
  readonly companyName: string;
  readonly primaryContact: string | null;
}

export interface PlanDisplay {
  readonly localisedName: string;
}

/**
 * Test-overridable repo handles. Production callers pass nothing and
 * the defaults bind to the live `f3DrizzleMemberRepo` + barrel
 * `getMemberPrimaryContact`. Unit tests override both to drive the
 * branches without booting Drizzle.
 */
export interface FetchMemberDeps {
  readonly memberRepo: typeof f3DrizzleMemberRepo;
  readonly getPrimaryContact: typeof getMemberPrimaryContact;
}

const defaultFetchMemberDeps: FetchMemberDeps = {
  memberRepo: f3DrizzleMemberRepo,
  getPrimaryContact: getMemberPrimaryContact,
};

/**
 * F3 member + primary-contact lookup for display. Returns `null`
 * when the member doesn't exist or is archived; throws on
 * infrastructure errors so the caller's Promise.allSettled rejected
 * branch logs at warn level.
 */
export async function fetchMemberDisplay(
  args: {
    readonly tenantSlug: string;
    readonly memberId: string;
    readonly actorUserId: string;
    readonly requestId: string;
  },
  deps: FetchMemberDeps = defaultFetchMemberDeps,
): Promise<MemberDisplay | null> {
  const tenantContext = asTenantContext(args.tenantSlug);
  const memberResult = await deps.memberRepo.findById(
    tenantContext,
    asMemberId(args.memberId),
  );
  if (!memberResult.ok) return null;
  const member: Member = memberResult.value;
  const primaryContactResult = await deps.getPrimaryContact(
    { tenant: tenantContext, memberRepo: deps.memberRepo },
    asMemberId(args.memberId),
  );
  return {
    companyName: member.companyName,
    primaryContact: primaryContactResult.ok ? primaryContactResult.value : null,
  };
}

/**
 * Test-overridable runner so unit tests can drive the SQL path with
 * stubbed rows. Production callers pass nothing.
 */
export type PlanDisplayRunner = (args: {
  readonly tenantSlug: string;
  readonly planId: string;
}) => Promise<ReadonlyArray<{ planName: unknown }>>;

const defaultPlanDisplayRunner: PlanDisplayRunner = async ({
  tenantSlug,
  planId,
}) => {
  const tenantContext = asTenantContext(tenantSlug);
  return runInTenant(tenantContext, async (tx: TenantTx) =>
    tx
      .select({ planName: membershipPlans.planName })
      .from(membershipPlans)
      .where(
        and(
          eq(membershipPlans.planId, planId),
          isNull(membershipPlans.deletedAt),
        ),
      )
      .orderBy(desc(membershipPlans.planYear))
      .limit(1),
  );
};

/**
 * F2 plan-name lookup using the SAME query shape as production
 * `loadPlanFrozenFields`. Returns the locale-appropriate `plan_name`
 * (LocaleText JSONB) with EN canonical fallback (F2 spec Q3 — EN
 * required, TH/SV optional).
 */
export async function fetchPlanDisplay(
  args: {
    readonly tenantSlug: string;
    readonly planId: string;
    readonly locale: string;
  },
  runner: PlanDisplayRunner = defaultPlanDisplayRunner,
): Promise<PlanDisplay | null> {
  const rows = await runner({
    tenantSlug: args.tenantSlug,
    planId: args.planId,
  });
  const row = rows[0];
  if (!row) return null;
  const parsed = planNameSchema.safeParse(row.planName);
  if (!parsed.success) {
    logger.warn(
      { planId: args.planId, raw: row.planName },
      '[admin/renewals/cycle-detail] plan_name JSONB failed schema parse',
    );
    return null;
  }
  const localisedName =
    (args.locale === 'th' && parsed.data.th) ||
    (args.locale === 'sv' && parsed.data.sv) ||
    parsed.data.en;
  return { localisedName };
}

// Re-export for convenience on the page side (avoids needing to import
// `LocaleText` separately).
export type { LocaleText };
