/**
 * Contact — child entity of Member.
 *
 * No independent lifecycle (spec § Summary — contacts live and die with
 * their member). Soft-deleted via `removedAt` for audit continuity.
 *
 * Invariants (enforced by `policies/primary-contact-invariant.ts` and
 * the DB partial unique index):
 *   - Exactly one `isPrimary = TRUE` per member while `removedAt IS NULL`
 *     and parent member `status ∈ {active, inactive}`.
 *   - `isPrimary = TRUE ⇒ removedAt IS NULL`.
 *
 * Pure TypeScript — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';
import type { Email } from './value-objects/email';
import type { Phone } from './value-objects/phone';
import type { UserId } from './value-objects/user-id';
import { isUuid } from './value-objects/uuid';
import type { MemberId, TenantId } from './member';

declare const ContactIdBrand: unique symbol;
export type ContactId = string & { readonly [ContactIdBrand]: true };

/**
 * Brand a raw string as a ContactId. Used at trust boundaries where the
 * value has been validated externally (e.g. returned from the contacts
 * repo, read from URL params after zod parsing). Prefer `tryContactId`
 * for raw untrusted input — ContactIds are UUIDs so a format check is
 * cheap.
 */
export function asContactId(raw: string): ContactId {
  return raw as ContactId;
}

/** Validated ContactId brander for untrusted input. Uses shared UUID regex. */
export function tryContactId(raw: unknown): Result<ContactId, { code: 'invalid_contact_id' }> {
  if (!isUuid(raw)) {
    return err({ code: 'invalid_contact_id' });
  }
  return ok(raw.toLowerCase() as ContactId);
}

export const PREFERRED_LANGUAGES = ['en', 'th', 'sv'] as const;
export type PreferredLanguage = (typeof PREFERRED_LANGUAGES)[number];

/**
 * Primacy sub-shape (M5 review hardening) — encodes the invariant
 * `isPrimary = TRUE ⇒ removedAt IS NULL` so an illegal
 * `{isPrimary:true, removedAt:<date>}` is unrepresentable in any FULL `Contact`
 * value. Mirrors the DB CHECK `contacts_primary_not_removed` (migration 0009).
 * A non-primary contact may be active (removedAt null) or removed (removedAt set).
 *
 * NOTE: like MemberLifecycle, `Omit<Contact, K>` collapses this union, so
 * create-DRAFT types do not enforce the correlation; `contactPrimacy()` + the
 * DB CHECK are the backstops at the construct surface.
 */
export type ContactPrimacy =
  | { readonly isPrimary: true; readonly removedAt: null }
  | { readonly isPrimary: false; readonly removedAt: Date | null };

/**
 * Build the correlated primacy sub-shape from a raw isPrimary + removedAt
 * (e.g. a DB row). The throw is a defensive assertion of the DB CHECK
 * invariant and is unreachable for well-formed rows.
 */
export function contactPrimacy(
  isPrimary: boolean,
  removedAt: Date | null,
): ContactPrimacy {
  if (isPrimary) {
    if (removedAt !== null) {
      throw new Error(
        'contact invariant violated: a primary contact cannot be removed ' +
          '(DB CHECK contacts_primary_not_removed)',
      );
    }
    return { isPrimary: true, removedAt: null };
  }
  return { isPrimary: false, removedAt };
}

/**
 * 108 PR-D (US4 / FR-027, FR-030, FR-032) — per-contact marketing opt-out.
 *
 * Who switched marketing off for this contact, and when. `'staff'` = a
 * holder of `contacts.marketing` on the member / audience page; `'self'` =
 * the contact themself in the portal. The person's own UNSUBSCRIBE is not
 * recorded here — it lives in the F7 suppression list and always wins
 * (FR-025); see `deriveMarketingState`.
 */
export const MARKETING_OPT_OUT_SOURCES = ['staff', 'self'] as const;
export type MarketingOptOutSource = (typeof MARKETING_OPT_OUT_SOURCES)[number];

/**
 * Correlated sub-shape, mirroring `ContactPrimacy`: the three columns are
 * all null (receives marketing — the no-backfill default) or all set. The
 * DB CHECK `contacts_marketing_opt_out_correlated` (migration 0294) is the
 * storage-side twin of this union; `contactMarketing()` is the construct-
 * surface backstop.
 */
export type MarketingOptOut =
  | { readonly optedOutAt: null; readonly source: null; readonly byUserId: null }
  | {
      readonly optedOutAt: Date;
      readonly source: MarketingOptOutSource;
      readonly byUserId: UserId;
    };

/** The all-null shape every new contact starts in (FR-027: no backfill). */
export const RECEIVES_MARKETING: MarketingOptOut = Object.freeze({
  optedOutAt: null,
  source: null,
  byUserId: null,
});

