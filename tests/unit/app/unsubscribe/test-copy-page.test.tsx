// @vitest-environment jsdom
/**
 * R105 (PR #692) — where a test copy's Unsubscribe link lands. The page says
 * it is a test and that the real link lets each recipient stop receiving the
 * chamber's E-Blasts; it changes nothing, so it has no form and no button.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/lib/broadcasts-route-helpers', () => ({ resolveTenantDisplayName: async () => 'SweCham' }));
vi.mock('@/lib/env', () => ({
  env: {
    tenant: { slug: 'swecham' },
    broadcasts: { privacyContactEmail: 'privacy@swecham.example', privacyPolicyUrl: undefined },
  },
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = {
    en: (await import('@/i18n/messages/en.json')).default,
    th: (await import('@/i18n/messages/th.json')).default,
    sv: (await import('@/i18n/messages/sv.json')).default,
  };
  return {
    getTranslations: async ({ locale, namespace }: { locale: 'en' | 'th' | 'sv'; namespace: string }) =>
      createTranslator({ locale, messages: messages[locale], namespace: namespace as never }),
  };
});

const { default: TestCopyUnsubscribePage, generateMetadata } = await import('@/app/unsubscribe/test-copy/page');

afterEach(() => cleanup());

async function renderPage(lang?: string) {
  const ui = await TestCopyUnsubscribePage({ searchParams: Promise.resolve(lang === undefined ? {} : { lang }) });
  return render(ui);
}

describe('/unsubscribe/test-copy', () => {
  it.each([
    ['en', /This email was a test copy/],
    ['th', /อีเมลฉบับนี้เป็นฉบับทดสอบ/],
    ['sv', /Det här mejlet var en testkopia/],
  ] as const)('%s: says it is a test copy, in the copy\'s language', async (lang, heading) => {
    await renderPage(lang);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getByText(/SweCham/)).toBeInTheDocument();
  });

  it('falls back to English for a missing or unknown lang', async () => {
    await renderPage('xx');
    expect(screen.getByRole('heading', { level: 1, name: /This email was a test copy/ })).toBeInTheDocument();
  });

  it('names a real way to opt out: the privacy inbox as a mailto link', async () => {
    await renderPage('th');
    const link = screen.getByRole('link', { name: 'privacy@swecham.example' });
    expect(link).toHaveAttribute('href', 'mailto:privacy@swecham.example');
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
