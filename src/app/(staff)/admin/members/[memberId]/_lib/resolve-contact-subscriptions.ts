/**
 * S1 (056 reliability follow-up) — contact marketing-subscription resolver.
 *
 * Extracts the F7 marketing-suppression batch lookup out of the member-detail
 * RSC so the fail-open / fail-degraded branching is unit-testable WITHOUT a
 * live Neon read. The page passes in a `lookupBatch` callable (the RLS-safe
 * `makeDrizzleMarketingUnsubscribesRepo(slug).lookupBatch` in production) and
 * a minimal logger; this helper owns the parse + projection + error handling.
 *
 * The return is a DISCRIMINATED result so the page can render a tri-state
 * badge: on a successful read every contact resolves to Subscribed /
 * Unsubscribed from `unsubscribed`; on a marketing-DB outage (`degraded:
 * true`) the page shows a neutral "Status unavailable" badge instead of
 * silently defaulting every contact to "Subscribed" (UI-honesty fix — NOT a
 * compliance change: the dispatch boundary always re-resolves suppression
 * before any send).
 */
import { asEmailLower, type EmailLower } from '@/modules/broadcasts';

/** Minimal logger surface — matches the subset of `pino` the page uses. */
export interface SubscriptionResolverLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Minimal contact shape the resolver needs (subset of the F3 `Contact`). */
export interface ResolvableContact {
  readonly contactId: string;
  readonly email: string | null;
  readonly removedAt: Date | null;
}

/** `lookupBatch` callable — the RLS-safe repo method, injected for testability. */
export type SuppressionLookup = (
  emailLowers: ReadonlyArray<EmailLower>,
) => Promise<ReadonlySet<EmailLower>>;

/**
 * Discriminated result. `degraded: false` carries the resolved set of
 * UNSUBSCRIBED contact ids; `degraded: true` means the lookup threw and the
 * page must render the neutral "unknown" badge for every contact.
 */
export type ContactSubscriptionResult =
  | { readonly degraded: false; readonly unsubscribed: ReadonlySet<string> }
  | { readonly degraded: true };

/** Stable args struct for `errKind`-style class-name-only logging. */
export interface ResolveContactSubscriptionsArgs {
  readonly contacts: ReadonlyArray<ResolvableContact>;
  readonly memberId: string;
  readonly lookupBatch: SuppressionLookup;
  readonly logger: SubscriptionResolverLogger;
  /** Logs ONLY the error class name — never the message (PII / SQL params). */
  readonly errKind: (e: unknown) => string;
}

/**
 * Batch-resolve each live (non-removed, has-email) contact's F7 suppression
 * status. Returns `{ degraded: false, unsubscribed }` on success or
 * `{ degraded: true }` when the lookup throws.
 */
export async function resolveContactSubscriptions({
  contacts,
  memberId,
  lookupBatch,
  logger,
  errKind,
}: ResolveContactSubscriptionsArgs): Promise<ContactSubscriptionResult> {
  try {
    const liveContacts = contacts.filter(
      (c) => c.removedAt === null && c.email,
    );
    // No live emails → not degraded; there is simply nothing suppressed.
    if (liveContacts.length === 0) {
      return { degraded: false, unsubscribed: new Set<string>() };
    }
    // contact.email is a branded Email; lower-case + brand to EmailLower.
    // Skip any that fail the EmailLower parse (defensive — domain Email is
    // already validated, but the suppression key demands a clean lower-case
    // value).
    const emailByContact = new Map<string, EmailLower>();
    for (const c of liveContacts) {
      const parsed = asEmailLower(String(c.email).toLowerCase());
      if (parsed.ok) {
        emailByContact.set(c.contactId, parsed.value);
      } else {
        // FIX 4 — log a debug breadcrumb when a contact email fails the
        // EmailLower parse (data drift / non-standard character in a stored
        // address). The contact is silently skipped → defaults to
        // "Subscribed". Mirrors the `metadata_company_name_lookup_failed`
        // pattern so future data-drift is observable.
        logger.debug(
          {
            event: 'contact_email_lower_parse_failed',
            contactId: c.contactId,
            memberId,
          },
          '[Pass A] asEmailLower parse failed — contact defaults to Subscribed',
        );
      }
    }
    const suppressedEmails = await lookupBatch([...emailByContact.values()]);
    const unsubscribed = new Set<string>();
    for (const [contactId, email] of emailByContact) {
      if (suppressedEmails.has(email)) unsubscribed.add(contactId);
    }
    return { degraded: false, unsubscribed };
  } catch (e) {
    logger.warn(
      {
        event: 'marketing_unsubscribe_lookup_threw',
        // errKind logs only the error class name — never e.message
        // (Postgres errors carry SQL params / table names).
        errKind: errKind(e),
        memberId,
      },
      '[Pass A] marketing-suppression lookup threw — contacts render as Status unavailable',
    );
    // S1 — on a marketing-DB outage we no longer default every contact to
    // "Subscribed" (misleading UI honesty). The page renders a neutral
    // "Status unavailable" badge instead. NOT a compliance change: the send
    // path re-resolves suppression independently before any dispatch.
    return { degraded: true };
  }
}
