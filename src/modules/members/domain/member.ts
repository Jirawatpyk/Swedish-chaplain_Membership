/**
 * Member — aggregate root.
 *
 * A company (legal entity) enrolled on one membership plan for one year.
 * Contacts live as a child entity (`contact.ts`) with no independent
 * lifecycle — co-located in the same bounded context.
 *
 * State machine (data-model.md § 1.1):
 *   active  ──(admin)──> inactive
 *   active  ──(admin archive)──> archived (archived_at = NOW)
 *   inactive ─(admin)──> active
 *   archived ─(admin undelete, < 90d)──> active (archived_at = NULL)
 *
 * Pure TypeScript — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';
import { unsafeBrandTenantSlug, type TenantSlug } from '@/modules/tenants';
import type { IsoCountryCode } from './value-objects/iso-country-code';
import type { MemberNumber } from './value-objects/member-number';
import type { TaxId } from './value-objects/tax-id';
import { isUuid } from './value-objects/uuid';

export const MEMBER_STATUSES = ['active', 'inactive', 'archived'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

declare const MemberIdBrand: unique symbol;
export type MemberId = string & { readonly [MemberIdBrand]: true };

/**
 * `TenantId` is the persisted-tenant-identifier brand shared across F3
 * (members), F6 (events), and F8 (renewals). It is UNIFIED with the canonical
 * `TenantSlug` from `@/modules/tenants` — i.e. they are the same type. The
 * alias is retained because many call sites refer to the persisted tenant id
 * by this name; new code may use either name interchangeably. Unifying the
 * brand eliminates the previous `asTenantId(tenant.slug)` re-brand laundering
 * at every F3 write site (`tenant.slug` is already a `TenantSlug`).
 */
export type TenantId = TenantSlug;

declare const PlanIdBrand: unique symbol;
export type PlanId = string & { readonly [PlanIdBrand]: true };

/**
 * Brand a raw string as a TenantId (= TenantSlug). Used at trust boundaries
 * (adapters, route handlers, tests, webhook params) where the value has been
 * validated externally. For untrusted boundaries prefer `tryTenantId` which
 * runs a non-empty check and returns a Result. A value that is ALREADY a
 * `TenantSlug` (e.g. `tenant.slug`) needs no conversion — assign it directly.
 */
export function asTenantId(raw: string): TenantId {
  return unsafeBrandTenantSlug(raw);
}

/** Validated TenantId brander for untrusted input. Rejects empty / whitespace. */
export function tryTenantId(raw: unknown): Result<TenantId, { code: 'invalid_tenant_id' }> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return err({ code: 'invalid_tenant_id' });
  }
  return ok(unsafeBrandTenantSlug(raw));
}

/**
 * Brand a raw string as a PlanId. Used at trust boundaries (adapters,
 * route handlers, tests) where the value has been validated externally
 * — e.g. confirmed to exist in the plans catalogue via getPlan. Prefer
 * `tryPlanId` for untrusted input.
 */
export function asPlanId(raw: string): PlanId {
  return raw as PlanId;
}

/** Validated PlanId brander. Rejects empty / whitespace. */
export function tryPlanId(raw: unknown): Result<PlanId, { code: 'invalid_plan_id' }> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return err({ code: 'invalid_plan_id' });
  }
  return ok(raw as PlanId);
}

/**
 * Brand a raw string as a MemberId. Used at trust boundaries. Prefer
 * `tryMemberId` for untrusted input — MemberIds are UUIDs so a format
 * check is cheap and catches URL-tampering attempts early.
 */
export function asMemberId(raw: string): MemberId {
  return raw as MemberId;
}

/** Validated MemberId brander — UUID format check. */
export function tryMemberId(raw: unknown): Result<MemberId, { code: 'invalid_member_id' }> {
  if (!isUuid(raw)) {
    return err({ code: 'invalid_member_id' });
  }
  return ok(raw.toLowerCase() as MemberId);
}

/**
 * Lifecycle sub-shape (M5 review hardening) — encodes the `status` ⟺
 * `archivedAt` coupling so an illegal `{status:'archived', archivedAt:null}`
 * or `{status:'active', archivedAt:<date>}` is unrepresentable in any FULL
 * `Member` value (the read/consumer surface). Mirrors the DB CHECK
 * `members_archived_at_iff_archived` (migration 0009): archived rows always
 * carry an `archivedAt`; non-archived rows never do.
 *
 * NOTE: `Omit<Member, K>` collapses this discriminated union (TS keyof over a
 * union keeps only common keys), so create-DRAFT types derived via `Omit`
 * (e.g. `Omit<Member,'createdAt'|'updatedAt'>`) do NOT enforce the correlation.
 * The runtime `memberLifecycle()` helper + the DB CHECK are the backstops at
 * the construct surface.
 */
export type MemberLifecycle =
  | { readonly status: 'archived'; readonly archivedAt: Date }
  | { readonly status: 'active' | 'inactive'; readonly archivedAt: null };

