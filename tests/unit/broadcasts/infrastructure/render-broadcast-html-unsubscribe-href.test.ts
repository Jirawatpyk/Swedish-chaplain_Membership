/**
 * R105 (PR #692) — the footer's Unsubscribe link.
 *
 * A real E-Blast carries Resend Broadcasts' per-recipient merge tag, which
 * only Broadcasts substitutes. A caller on another path (the test copy, sent
 * through the transactional sender) passes its own `unsubscribeHref`; the
 * tag must then be gone, or the link has no target.
 */
import { describe, expect, it } from 'vitest';
import { renderBroadcastHtml } from '@/modules/broadcasts/infrastructure/resend/email-template';

const BASE = {
  subject: 'Hello',
  bodyHtml: '<p>Body</p>',
  tenantDisplayName: 'Chamber & Co',
  locale: 'en' as const,
};

describe('the footer Unsubscribe link', () => {
  it('is the Resend Broadcasts merge tag by default', () => {
    const html = renderBroadcastHtml(BASE);
    expect(html).toContain('<a href="{{{RESEND_UNSUBSCRIBE_URL}}}"');
  });

  it('is the caller\'s link, escaped, when one is given, and the merge tag is gone', () => {
    const html = renderBroadcastHtml({ ...BASE, unsubscribeHref: 'https://app.example/unsubscribe/test-copy?lang=en&x="1"' });
    expect(html).toContain('<a href="https://app.example/unsubscribe/test-copy?lang=en&amp;x=&quot;1&quot;"');
    expect(html).not.toContain('RESEND_UNSUBSCRIBE_URL');
  });
});
