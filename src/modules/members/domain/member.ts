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
import type { IsoCountryCode } from './value-objects/iso-country-code';
import type { TaxId } from './value-objects/tax-id';

export const MEMBER_STATUSES = ['active', 'inactive', 'archived'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

declare const MemberIdBrand: unique symbol;
export type MemberId = string & { readonly [MemberIdBrand]: true };

declare const TenantIdBrand: unique symbol;
export type TenantId = string & { readonly [TenantIdBrand]: true };

declare const PlanIdBrand: unique symbol;
export type PlanId = string & { readonly [PlanIdBrand]: true };

/**
 * Brand a raw string as a TenantId. Used at trust boundaries (adapters,
 * route handlers, tests) where the value has been validated externally.
 * For untrusted boundaries (user input, URL params) prefer
 * `tryTenantId` which runs a non-empty check and returns a Result.
 */
export function asTenantId(raw: string): TenantId {
  return raw as TenantId;
}

/** Validated TenantId brander for untrusted input. Rejects empty / whitespace. */
export function tryTenantId(raw: unknown): Result<TenantId, { code: 'invalid_tenant_id' }> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return err({ code: 'invalid_tenant_id' });
  }
  return ok(raw as TenantId);
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

/** UUID v4-ish pattern (accepts any RFC 4122 variant; route params are always lowercase hex). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
    return err({ code: 'invalid_member_id' });
  }
  return ok(raw.toLowerCase() as MemberId);
}

/**
 * Immutable Member aggregate. Mutations return a new Member instance via
 * the state-transition functions below — the Application layer persists
 * via the repo port.
 */
export type Member = {
  readonly tenantId: TenantId;
  readonly memberId: MemberId;
  readonly companyName: string;
  readonly legalEntityType: string | null;
  readonly country: IsoCountryCode;
  readonly taxId: TaxId | null;
  readonly website: string | null;
  readonly description: string | null;
  readonly foundedYear: number | null;
  readonly turnoverThb: number | null;
  readonly planId: PlanId;
  readonly planYear: number;
  readonly registrationDate: Date;
  readonly registrationFeePaid: boolean;
  readonly lastActivityAt: Date | null;
  readonly notes: string | null;
  readonly status: MemberStatus;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

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
