/**
 * 122 US5b-2 (T579) — the edit page's notification-language card on AURA
 * (board `Admin-member-edit`): an AURA card holding a RadioGroup named
 * "Notification language", its hint saying it is saved on its own, and a
 * secondary "Save preference" that PATCHes the same route as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { AdminPreferredLocaleCard } = await import('@/components/admin/admin-preferred-locale-card');

const L = enMessages.admin.membersPreferredLocale;

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderCard(initialValue: 'en' | 'th' | 'sv' | null = null) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AdminPreferredLocaleCard memberId="m-1" initialValue={initialValue} />
    </NextIntlClientProvider>,
  );
}

describe('AdminPreferredLocaleCard (AURA)', () => {
  it('is an AURA card with the language radio group, its hint saying it saves on its own', () => {
    const { container } = renderCard('th');
    expect(container.querySelector('.aura-card')).not.toBeNull();
    const group = screen.getByRole('group', { name: L.title });
    expect(within(group).getAllByRole('radio')).toHaveLength(4);
    expect(within(group).getByRole('radio', { name: enMessages.common.languageOptions.th })).toBeChecked();
    expect(group).toHaveAccessibleDescription(`${L.description} ${L.savedSeparately}`);
    expect(screen.getByRole('button', { name: L.save })).toHaveClass('aura-btn--secondary');
  });

  it('saves the picked language to the same route', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    renderCard(null);
    fireEvent.click(screen.getByRole('radio', { name: enMessages.common.languageOptions.sv }));
    fireEvent.click(screen.getByRole('button', { name: L.save }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/admin/members/m-1/preferred-locale');
    expect(init).toMatchObject({ method: 'PATCH', body: JSON.stringify({ preferredLocale: 'sv' }) });
  });
});