function isMarketingOptOutSource(value: unknown): value is MarketingOptOutSource {
  return (
    typeof value === 'string' &&
    (MARKETING_OPT_OUT_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * Build the correlated opt-out sub-shape from raw columns (e.g. a DB row).
 * The throws are defensive assertions of the DB CHECKs and are unreachable
 * for well-formed rows.
 */
export function contactMarketing(
  optedOutAt: Date | null,
  source: string | null,
  byUserId: string | null,
): MarketingOptOut {
  if (optedOutAt === null && source === null && byUserId === null) {
    return RECEIVES_MARKETING;
  }
  if (optedOutAt === null || source === null || byUserId === null) {
    throw new Error(
      'contact invariant violated: marketing opt-out columns must be all null ' +
        'or all set (DB CHECK contacts_marketing_opt_out_correlated)',
    );
  }
  if (!isMarketingOptOutSource(source)) {
    throw new Error(
      `contact invariant violated: unknown marketing opt-out source "${source}" ` +
        '(DB CHECK contacts_marketing_opt_out_source_check)',
    );
  }
  return { optedOutAt, source, byUserId: byUserId as UserId };
}

/**
 * The DISPLAYED marketing state (FR-031) — derived, never stored.
 * Precedence: suppression (the person's own unsubscribe) > opt-out > on
 * (FR-025). An unreadable suppression list yields `'unavailable'` on every
 * surface (FR-031a: "neither on nor off"), never a guessed state — dispatch
 * re-resolves suppression itself, so display honesty costs no delivery.
 */
export const MARKETING_STATES = [
  'on',
  'off_by_staff',
  'off_by_contact',
  'unsubscribed',
  'unavailable',
] as const;
export type MarketingState = (typeof MARKETING_STATES)[number];

export function deriveMarketingState(
  marketing: MarketingOptOut,
  suppressed: boolean | 'unknown',
): MarketingState {
  if (suppressed === 'unknown') return 'unavailable';
  if (suppressed) return 'unsubscribed';
  if (marketing.optedOutAt === null) return 'on';
  return marketing.source === 'staff' ? 'off_by_staff' : 'off_by_contact';
}

export type Contact = {
  readonly tenantId: TenantId;
  readonly contactId: ContactId;
  readonly memberId: MemberId;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: Email;
  readonly phone: Phone | null;
  readonly roleTitle: string | null;
  readonly preferredLanguage: PreferredLanguage;
  readonly dateOfBirth: Date | null;
  readonly linkedUserId: UserId | null;
  /**
   * Spec § Edge Cases — set when the invitation email to this contact
   * bounced (Resend `email.bounced`). NULL = no bounce recorded.
   * Cleared (best-effort) when an admin re-sends the invitation via the
   * `resendBouncedInvite` use-case — in a separate chamber_app tx AFTER
   * the new invitation email is dispatched. If that clear fails the email
   * is still sent and the flag persists until a retry.
   */
  readonly inviteBouncedAt: Date | null;
  /**
   * GDPR Art. 14 attestation (Task 8, product decision 2026-07-14) — the
   * moment an admin confirmed they informed this THIRD PARTY (whose data
   * was collected from the admin, not from the person themselves) that
   * their details are held by the chamber.
   *
   * CORRECTED 2026-07-15 after a compliance review. This is NOT the
   * Art. 14(5)(a) exemption, which the first version of this comment wrongly
   * cited. That exemption is for when the data subject ALREADY HAS the
   * Art. 14(1)-(2) particulars independently of this collection — it is not a
   * way for the controller to CAUSE them to have the information via another
   * channel and then claim no notice was owed.
   *
   * What this is: the Art. 14(1)-(2) notice duty DISCHARGED THROUGH AN
   * OUT-OF-BAND CHANNEL (the admin tells the person directly; GDPR does not
   * mandate email — recitals 58/60 allow any appropriate manner), with this
   * timestamp as the Art. 5(2) ACCOUNTABILITY EVIDENCE that it happened.
   * Stamped from the server's clock, never the client's, so it carries
   * evidentiary weight. Thailand PDPA §25 wants the same notice within 30 days
   * and offers no "already has the information" escape, so the same reading
   * has to hold there too.
   *
   * A point-in-time COMPLIANCE RECORD of the ORIGINAL collection event,
   * not a live "is this currently a primary contact" flag:
   *   - NULL for the member's own primary contact — a first-party
   *     relationship (the member supplied their own representative's
   *     details at onboarding), so Art. 14 does not apply. Also NULL for
   *     any contact collected before this control existed.
   *   - A real timestamp for any contact added ON SOMEONE ELSE'S BEHALF
   *     by an admin (a secondary contact at member creation, or any
   *     contact added via the member Edit page's "Add contact" dialog).
   *
   * Deliberately NEVER re-derived from `isPrimary`: a contact that is
   * later promoted to / demoted from primary (`promotePrimaryInTx`) does
   * NOT get this value rewritten — promotion doesn't erase the historical
   * fact of how the data was originally obtained, and demotion cannot
   * retroactively fabricate an attestation that never happened. See
   * `drizzle-contact-repo.ts` `promotePrimaryInTx` for why this rules out
   * a DB CHECK correlating this column with `isPrimary`.
   */
  readonly art14AttestedAt: Date | null;
  /**
   * 108 PR-D — per-contact marketing opt-out (all null = receives). Never
   * consulted by any money path: money-email eligibility is `isPrimary &&
   * removedAt === null` only (FR-033). Drafts handed to `addInTx` /
   * `createWithPrimaryContactInTx` omit this field — a new contact always
   * starts in `RECEIVES_MARKETING`.
   */
  readonly marketing: MarketingOptOut;
  readonly createdAt: Date;
  readonly updatedAt: Date;
} & ContactPrimacy;

export function isPreferredLanguage(
  value: unknown,
): value is PreferredLanguage {
  return (
    typeof value === 'string' &&
    (PREFERRED_LANGUAGES as readonly string[]).includes(value)
  );
}
