// @vitest-environment jsdom
/**
 * R105 (PR #692) — where a test copy's Unsubscribe link lands. The page says
 * it is a test and that the real link lets each recipient stop receiving the
 * chamber's E-Blasts; it changes nothing, so it has no form and no button.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/lib/broadcasts-route-helpers', () => ({ resolveTenantDisplayName: async () => 'SweCham' }));

const { default: TestCopyUnsubscribePage, generateMetadata } = await import('@/app/unsubscribe/test-copy/page');

afterEach(() => cleanup());

async function renderPage(lang?: string) {
  const ui = await TestCopyUnsubscribePage({ searchParams: Promise.resolve(lang === undefined ? {} : { lang }) });
  return render(ui);
}

describe('/unsubscribe/test-copy', () => {
  it.each([
    ['en', /This is a test copy/],
    ['th', /อีเมลทดสอบ/],
    ['sv', /testkopia/i],
  ] as const)('%s: says it is a test copy, in the copy\'s language', async (lang, heading) => {
    await renderPage(lang);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getByText(/SweCham/)).toBeInTheDocument();
  });

  it('falls back to English for a missing or unknown lang', async () => {
    await renderPage('xx');
    expect(screen.getByRole('heading', { level: 1, name: /This is a test copy/ })).toBeInTheDocument();
  });

  it('changes nothing: no form and no button', async () => {
    const { container } = await renderPage('en');
    expect(container.querySelector('form')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is never indexed', async () => {
    const meta = await generateMetadata({ searchParams: Promise.resolve({ lang: 'th' }) });
    expect(meta.robots).toMatchObject({ index: false, follow: false });
  });
});
