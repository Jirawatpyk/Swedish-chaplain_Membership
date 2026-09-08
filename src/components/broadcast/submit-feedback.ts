/**
 * 108 PR-C T077 (FR-022a, US3 AS9) — the pure copy decisions shared by the
 * member compose form and the admin proxy form: which estimate / hint /
 * notice line describes the segment in hand, whether the live count blocks
 * the submit, how a submit error is interpolated, and how many entries the
 * submit response says were removed "by recipient preference". The sender
 * is told the NUMBER — never which addresses, never why beyond "recipient
 * preference" (spec edge case "Opted-out contact on a custom list").
 *
 * Pure so it is unit-testable in jsdom: the forms cannot be driven to a
 * submit without a live Tiptap editor. Defensive on the field: an older
 * server, a malformed body or a negative number all read as 0 — a toast
 * must never say "NaN addresses".
 */
import type { RecipientCountState } from './recipient-count';

export interface SubmitFeedbackBody {
  readonly recipientPreferenceExcluded?: unknown;
}

/**
 * 108 PR-C T085 (FR-041 / FR-042) — interpolation values for a submit error.
 * The "audience too large" copy names the ceiling the server actually refused
 * against (`details.cap` on the 422 body — 500 since 2026-09-08, being
 * `min(configured, DELIVERABLE_RECIPIENTS_PER_TICK)`; the configured 5,000 /
 * 50,000 no longer reaches the wire), so the message can never claim a limit
 * the server did not apply. That property is why the clamp needed no copy
 * change in any of the three locales: every string interpolates
 * `{ceiling, number}` from this value.
 *
 * Review 2026-09-07 round 2 (i18n H4): next-intl does NOT throw on a missing
 * value — it renders the raw key path as the toast — so the too-large code
 * must ALWAYS carry a ceiling. When the body has no usable cap (an older
 * server, a malformed body) the value is the ceiling the page resolved
 * server-side. Every other code yields `undefined` (no placeholders).
 */
export function errorValues(
  code: string,
  details: Record<string, unknown> | undefined,
  fallbackCeiling: number,
): Record<string, number> | undefined {
  if (code !== 'broadcast_audience_too_large') return undefined;
  const cap = details?.['cap'];
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap <= 0) {
    return { ceiling: fallbackCeiling };
  }
  return { ceiling: cap };
}

/**
 * Review 2026-09-07 round 2 (UX H-4, decision (a)) — does the live count
 * block the submit? A MEASURED refusal does: over the ceiling, or nobody
 * left after the filters (the count line says so, in red). `unavailable`
 * never does — the count is advisory there and the server recomputes the
 * audience (FR-040b). `loading` / `idle` never do either.
 */
export function submitBlockedByCount(state: RecipientCountState): boolean {
  return state.status === 'ready' && (state.exceeds || state.count === 0);
}

export type ComposeSegmentKind = 'all_members' | 'tier' | 'custom' | 'event_attendees_last_90d';
export type ComposeAudienceMode = 'primary_only' | 'all_contacts';

/**
 * 108 PR-C T079 — which `estimateNote.*` line describes the recipients for a
 * segment under the leg in force. With the flag ON the member-based segments
 * reach every eligible contact, not one primary per member, and the copy
 * says so; the custom list and the attendee segment are leg-independent.
 * The caller interpolates `{ ceiling }` (FR-041: the real ceiling, never a
 * hard-coded 5,000).
 */
export function estimateNoteKey(
  segmentKind: ComposeSegmentKind,
  audienceMode: ComposeAudienceMode,
):
  | 'estimateNote.allMembers'
  | 'estimateNote.allMembersAllContacts'
  | 'estimateNote.tier'
  | 'estimateNote.tierAllContacts'
  | 'estimateNote.custom'
  | 'estimateNote.attendees'
  // /code-review 2026-09-07 (finding #6) — see the default arm.
  | null {
  switch (segmentKind) {
    case 'all_members':
      return audienceMode === 'all_contacts'
        ? 'estimateNote.allMembersAllContacts'
        : 'estimateNote.allMembers';
    case 'tier':
      return audienceMode === 'all_contacts' ? 'estimateNote.tierAllContacts' : 'estimateNote.tier';
    case 'custom':
      return 'estimateNote.custom';
    // Review 2026-09-07 round 2 (UX H-2 + i18n L1) — the attendee segment
    // inherited the custom-list copy ("each line below is one email…") with
    // no textarea following it, beside a real server count. Its own line.
    case 'event_attendees_last_90d':
      return 'estimateNote.attendees';
    default: {
      // A fifth segment kind must choose its copy here, never inherit one.
      const _exhaustive: never = segmentKind;
      // /code-review 2026-09-07 (finding #6) — this used to `return
      // _exhaustive`, i.e. the segment STRING, which the caller then hands
      // straight to `t()`. next-intl does not throw on a missing key: it
      // renders the key PATH, so an unrecognised kind would have printed
      // "portal.broadcasts.compose.event_attendees_last_30d" on the compose
      // form in all three locales. Same fail-open shape as
      // `isMissingAddressOrphan`, one file over, fixed the same day.
      // Returning null rather than a "safe" sibling key because every
      // sibling asserts a REACH ("every contact of every member", "each line
      // below is one email") and asserting the wrong one is worse than
      // saying nothing about a segment we do not recognise.
      void _exhaustive;
      return null;
    }
  }
}

