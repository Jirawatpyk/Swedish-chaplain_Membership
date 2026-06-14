/**
 * Pass A · Section 5 — `loadMembersMembershipStatus`.
 *
 * Member-directory batch read. Given the current page's member ids, returns
 * the Set of those whose MOST-RECENT renewal cycle has lapsed (terminal
 * `lapsed`/`cancelled`, past expiry — see `isMembershipLapsed`). Powers the
 * "Lapsed" badge on the admin Members directory rows without an N+1.
 *
 * Why a dedicated batch read (not a per-row `loadMemberRenewalStatus`): the
 * directory renders up to a page of members at once; calling the single-
 * member read once per row is `pageSize` round-trips. This issues ONE batch
 * query via `cyclesRepo.findLatestCyclesForMembers` (Task 4) and maps each
 * returned latest cycle through the pure `isMembershipLapsed` domain rule.
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
import { isMembershipLapsed } from '../../domain/renewal-cycle';
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

export async function loadMembersMembershipStatus(
  deps: Pick<RenewalsDeps, 'cyclesRepo' | 'clock'>,
  input: LoadMembersMembershipStatusInput,
): Promise<Result<ReadonlySet<string>, never>> {
  if (input.memberIds.length === 0) return ok(new Set<string>());
  const now = deps.clock.now();
  const cycles = await deps.cyclesRepo.findLatestCyclesForMembers(
    input.tenantId,
    input.memberIds,
  );
  const lapsed = new Set<string>();
  for (const c of cycles) {
    if (isMembershipLapsed(c, now)) lapsed.add(c.memberId);
  }
  return ok(lapsed);
}
