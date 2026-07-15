/**
 * Pass A · Section 5 — `loadMembersMembershipStatus`.
 *
 * Member-directory batch read. Given the current page's member ids, returns
 * the Sets of those whose MOST-RECENT renewal cycle has ended coverage
 * (`lapsed`) or is temporarily paused (`suspended`) — see
 * `deriveMembershipAccess`, the single source of truth for both. Powers the
 * "Lapsed" and "Suspended" badges on the admin Members directory rows
 * without an N+1. A member is in AT MOST ONE of the two sets (`access` is a
 * discriminated `'full' | 'suspended' | 'terminated'`, never both).
 *
 * Why a dedicated batch read (not a per-row `loadMemberRenewalStatus`): the
 * directory renders up to a page of members at once; calling the single-
 * member read once per row is `pageSize` round-trips. This issues ONE batch
 * query via `cyclesRepo.findLatestCyclesForMembers` (Task 4) and maps each
 * returned latest cycle through the pure `deriveMembershipAccess` domain
 * rule once per cycle (`isMembershipLapsed(c, now) ===
 * (deriveMembershipAccess(c, now).access === 'terminated')`, so the lapsed
 * set's behaviour is unchanged from before this predicate was introduced —
 * only the additional `suspended` set is new, Slice 3 / Task 16).
 *
 * Empty input short-circuits with no DB round-trip (the directory may render
 * an empty page; the repo contract also forbids a hit on an empty id list).
 *
 * `now` comes from the injected clock (`deps.clock.now()`) so test fixtures
 * pin a deterministic instant. A repo throw PROPAGATES — the caller (member-
 * directory page wrapper, Task 8) catches it best-effort and degrades to
 * "no badges", so a renewals-side failure never crashes the directory page
 * (defence in depth; spec §4). This use-case therefore returns
 * `Result<…, never>`: there is no domain error to discriminate, only an
 * infrastructure throw that the caller owns.
 *
 * Tenant isolation: the `cyclesRepo.findLatestCyclesForMembers` Drizzle
 * adapter wraps its query in `runInTenant(ctx, …)` (Postgres RLS+FORCE) —
 * this use-case never touches a DB client directly (Constitution Principle I
 * two-layer isolation; Principle III port discipline).
 */
import { ok, type Result } from '@/lib/result';
import { deriveMembershipAccess } from '../../domain/renewal-cycle';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';

export interface LoadMembersMembershipStatusInput {
  readonly tenantId: string;
  /**
   * The current directory page's member ids. CONTRACT: callers MUST pass a
   * PAGE-BOUNDED list (≤ a few hundred ids) — this read is designed for
   * per-page badge enrichment, NOT bulk lookup. The repo adapter
   * (`findLatestCyclesForMembers`) binds one parameter per element rather than
   * `= ANY($1::uuid[])`, so a list exceeding Postgres's ~65535 bind-parameter
   * limit would fail at the driver. No live risk today: the only caller bounds
   * to the directory PAGE_SIZE (50). Do not feed an unbounded id set here.
   */
  readonly memberIds: readonly string[];
}

/**
 * Per-member benefit-access badges for the directory. `lapsed` mirrors the
 * pre-existing "Lapsed" badge (ended coverage, terminal status past expiry);
 * `suspended` is the NEW Task 16 set (unpaid / pending-review / grace-past
 * non-terminal cycles). Disjoint by construction — see `deriveMembershipAccess`.
 */
export interface MembersMembershipStatus {
  readonly lapsed: ReadonlySet<string>;
  readonly suspended: ReadonlySet<string>;
}

export async function loadMembersMembershipStatus(
  deps: Pick<RenewalsDeps, 'cyclesRepo' | 'clock'>,
  input: LoadMembersMembershipStatusInput,
): Promise<Result<MembersMembershipStatus, never>> {
  if (input.memberIds.length === 0) {
    return ok({ lapsed: new Set<string>(), suspended: new Set<string>() });
  }
  const now = deps.clock.now();
  const cycles = await deps.cyclesRepo.findLatestCyclesForMembers(
    input.tenantId,
    input.memberIds,
  );
  const lapsed = new Set<string>();
  const suspended = new Set<string>();
  for (const c of cycles) {
    const { access } = deriveMembershipAccess(c, now);
    if (access === 'terminated') lapsed.add(c.memberId);
    else if (access === 'suspended') suspended.add(c.memberId);
  }
  return ok({ lapsed, suspended });
}
