/**
 * Spec 122 T511 — the board-parity rule applied to the US1–US4 screens
 * (follow-up to US5a, docs/aura-adoption.md § "Board parity rule").
 *
 * Each block pins one screen's swap: AURA's own prop or component where one
 * exists (its output class present, the reach into AURA's internals gone),
 * and AURA's defaults where the only override was a board pixel value (the
 * override gone). What stays a stand-in is covered by the internal-class
 * ratchet (tests/unit/architecture/aura-internal-class-ratchet.test.ts).
 */
import { readFileSync } from 'node:fs';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LoadErrorCard } from '@/components/shell/load-error-card';
import { SecurityUpdateBanner } from '@/components/auth/security-update-banner';

const src = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const RAW_TEXT_PX = /\btext-\[\d+px\]/;

describe('US1 shell', () => {
  it('LoadErrorCard is an AURA Card, not its classes by hand', () => {
    const { container } = render(<LoadErrorCard message="Could not load" />);
    expect(container.querySelector('.aura-card > .aura-card__body [role="alert"]')).not.toBeNull();
    expect(src('src/components/shell/load-error-card.tsx')).not.toMatch(/aura-card/);
  });

  it.each([
    'src/components/layout/breadcrumb-nav.tsx',
    'src/components/layout/member-nav.tsx',
    'src/components/layout/member-header.tsx',
    'src/components/layout/staff-nav.tsx',
    'src/components/layout/staff-top-bar.tsx',
    'src/components/shell/locale-switcher.tsx',
    'src/components/shell/user-menu.tsx',
  ])('%s sizes its text on AURA’s type scale, not in raw px', (file) => {
    expect(src(file)).not.toMatch(RAW_TEXT_PX);
  });

  it('the breadcrumb back link is AURA’s 13px label', () => {
    expect(src('src/components/layout/breadcrumb-nav.tsx')).toContain('aura-text-label');
  });

  it('the staff nav count badge is AURA’s 11px pill label', () => {
    expect(src('src/components/layout/staff-nav.tsx')).toContain('aura-text-pill-label');
  });

  describe('globals.css leaves the shell’s sizes to AURA', () => {
    const css = src('src/app/globals.css');
    it.each([
      ['the collapsed rail (40px rows, 20px icons, 72px header)', /\.aura-nav--collapsed/],
      ['the 300px phone drawer', /\.aura-drawer--nav/],
      ['the 60px phone bar and 44px menu button', /\.aura-shell__(bar|menu)/],
      ['the bottom nav’s pill, label size and padding', /\.aura-bottomnav/],
    ])('no override of %s', (_, rule) => {
      expect(css).not.toMatch(rule);
    });

    it('keys the viewport ActionBar scroll padding on an app class, not AURA’s modifier', () => {
      expect(css).not.toMatch(/\.aura-actionbar--viewport/);
      expect(css).toMatch(/html:has\(\.chamber-viewport-actionbar\)/);
      expect(src('src/app/(staff)/admin/members/_components/bulk-action-bar.tsx')).toContain('chamber-viewport-actionbar');
    });
  });
});

