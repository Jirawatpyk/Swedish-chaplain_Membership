/**
 * F114 T050 — the member "your request was decided" email (FR-023;
 * contracts/notifications-and-audit.md § 1).
 *
 * Pinned: a subject per outcome × 3 locales; the APPLIED ("now live") and
 * NOT-APPLIED sections; the reviewer's reason VERBATIM but escaped (a
 * `<script>` and a URL in the reason render as text, never as markup or a
 * link); the resubmit link `/portal/edit?resubmit=<id>`; the reviewer's name
 * is never included (organisation only).
 */
import { describe, expect, it } from 'vitest';
import {
  buildChangeRequestDecidedMemberEmail,
  type ChangeRequestDecidedMemberEmailInput,
} from '@/modules/members/infrastructure/email/change-request-decided-member-email';

const base: ChangeRequestDecidedMemberEmailInput = {
  locale: 'en',
  requestId: '00000000-0000-4000-8000-000000000001',
  outcome: 'partially_approved',
  decidedAt: new Date('2026-09-11T09:30:00Z'),
  reason: 'Please use the registered phone number. See <script>alert(1)</script> https://evil.example/x',
  fields: [
    { key: 'phone', proposed: '+66899999999', outcome: 'approved' },
    { key: 'description', proposed: 'A new description', outcome: 'rejected' },
  ],
  reviewerName: 'Sven Reviewer',
};

describe('buildChangeRequestDecidedMemberEmail', () => {
  it.each([
    ['approved', 'en'],
    ['partially_approved', 'en'],
    ['rejected', 'en'],
    ['approved', 'th'],
    ['rejected', 'sv'],
  ] as const)('subject for outcome %s in %s', (outcome, locale) => {
    const built = buildChangeRequestDecidedMemberEmail({ ...base, outcome, locale });
    expect(built.subject.startsWith('[SweCham]')).toBe(true);
    if (locale === 'th') expect(built.subject).toMatch(/[฀-๿]/);
    if (locale === 'en') {
      expect(built.subject).toMatch(outcome === 'approved' ? /approved/i : outcome === 'rejected' ? /not approved/i : /partially approved/i);
    }
  });

  it('lists applied fields under "now live" and not-applied fields with the reason', () => {
    const built = buildChangeRequestDecidedMemberEmail(base);
    expect(built.text).toMatch(/Phone[^\n]*\+66899999999/);
    expect(built.text).toMatch(/now live/i);
    expect(built.text).toMatch(/Description[^\n]*A new description/);
    expect(built.text).toMatch(/not approved/i);
    expect(built.text).toContain('Please use the registered phone number.');
  });

  it('renders the reason verbatim but ESCAPED — never markup, never a link', () => {
    const built = buildChangeRequestDecidedMemberEmail(base);
    expect(built.html).not.toContain('<script>');
    expect(built.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // the URL inside the reason is plain text: no anchor wraps it
    expect(built.html).not.toMatch(/<a[^>]+href="https:\/\/evil\.example/);
    expect(built.text).toContain('https://evil.example/x');
  });

  it('links to the resubmit form prefilled with exactly the rejected values', () => {
    const built = buildChangeRequestDecidedMemberEmail(base);
    expect(built.html).toContain('/portal/edit?resubmit=00000000-0000-4000-8000-000000000001');
    expect(built.text).toContain('/portal/edit?resubmit=00000000-0000-4000-8000-000000000001');
  });

  it('an all-approved decision carries no resubmit link and no reason block', () => {
    const built = buildChangeRequestDecidedMemberEmail({ ...base, outcome: 'approved', reason: null, fields: [{ key: 'phone', proposed: '+66899999999', outcome: 'approved' }] });
    expect(built.html).not.toContain('resubmit=');
    expect(built.text).not.toMatch(/reason/i);
  });

  it('never names the reviewer — the decision comes from the organisation', () => {
    const built = buildChangeRequestDecidedMemberEmail(base);
    expect(built.html).not.toContain('Sven Reviewer');
    expect(built.text).not.toContain('Sven Reviewer');
    expect(built.text).toContain('SweCham');
  });

  it('carries only subject/html/text', () => {
    expect(Object.keys(buildChangeRequestDecidedMemberEmail(base)).sort()).toEqual(['html', 'subject', 'text']);
  });
});
