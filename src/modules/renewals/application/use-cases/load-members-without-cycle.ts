/**
 * DV-18 — `loadMembersWithoutCycle`.
 *
 * Read-only list of members that have NO `renewal_cycles` row at all — the
 * "renewal gap" the admin tray on `/admin/renewals` surfaces. Typically
 * pre-F8 members never onboarded into the cycle lifecycle (or whose
 * onboarding bridge silently no-op'd). The admin opens each member to
 * remediate (e.g. start a renewal cycle).
 *
 * Thin orchestration over `cyclesRepo.listMembersWithoutCycle`, which runs
 * the `members`-leading anti-join (correlated `NOT EXISTS` against
 * `renewal_cycles`, EXCLUDING archived + GDPR-erased) inside one
 * `runInTenant` block. This file is an input-validation + Result-mapping
 * wrapper so the server component stays Clean-Architecture compliant
 * (Presentation → Application → Infrastructure).
 *
 * No domain error to discriminate — input is server-sourced (no request
 * body), so the Result error channel is `never`. An infrastructure throw
 * PROPAGATES; the page wrapper catches it best-effort and renders a
 * "couldn't load" card so a renewals-side failure never crashes the
 * pipeline page (defence in depth; mirrors `loadPendingReactivationReview`).
 *
 * Tenant isolation: `cyclesRepo.listMembersWithoutCycle` wraps its query in
 * `runInTenant(ctx, …)` (Postgres RLS+FORCE on BOTH `members` and
 * `renewal_cycles`) — this use-case never touches a DB client directly
 * (Constitution Principle I two-layer isolation; Principle III port
 * discipline).
 */
import { ok, type Result } from '@/lib/result';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type {
  MemberWithoutCycleRow,
} from '../ports/renewal-cycle-repo';

/** Default page size — chambers have well under a few hundred no-cycle members. */
export const MEMBERS_WITHOUT_CYCLE_DEFAULT_LIMIT = 200;

export interface LoadMembersWithoutCycleInput {
  readonly tenantId: string;
  readonly limit?: number;
}

export interface LoadMembersWithoutCycleOutput {
  readonly items: ReadonlyArray<MemberWithoutCycleRow>;
  readonly totalCount: number;
}

export async function loadMembersWithoutCycle(
  deps: Pick<RenewalsDeps, 'cyclesRepo'>,
  input: LoadMembersWithoutCycleInput,
): Promise<Result<LoadMembersWithoutCycleOutput, never>> {
  const page = await deps.cyclesRepo.listMembersWithoutCycle(input.tenantId, {
    limit: input.limit ?? MEMBERS_WITHOUT_CYCLE_DEFAULT_LIMIT,
  });
  // The repo page (MembersWithoutCyclePage) is structurally the use-case
  // output — no transform/defaulting here, so return it directly rather than
  // re-spreading field-by-field.
  return ok(page);
}