describe('US2 auth', () => {
  it('the security-update banner is AURA’s info Alert, without a second live region', () => {
    // render() flushes the mount effect that fills the live region
    const { container, getByText } = render(<SecurityUpdateBanner message="Your password was changed." />);
    getByText('Your password was changed.');
    expect(container.querySelector('.aura-alert.aura-alert--info .aura-alert__text')).not.toBeNull();
    expect(container.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(1);
    expect(src('src/components/auth/security-update-banner.tsx')).not.toMatch(/aura-alert/);
  });

  it.each([
    'src/components/auth/auth-title.tsx',
    'src/components/auth/auth-frame.tsx',
    'src/components/auth/sign-in-form.tsx',
    'src/components/auth/forgot-password-form.tsx',
    'src/components/auth/reset-password-form.tsx',
    'src/components/auth/invite-redeem-form.tsx',
    'src/components/auth/email-change-revert-form.tsx',
  ])('%s sizes its text on the type scale, not in raw px', (file) => {
    expect(src(file)).not.toMatch(RAW_TEXT_PX);
  });

  it('the auth page title is the app’s shared h1 step, like every other page title', () => {
    expect(src('src/components/auth/auth-title.tsx')).toContain('text-(length:--font-size-h1)');
  });
});

/** An AURA class written onto a foreign element by hand (a lucide icon, a div), not AURA's component. */
const HAND_AURA_CLASS = /className=["'`{][^"'`]*\baura-(icon|card|alert)\b(?![-_])/;

describe('US3 portal home', () => {
  it.each([
    'src/app/(member)/portal/(home)/page.tsx',
    'src/app/(member)/portal/_components/recent-activity-section.tsx',
    'src/app/(member)/portal/_components/membership-invoice-alert.tsx',
    'src/components/portal/invoices-summary-card.tsx',
    'src/components/benefits/portal-benefits-summary-card.tsx',
    'src/components/portal/dashboard/stat-card.tsx',
  ])('%s takes AURA’s Icon / Card, not their classes by hand, and no raw px text', (file) => {
    const s = src(file);
    expect(s).not.toMatch(HAND_AURA_CLASS);
    expect(s).not.toMatch(RAW_TEXT_PX);
  });

  it('the marketing acknowledgement banner is AURA’s warning Alert inside its named region', async () => {
    const s = src('src/app/(member)/portal/_components/marketing-acknowledgement-banner-client.tsx');
    expect(s).toMatch(/<Alert[\s\S]*?tone="warning"/);
    expect(s).not.toMatch(/aura-alert/);
  });
});

describe('US3 portal benefits', () => {
  it.each([
    'src/components/benefits/portal-benefits-panel.tsx',
    'src/components/benefits/benefit-usage-card.tsx',
    'src/components/benefits/benefit-usage-skeleton.tsx',
    'src/components/benefits/under-use-warning.tsx',
  ])('%s takes AURA’s Icon / Card and the shared empty state, and no raw px text', (file) => {
    const s = src(file);
    expect(s).not.toMatch(HAND_AURA_CLASS);
    expect(s).not.toMatch(/aura-empty/);
    expect(s).not.toMatch(RAW_TEXT_PX);
  });

  it('the big used figure is AURA’s h2 step', () => {
    expect(src('src/components/benefits/portal-benefits-panel.tsx')).toMatch(/aura-text-h2[^"]*tabular-nums/);
  });
});

describe('US3 portal profile, directory and change requests', () => {
  it.each([
    'src/app/(member)/portal/profile/loading.tsx',
    'src/app/(member)/portal/profile/directory/loading.tsx',
    'src/app/(member)/portal/change-requests/loading.tsx',
    'src/components/members/portal-profile-view.tsx',
    'src/components/portal/back-link.tsx',
  ])('%s takes AURA’s Card / Icon (or the shared skeleton card), not their classes by hand', (file) => {
    expect(src(file)).not.toMatch(HAND_AURA_CLASS);
  });

  it.each([
    'src/components/members/portal-profile-view.tsx',
    'src/components/portal/back-link.tsx',
    'src/components/members/change-requests/change-request-history-view.tsx',
    'src/components/members/change-requests/pending-request-banner.tsx',
    'src/components/members/change-requests/portal-change-request-form.tsx',
    'src/components/members/portal-marketing-toggle.tsx',
    'src/components/directory/directory-logo-control.tsx',
    'src/components/directory/directory-listing-preview.tsx',
  ])('%s sizes its text on the type scale, not in raw px', (file) => {
    expect(src(file)).not.toMatch(RAW_TEXT_PX);
  });

  it('the plain change-request diff is AURA’s frameless Table, with no globals.css override', () => {
    expect(src('src/components/members/change-requests/change-request-diff-table.tsx')).toMatch(/<Table stackBelow="sm" bordered=\{false\}>/);
    expect(src('src/app/globals.css')).not.toMatch(/cr-diff--plain/);
  });

  it('the directory checkboxes keep AURA’s own touch rows (44px on coarse pointers)', () => {
    expect(src('src/components/directory/directory-visibility-form.tsx')).not.toMatch(/aura-check/);
  });
});

describe('US3 portal account', () => {
  it.each([
    'src/app/(member)/portal/account/loading.tsx',
    'src/components/data-export/data-export-panel.tsx',
  ])('%s takes AURA’s Card / Icon (or the shared skeleton card), not their classes by hand', (file) => {
    expect(src(file)).not.toMatch(HAND_AURA_CLASS);
  });

  it.each([
    'src/components/portal/portal-account-view.tsx',
    'src/components/members/invite-colleague-form.tsx',
    'src/components/data-export/data-export-panel.tsx',
  ])('%s sizes its text on the type scale, not in raw px', (file) => {
    expect(src(file)).not.toMatch(RAW_TEXT_PX);
  });

  it('the recent-exports table is AURA’s frameless, centred Table (5.13), with no reach into its classes', () => {
    const s = src('src/components/data-export/data-export-panel.tsx');
    expect(s).toMatch(/<Table[^>]*bordered=\{false\}/);
    expect(s).toMatch(/<Table[^>]*align="middle"/);
    expect(s).not.toMatch(/\[&_\.aura-|\[&_td\]|\[&_thead_th\]/);
  });

  it.each(['src/components/portal/preferred-locale-form.tsx', 'src/components/portal/contact-language-form.tsx'])(
    '%s keeps AURA’s own 44px touch rows',
    (file) => {
      expect(src(file)).not.toMatch(/aura-choice/);
    },
  );
});

describe('US3 portal timeline and not-found', () => {
  it.each([
    'src/components/members/timeline-skeleton.tsx',
    'src/app/(member)/portal/not-found.tsx',
  ])('%s takes AURA’s Card / Icon (or the shared skeleton card), not their classes by hand', (file) => {
    expect(src(file)).not.toMatch(HAND_AURA_CLASS);
  });

  it('the timeline stream sizes its caption and group headings on the type scale', () => {
    expect(src('src/components/members/timeline-stream.tsx')).not.toMatch(RAW_TEXT_PX);
  });

  it('the not-found card keeps AURA’s card padding', () => {
    expect(src('src/app/(member)/portal/not-found.tsx')).not.toMatch(/\bp-8\b/);
  });
});

describe('US4 portal invoices and pay sheet', () => {
  const PAY = 'src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet';
  it.each([
    'src/app/(member)/portal/credit-notes/[creditNoteId]/page.tsx',
    'src/app/(member)/portal/invoices/[invoiceId]/not-found.tsx',
    `${PAY}/method-tabs.tsx`,
  ])('%s takes AURA’s Icon, not its class by hand', (file) => {
    expect(src(file)).not.toMatch(HAND_AURA_CLASS);
    expect(src(file)).not.toMatch(/className="aura-icon/);
  });

  it('the method tabs keep AURA’s panel spacing', () => {
    expect(src(`${PAY}/method-tabs.tsx`)).not.toMatch(/aura-tabs/);
  });

  it.each([`${PAY}/index.tsx`, 'src/app/test-fixtures/aura-portal/pay-preview.tsx'])(
    '%s sizes the drawer close button through AURA’s closeProps, not its classes',
    (file) => {
      expect(src(file)).not.toMatch(/aura-icon-btn/);
    },
  );

  it.each([`${PAY}/card-form.tsx`, `${PAY}/hard-cap-prompt.tsx`, `${PAY}/confirmation-panel.tsx`])(
    '%s leaves AURA’s 44px md buttons at their own height (no raw px)',
    (file) => {
      expect(src(file)).not.toMatch(/min-h-\[44px\]/);
    },
  );

  it('the invoices card drops only a no-op body padding reach', () => {
    expect(src('src/app/(member)/portal/invoices/page.tsx')).not.toMatch(/aura-card\\_\\_body/);
  });
});
