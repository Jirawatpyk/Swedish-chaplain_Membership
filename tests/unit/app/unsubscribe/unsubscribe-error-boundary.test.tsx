// @vitest-environment jsdom
/**
 * The unsubscribe page's last-resort error boundary must still give the
 * recipient a free, usable way to object (GDPR Art. 12(2), Art. 21): the
 * monitored privacy inbox as a mailto link, in the recipient's language.
 * It is a client component (no env, no i18n loader), so the segment layout
 * hands it the address + locale through context.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import UnsubscribeErrorBoundary from '@/app/unsubscribe/[token]/error';
import { UnsubscribeContactProvider } from '@/app/unsubscribe/[token]/unsubscribe-contact-context';

afterEach(() => {
  cleanup();
});

function renderBoundary(locale?: 'en' | 'th' | 'sv') {
  const boundary = <UnsubscribeErrorBoundary error={new Error('boom')} reset={vi.fn()} />;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return render(
    locale === undefined ? (
      boundary
    ) : (
      <UnsubscribeContactProvider email="privacy@swecham.example" locale={locale}>
        {boundary}
      </UnsubscribeContactProvider>
    ),
  );
}

describe('unsubscribe error boundary', () => {
  it.each([
    ['en', /Temporary error/],
    ['th', /ระบบขัดข้องชั่วคราว/],
    ['sv', /Tillfälligt fel/],
  ] as const)('%s: heading in the recipient language + the privacy inbox as mailto', (locale, heading) => {
    renderBoundary(locale);
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'privacy@swecham.example' });
    expect(link).toHaveAttribute('href', 'mailto:privacy@swecham.example');
  });

  it('without the layout context it still renders (EN, no address) — never throws', () => {
    renderBoundary();
    expect(screen.getByRole('heading', { name: /Temporary error/ })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
