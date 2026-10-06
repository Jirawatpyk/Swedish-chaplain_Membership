/**
 * Spec 122 US9a (T905) — the relink dialog on AURA `Dialog` with a
 * server-searched `Combobox` in place of the command list:
 *
 * - "Relink" (`relink-button-{rid}`) opens an AURA dialog titled for the
 *   attendee;
 * - typing searches the same endpoint (`/api/admin/members/search?q=…&limit=10`)
 *   and lists the hits, minus the member the row is matched to now;
 * - picking a member POSTs the same body to the same route, toasts and
 *   refreshes;
 * - a pseudonymised row keeps the disallowed note (`relink-disallowed-{rid}`,
 *   the full sentence as its name) and no Relink button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import type { RelinkRegistrationDialogProps } from '@/components/events/relink-registration-dialog';

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: nav.refresh }),
  usePathname: () => '/admin/events/e1',
  useSearchParams: () => new URLSearchParams(),
}));
const toastMock = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

const { RelinkRegistrationDialog } = await import('@/components/events/relink-registration-dialog');

const r = en.admin.events.detail.relink;
const EVENT = '00000000-0000-4000-8000-000000000001';
const REG = '00000000-0000-4000-8000-0000000000aa';
const CURRENT = '00000000-0000-4000-8000-0000000000c1';
const ACME = '00000000-0000-4000-8000-0000000000c2';

function props(overrides: Partial<RelinkRegistrationDialogProps> = {}): RelinkRegistrationDialogProps {
  return {
    registrationId: REG as RelinkRegistrationDialogProps['registrationId'],
    eventId: EVENT as RelinkRegistrationDialogProps['eventId'],
    attendeeName: 'Ploy Rattanakul',
    attendeeEmail: 'ploy.r@gmail.example' as RelinkRegistrationDialogProps['attendeeEmail'],
    currentMatchedMemberId: CURRENT as RelinkRegistrationDialogProps['currentMatchedMemberId'],
    isPseudonymised: false,
    ...overrides,
  };
}

function renderDialog(p: RelinkRegistrationDialogProps = props()) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <RelinkRegistrationDialog {...p} />
    </NextIntlClientProvider>,
  );
}

const json = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('relink dialog (AURA Dialog + Combobox)', () => {
  it('opens an AURA dialog titled for the attendee from the Relink button', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId(`relink-button-${REG}`));
    screen.getByRole('dialog', { name: r.dialogTitle.replace('{attendee}', 'Ploy Rattanakul') });
    expect(document.querySelector('.aura-dialog')).not.toBeNull();
    expect(screen.getByRole('combobox', { name: r.searchSrLabel }).closest('.aura-combobox')).not.toBeNull();
  });

  it('searches the same endpoint, hides the current match, and posts the same body on a pick', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/admin/members/search')) {
        return json({
          items: [
            { memberId: CURRENT, companyName: 'Siam Nordic Trading', primaryContactName: null },
            { memberId: ACME, companyName: 'Acme Thai Co., Ltd.', primaryContactName: 'Anna Acme' },
          ],
        });
      }
      if (init?.method === 'POST') {
        return json({
          noop: false,
          registrationId: REG,
          previousMatchedMemberId: CURRENT,
          newMatchedMemberId: ACME,
          previousMatchType: 'member_fuzzy',
          newMatchType: 'member_contact',
          quotaImpact: { creditedBackFor: null, decrementedFor: null, scopes: [] },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    renderDialog();
    fireEvent.click(screen.getByTestId(`relink-button-${REG}`));
    const box = screen.getByRole('combobox', { name: r.searchSrLabel });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'acme' } });
    act(() => vi.runOnlyPendingTimers());
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/members/search?q=acme&limit=10',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining('Acme Thai Co., Ltd.')]);
    fireEvent.click(options[0]!);
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/events/${EVENT}/registrations/${REG}/relink`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ newMatchedMemberId: ACME }) }),
    );
    expect(toastMock.success).toHaveBeenCalledWith(r.successToast.replace('{companyName}', 'Acme Thai Co., Ltd.'));
    expect(nav.refresh).toHaveBeenCalled();
  });

  it('keeps the disallowed note for a pseudonymised row, with no Relink button', () => {
    renderDialog(props({ isPseudonymised: true }));
    const note = screen.getByTestId(`relink-disallowed-${REG}`);
    expect(note).toHaveAttribute('aria-label', r.disallowedPseudonymised);
    expect(note).toHaveTextContent(r.disallowedShort);
    expect(screen.queryByTestId(`relink-button-${REG}`)).toBeNull();
  });

  it('draws Relink as an AURA secondary button', () => {
    renderDialog();
    expect(screen.getByTestId(`relink-button-${REG}`)).toHaveClass('aura-btn--secondary');
  });
});