/**
 * 108 PR-C T079 (FR-022b) — "You and your colleagues won't receive your own
 * broadcast." applies to the member-based segments only: self-exclusion is
 * by member on `all_members` / `tier`, and the custom list is exempt
 * (FR-022a); attendee rows are not member-keyed.
 */
export function showsSelfExclusionHint(segmentKind: ComposeSegmentKind): boolean {
  return segmentKind === 'all_members' || segmentKind === 'tier';
}

/**
 * Review 2026-09-07 round 2 (UX H-3) — EVERY segment kind carries a hint that
 * says which way the self-exclusion rule goes. Silence on the custom list /
 * attendee segment read as "the same rule applies": a sender who learned
 * "you won't receive your own broadcast" on all_members switched to a list
 * containing their own address and got their own e-blast — and on the
 * attendee segment they cannot even inspect the list.
 */
export function selfExclusionHintKey(
  segmentKind: ComposeSegmentKind,
):
  | 'selfExclusionHint'
  | 'selfExclusionHintCustom'
  | 'selfExclusionHintAttendees'
  // /code-review 2026-09-07 (finding #6) — see the default arm.
  | null {
  switch (segmentKind) {
    case 'all_members':
    case 'tier':
      return 'selfExclusionHint';
    case 'custom':
      return 'selfExclusionHintCustom';
    case 'event_attendees_last_90d':
      return 'selfExclusionHintAttendees';
    default: {
      const _exhaustive: never = segmentKind;
      // Same class as `estimateNoteKey` above. Null rather than a default
      // arm: `selfExclusionHint` PROMISES "you and your colleagues won't
      // receive your own broadcast", and a promise of exclusion is the one
      // thing an unrecognised segment must not make.
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Review 2026-09-07 round 2 (UX H-1 + i18n H3) — the staff proxy form's
 * "{company} won't receive this broadcast" notice, which used to render on
 * member selection regardless of segment. On the custom list / attendee
 * segment the member's own address DOES receive it, and the notice says so.
 */
export function proxySelfExclusionNoticeKey(
  segmentKind: ComposeSegmentKind,
):
  | 'selfExclusionNotice'
  | 'selfExclusionNoticeIncluded'
  // /code-review 2026-09-07 (the pass AFTER #6) — the same class as
  // `estimateNoteKey`, one function below it, and #6 walked past it. There is
  // no `_exhaustive` arm here to be fail-open; the delegation IS the fail-open
  // path: `showsSelfExclusionHint` answers `false` for anything that is not
  // `all_members` / `tier`, so an unrecognised kind falls to
  // `selfExclusionNoticeIncluded` — "{company} WILL receive this broadcast".
  // #6's own comment calls a borrowed promise worse than silence; this one
  // borrows the OPPOSITE promise instead of printing a key path, which is not
  // an improvement. Null, and the notice is omitted.
  | null {
  switch (segmentKind) {
    case 'all_members':
    case 'tier':
      return 'selfExclusionNotice';
    case 'custom':
    case 'event_attendees_last_90d':
      return 'selfExclusionNoticeIncluded';
    default: {
      const _exhaustive: never = segmentKind;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * How many entries the submit response says were removed by recipient
 * preference. Review 2026-09-07 round 2 (UX H-6): the forms show this as its
 * OWN toast, held longer — not a description under the success toast that
 * `router.push()` navigated away from in four seconds.
 */
export function excludedByPreference(body: SubmitFeedbackBody): number {
  const n = body.recipientPreferenceExcluded;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
}

/** Review round 2 (UX H-6) — the preference toast's duration, in ms. */
export const PREFERENCE_TOAST_DURATION_MS = 8_000;
