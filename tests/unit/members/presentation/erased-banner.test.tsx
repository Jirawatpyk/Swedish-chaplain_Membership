/**
 * #240 — after a successful erase the ⋯ menu unmounts with the refresh, so
 * the Erased banner that replaces it takes focus (WCAG 2.4.3). Only when the
 * erase dialog asked for it, for this member, recently, and once: a plain
 * visit to an erased member leaves focus where the browser puts it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ErasedBanner } from '@/components/members/erased-banner';
import { requestErasedBannerFocus, takeErasedBannerFocus } from '@/components/members/erased-banner-focus';

function renderBanner(memberId = 'm-1') {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
      <ErasedBanner memberId={memberId} erasedAtIso="2026-10-23T02:00:00.000Z" completed />
    </NextIntlClientProvider>,
  );
}

const banner = () => screen.getByRole('note');

describe('ErasedBanner focus after an erase (#240)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T02:00:00.000Z'));
    // Drain any request a previous case left.
    takeErasedBannerFocus('m-1');
  });
  afterEach(() => {
    cleanup();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });

  it('takes focus when the erase dialog asked for it for this member', () => {
    requestErasedBannerFocus('m-1');
    renderBanner();
    expect(banner()).toHaveFocus();
  });

  it('leaves focus alone on a plain visit', () => {
    renderBanner();
    expect(banner()).not.toHaveFocus();
  });

  it('ignores a request about another member', () => {
    requestErasedBannerFocus('m-2');
    renderBanner('m-1');
    expect(banner()).not.toHaveFocus();
  });

  it('ignores a request older than 10 seconds', () => {
    requestErasedBannerFocus('m-1');
    vi.setSystemTime(new Date('2026-10-23T02:00:11.000Z'));
    renderBanner();
    expect(banner()).not.toHaveFocus();
  });

  it('takes it once: the next visit stays put', () => {
    requestErasedBannerFocus('m-1');
    renderBanner();
    cleanup();
    renderBanner();
    expect(banner()).not.toHaveFocus();
  });
});
