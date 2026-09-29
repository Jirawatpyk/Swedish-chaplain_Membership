'use client';

/**
 * 108 FR-003 — "this member has no primary contact, so their money emails are
 * not going out".
 *
 * The recipient of every invoice, receipt, void notice and credit note is the
 * member's live primary contact. When there is none, the enqueue is skipped and
 * an `auto_email_skipped_no_recipient` audit row is written — but nobody reads
 * the audit log to discover that a member stopped receiving their receipts. The
 * failure is otherwise perfectly silent: the payment succeeds, the document is
 * issued, and the member hears nothing.
 *
 * So it is surfaced where staff already look — the member page and the invoice
 * page — and it is NOT dismissible: the condition is not an annoyance to
 * acknowledge, it is data to fix, and the banner disappears the moment a live
 * primary contact exists.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Alert } from '@jirawatpyk/aura-react';

type Props = {
  readonly memberId: string;
  /**
   * Where to go to fix it. Pass the member page's href when the banner is
   * rendered somewhere else (the invoice page); omit it on the member page
   * itself, where the contacts section is already on screen.
   */
  readonly contactsHref?: string;
};

export function NoPrimaryContactBanner({ memberId, contactsHref }: Props) {
  const t = useTranslations('admin.members.detail.noPrimaryBanner');

  return (
    // No `role="alert"` (round-4 finding #12). This banner is part of the
    // page's INITIAL server render, not something inserted in response to an
    // action, and `role="alert"` is `aria-live="assertive"` — it interrupts
    // whatever a screen reader is saying, on every navigation to this member,
    // invoice or credit note. Live regions announce CHANGES; static content
    // belongs in the document, which is why the sibling `ArchivedBanner` (the
    // pattern this one follows) sets no role either. The heading text carries
    // the meaning, and it is reached in normal reading order near the top of
    // the page.
    // Spec 122 US5b-1 — an AURA danger Alert (a money-path failure, not an
    // informational note), with `role="note"` for the reason above.
    <Alert
      tone="danger"
      role="note"
      title={t('title')}
      data-member-id={memberId}
      data-testid="no-primary-contact-banner"
    >
      <p>{t('body')}</p>
      {contactsHref === undefined ? null : (
        <Link
          href={contactsHref}
          className="mt-2 inline-block text-sm font-medium underline underline-offset-4"
        >
          {t('cta')}
        </Link>
      )}
    </Alert>
  );
}
