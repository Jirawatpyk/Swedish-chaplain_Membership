/**
 * #89 (UX L6 on #777) — which deep links on /admin/invoices/new cannot be
 * used, so the page says so instead of opening with an empty picker:
 * - `memberLinkUnusable`: a `?memberId=` the membership picker does not offer
 *   (archived, gone from this tenant, or the read failed);
 * - `registrationLinkUnusable`: an `?eventRegistrationId=` whose event did not
 *   resolve, or is not among the event picker's options.
 * A linked registration that the event's attendee list lacks (or that is
 * erased) is said by the attendee picker itself, which loads that list.
 */
export type DeepLinkNotice = 'memberLinkUnusable' | 'registrationLinkUnusable';

export function deepLinkNotices(input: {
  readonly initialMemberId?: string | undefined;
  readonly members: ReadonlyArray<{ readonly memberId: string }>;
  readonly initialRegistrationId?: string | undefined;
  readonly initialEventId?: string | undefined;
  readonly events: ReadonlyArray<{ readonly eventId: string }>;
}): DeepLinkNotice[] {
  const notices: DeepLinkNotice[] = [];
  if (
    input.initialMemberId !== undefined &&
    !input.members.some((m) => m.memberId === input.initialMemberId)
  ) {
    notices.push('memberLinkUnusable');
  }
  if (
    input.initialRegistrationId !== undefined &&
    (input.initialEventId === undefined || !input.events.some((e) => e.eventId === input.initialEventId))
  ) {
    notices.push('registrationLinkUnusable');
  }
  return notices;
}
