/**
 * #400 item 2 — WHERE THE `MemberId` BRAND STOPS.
 *
 * `Broadcast.requestedByMemberId` is a plain string on purpose: the broadcasts
 * Domain imports no other module, and every actor id on the aggregate is a
 * string. The F119 Application seams (the use-case inputs and the
 * member-keyed ports) take the members module's `MemberId`, so a use case
 * holding the aggregate re-brands the owner here — one place, one reason —
 * instead of a cast at each call.
 *
 * A TYPE-ONLY brand, not the members barrel's `asMemberId`: a runtime import
 * of that barrel from an approval use case closes an import cycle (the members
 * barrel's erasure adapters import the broadcasts barrel), which deadlocks a
 * vitest suite that mocks the broadcasts barrel with an async factory. The
 * value is the row's own `requested_by_member_id` (a uuid FK to `members`),
 * so there is nothing to validate.
 *
 * The rule is about WHERE the import sits, not about `asMemberId`: outside
 * this module — the composition layer (`src/lib/broadcast-approval-
 * notifications.ts`, which already imports the members barrel at runtime and
 * is not imported by either barrel) or a page — `asMemberId` is the right
 * call and is what those callers use.
 */
import type { MemberId } from '@/modules/members';
import type { Broadcast } from '../../../domain/broadcast';

/** The E-Blast's originating member, as the `MemberId` the ports expect. */
export function ownerMemberId(broadcast: Pick<Broadcast, 'requestedByMemberId'>): MemberId {
  return broadcast.requestedByMemberId as MemberId;
}
