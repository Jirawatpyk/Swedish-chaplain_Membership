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
    expect(src('src/components/auth/auth-title.tsx')).toMatch(/\btext-h1\b/);
  });
});