/**
 * Build the correlated lifecycle sub-shape from a raw status + archivedAt
 * (e.g. a DB row). The throw is a defensive assertion of the DB CHECK
 * invariant and is unreachable for well-formed rows.
 */
export function memberLifecycle(
  status: MemberStatus,
  archivedAt: Date | null,
): MemberLifecycle {
  if (status === 'archived') {
    if (archivedAt === null) {
      throw new Error(
        'member invariant violated: archived status requires archivedAt ' +
          '(DB CHECK members_archived_at_iff_archived)',
      );
    }
    return { status, archivedAt };
  }
  return { status, archivedAt: null };
}

/**
 * Immutable Member aggregate. Mutations return a new Member instance via
 * the state-transition functions below — the Application layer persists
 * via the repo port.
 */
export type Member = {
  readonly tenantId: TenantId;
  readonly memberId: MemberId;
  readonly memberNumber: MemberNumber;
  readonly companyName: string;
  readonly legalEntityType: string | null;
  readonly country: IsoCountryCode;
  readonly taxId: TaxId | null;
  /**
   * 088-invoice-tax-flow-redesign (US3 / FR-008) — §86/4 Head-Office / Branch
   * particular, admin-managed. `isHeadOffice=true` = สำนักงานใหญ่ (default);
   * `false` = a branch carrying the 5-digit `branchCode`. Pinned into the
   * immutable buyer identity snapshot at invoice issue.
   *
   * OPTIONAL on the aggregate so the ~60 partial-`Member` fixtures + the create
   * draft (`Omit<Member,…>`) stay non-breaking: `rowToMember` ALWAYS populates
   * them from the DB (NOT NULL flag + nullable code), so a Member loaded from
   * the repo always carries real values; consumers that build a Member by hand
   * (tests, create draft) may omit them and the DB DEFAULT (`true` / NULL)
   * applies on insert. Read sites guard `?? true` / `?? null`.
   */
  readonly isHeadOffice?: boolean;
  readonly branchCode?: string | null;
  /**
   * 059 / PR-A — the §86/4 VAT-registrant flag, RECORDED not derived (never
   * infer it from `legalEntityType` — see migration 0246). Gates whether the
   * buyer's §86/4 branch particular and TIN are required on a tax document.
   */
  readonly isVatRegistered: boolean;
  readonly website: string | null;
  readonly description: string | null;
  readonly foundedYear: number | null;
  readonly turnoverThb: number | null;
  readonly registeredCapitalThb: number | null;
  readonly planId: PlanId;
  readonly planYear: number;
  readonly registrationDate: Date;
  readonly registrationFeePaid: boolean;
  readonly lastActivityAt: Date | null;
  readonly notes: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
  readonly subDistrict: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
} & MemberLifecycle;

// --- State transitions --------------------------------------------------------

export type MemberStateError =
  | { code: 'state.already_in_target' }
  | { code: 'state.cannot_archive_already_archived' }
  | { code: 'state.undelete_window_expired'; daysSinceArchive: number }
  | { code: 'state.undelete_only_from_archived' };

export const ARCHIVE_UNDELETE_WINDOW_DAYS = 90;

/** Transition `active` ↔ `inactive`. */
export function setStatus(
  member: Member,
  next: 'active' | 'inactive',
  now: Date,
): Result<Member, MemberStateError> {
  if (member.status === next)
    return err({ code: 'state.already_in_target' });
  if (member.status === 'archived')
    return err({ code: 'state.undelete_only_from_archived' });
  return ok({
    ...member,
    status: next,
    archivedAt: null,
    updatedAt: now,
  });
}

export function archive(
  member: Member,
  now: Date,
): Result<Member, MemberStateError> {
  if (member.status === 'archived')
    return err({ code: 'state.cannot_archive_already_archived' });
  return ok({
    ...member,
    status: 'archived',
    archivedAt: now,
    updatedAt: now,
  });
}

/**
 * Undelete (archived → active) gated by the 90-day window. The window is
 * measured from `archivedAt` to `now`.
 */
export function undelete(
  member: Member,
  now: Date,
): Result<Member, MemberStateError> {
  if (member.status !== 'archived' || member.archivedAt === null)
    return err({ code: 'state.undelete_only_from_archived' });

  const elapsedMs = now.getTime() - member.archivedAt.getTime();
  const elapsedDays = Math.floor(elapsedMs / 86_400_000);
  if (elapsedDays > ARCHIVE_UNDELETE_WINDOW_DAYS)
    return err({
      code: 'state.undelete_window_expired',
      daysSinceArchive: elapsedDays,
    });

  return ok({
    ...member,
    status: 'active',
    archivedAt: null,
    updatedAt: now,
  });
}

export function isMemberStatus(value: unknown): value is MemberStatus {
  return (
    typeof value === 'string' &&
    (MEMBER_STATUSES as readonly string[]).includes(value)
  );
}
