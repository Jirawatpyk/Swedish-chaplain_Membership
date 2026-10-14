/**
 * Spec 122 US10a (T1005) — the member picker on AURA's Combobox with
 * server search. The request is today's (`/api/members?limit=20&status=active
 * &q=`, debounced 200 ms); a pick hands back the member id, the clear button
 * hands back null, and a failed load says so instead of "No members found".
 * (Replaces the cmdk `aria-controls` tests: AURA's Combobox owns that wiring.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { MemberPicker } from '@/components/members/member-picker';

const l = en.admin.users.invite.linkMember;

const json = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);

const ROWS = [
  { member_id: 'm-1', company_name: 'Siam Nordic Trading Co., Ltd.', country: 'TH', status: 'active' },
  { member_id: 'm-2', company_name: 'Acme Thai Co., Ltd.', country: 'SE', status: 'active' },
];

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => json({ items: ROWS }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function renderPicker(props: Partial<React.ComponentProps<typeof MemberPicker>> = {}) {
  const onChange = vi.fn();
  const view = render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MemberPicker label={l.label} hint={l.helpText} value={null} onChange={onChange} {...props} />
    </NextIntlClientProvider>,
  );
  return { onChange, ...view };
}

const box = () => screen.getByRole('combobox', { name: l.label });

describe('<MemberPicker> on AURA Combobox', () => {
  it('is an AURA combobox named by its label and described by the hint', () => {
    renderPicker();
    expect(box().closest('.aura-combo')).not.toBeNull();
    expect(box()).toHaveAccessibleDescription(expect.stringContaining(l.helpText));
  });

  it('searches active members with the typed text, after the debounce', async () => {
    renderPicker();
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'acme' } });
    act(() => vi.advanceTimersByTime(250));
    await flush();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/members?limit=20&status=active&q=acme',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'application/json' } }),
    );
  });

  it('a pick hands back the member id', async () => {
    const { onChange } = renderPicker();
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'acme' } });
    act(() => vi.advanceTimersByTime(250));
    await flush();
    fireEvent.click(screen.getByRole('option', { name: /Acme Thai Co\., Ltd\./ }));
    expect(onChange).toHaveBeenLastCalledWith('m-2');
  });

  it('shows the chosen company, and the clear button hands back null', async () => {
    const { onChange, rerender } = renderPicker();
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'siam' } });
    act(() => vi.advanceTimersByTime(250));
    await flush();
    fireEvent.click(screen.getByRole('option', { name: /Siam Nordic/ }));
    rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <MemberPicker label={l.label} hint={l.helpText} value="m-1" onChange={onChange} />
      </NextIntlClientProvider>,
    );
    expect(box()).toHaveValue('Siam Nordic Trading Co., Ltd.');
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('says the load failed rather than "No members found"', async () => {
    fetchMock.mockImplementation(() => json({}, 500));
    renderPicker();
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'x' } });
    act(() => vi.advanceTimersByTime(250));
    await flush();
    expect(screen.getByText(l.fetchError)).toBeInTheDocument();
    expect(screen.queryByText(l.noMembersFound)).not.toBeInTheDocument();
  });

  it('is disabled when told to be, and fetches nothing', async () => {
    renderPicker({ disabled: true });
    expect(box()).toBeDisabled();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // AURA 5.38 (handoff #141): 44px box and inner buttons below 640px or on
  // touch, level with the invite dialog's other fields.
  it("takes AURA's touch height", () => {
    renderPicker();
    expect(box().closest('.aura-field')).toHaveClass('is-touch');
  });
});
