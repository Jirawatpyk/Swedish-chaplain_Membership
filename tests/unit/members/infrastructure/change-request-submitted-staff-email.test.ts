/**
 * F114 T035 — the staff "who changed what" email (FR-011, SC-002;
 * contracts/notifications-and-audit.md § 1).
 *
 * Rendered at SEND time from the request rows (never from the outbox
 * context_data). Pinned: EN/TH/SV render; the subject names the company +
 * member number; one line per field `<label>: <current> → <proposed>`,
 * `(empty)` for null, address groups as a block, the tax marker on flagged
 * rows; every value passes `escapeHtml`; the link opens the submitter's
 * CURRENT pending request (`?submitter=<userId>&state=pending`, never a
 * request id); no CC/BCC field exists on the payload.
 */
import { describe, expect, it } from 'vitest';
import {
  buildChangeRequestSubmittedStaffEmail,
  type ChangeRequestSubmittedStaffEmailInput,
} from '@/modules/members/infrastructure/email/change-request-submitted-staff-email';

const base: ChangeRequestSubmittedStaffEmailInput = {
  locale: 'en',
  companyName: 'Nordic <Co>',
  memberNumber: 'SCCM-0042',
  submitterName: 'Anna Svensson',
  submitterRole: 'primary',
  submittedAt: new Date('2026-09-11T08:00:00Z'),
  submitterUserId: 'a6c5b1a2-0000-4000-8000-00000000bbbb',
  fields: [
    { key: 'phone', current: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false },
    { key: 'description', current: null, proposed: '<b>Bold</b> & more', affectsTaxDocuments: false },
    {
      key: 'billing_address',
      current: { line1: null, line2: null, sub_district: null, city: null, province: null, postal_code: null, country: null },
      proposed: { line1: 'Box 9', line2: null, sub_district: null, city: 'Stockholm', province: null, postal_code: '11122', country: 'SE' },
      affectsTaxDocuments: true,
    },
  ],
};

describe('buildChangeRequestSubmittedStaffEmail', () => {
  it.each(['en', 'th', 'sv'] as const)('renders %s with subject, member, submitter, time and the diff', (locale) => {
    const built = buildChangeRequestSubmittedStaffEmail({ ...base, locale });
    expect(built.subject).toContain('Nordic <Co>');
    expect(built.subject).toContain('SCCM-0042');
    expect(built.subject.startsWith('[SweCham]')).toBe(true);
    expect(built.html).toContain('Anna Svensson');
    expect(built.html).toContain('SCCM-0042');
    expect(built.text).toContain('+66812345678');
    expect(built.text).toContain('+66899999999');
    expect(built.html).toMatch(/<html lang="(en|th|sv)">/);
    if (locale === 'th') expect(built.html).toMatch(/[฀-๿]/);
  });

  it('one line per field — current → proposed, (empty) for null, the address group as a block, the tax marker on flagged rows', () => {
    const built = buildChangeRequestSubmittedStaffEmail(base);
    expect(built.text).toMatch(/Phone: \+66812345678 → \+66899999999/);
    expect(built.text).toMatch(/Description: \(empty\) → <b>Bold<\/b> & more/);
    expect(built.text).toContain('Box 9');
    expect(built.text).toContain('Stockholm');
    expect(built.text).toContain('11122');
    expect(built.text).toContain('SE');
    // the tax marker appears exactly once — on the billing address row
    expect(built.text.match(/affects tax documents/gi)?.length).toBe(1);
    const taxLine = built.text.split('\n').find((l) => /affects tax documents/i.test(l));
    expect(taxLine).toMatch(/Billing address/);
  });

  it('escapes every value in the HTML body (company name, proposed description)', () => {
    const built = buildChangeRequestSubmittedStaffEmail(base);
    expect(built.html).not.toContain('<b>Bold</b>');
    expect(built.html).toContain('&lt;b&gt;Bold&lt;/b&gt; &amp; more');
    expect(built.html).toContain('Nordic &lt;Co&gt;');
  });

  it('links to the submitter\'s CURRENT pending request, never a request id', () => {
    const built = buildChangeRequestSubmittedStaffEmail(base);
    const link = '/admin/change-requests?submitter=a6c5b1a2-0000-4000-8000-00000000bbbb&state=pending';
    expect(built.html).toContain(link);
    expect(built.text).toContain(link);
    expect(built.html).not.toMatch(/change-requests\/[0-9a-f-]{36}/);
  });

  it('carries only subject/html/text — no cc/bcc', () => {
    const built = buildChangeRequestSubmittedStaffEmail(base);
    expect(Object.keys(built).sort()).toEqual(['html', 'subject', 'text']);
  });

  it('names the submitter role (primary / secondary) in the body', () => {
    const primary = buildChangeRequestSubmittedStaffEmail(base);
    const secondary = buildChangeRequestSubmittedStaffEmail({ ...base, submitterRole: 'secondary' });
    expect(primary.text).toMatch(/primary contact/i);
    expect(secondary.text).toMatch(/secondary contact/i);
  });
});
