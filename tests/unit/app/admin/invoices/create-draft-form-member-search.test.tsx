/**
 * #82 — the new-invoice member picker searches the server once the page
 * preloaded a full page of members (the directory read's 100-row clamp), so a
 * member past the first 100 can be picked; below that it filters locally.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CreateDraftForm } from '@/app/(staff)/admin/invoices/_components/invoice-form';

const NOTE = { selector: '.aura-combo__note' } as const;
const picker = enMessages.admin.invoices.form.memberPicker as Record<string, string>;
const plans = [
  { planId: 'regular', label: 'Regular Corporate', annualFeeMinorUnits: 3600000 },
  { planId: 'start_up', label: 'Start-up', annualFeeMinorUnits: 1200000 },
];
const preload = [
  { memberId: 'm-1', label: 'Acme (Regular Corporate / 2026)', currentPlanId: 'regular', currentPlanYear: 2026 },
];
const late = { member_id: 'm-110', company_name: 'Zeta Trading', plan_id: 'start_up', plan_year: 2026 };

function renderForm(memberSearchEnabled: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CreateDraftForm members={preload} plans={plans} memberSearchEnabled={memberSearchEnabled} />
    </NextIntlClientProvider>,
  );
}

function stubFetch(search: (url: URL) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://app.test');
    if (url.pathname === '/api/members') return search(url);
    if (url.pathname.startsWith('/api/invoices/member-renewal-context')) {
      return new Response(JSON.stringify({ classification: { kind: 'new' } }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const listOf = (items: unknown[]) => new Response(JSON.stringify({ items, next_cursor: null }), { status: 200 });
const searchCalls = (fn: ReturnType<typeof stubFetch>) =>
  fn.mock.calls.map((c) => new URL(String(c[0]), 'https://app.test')).filter((u) => u.pathname === '/api/members');

function typeInPicker(text: string): HTMLInputElement {
  const input = document.getElementById('memberId') as HTMLInputElement;
  fireEvent.click(input);
  fireEvent.change(input, { target: { value: text } });
  return input;
}

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

describe('CreateDraftForm — the member picker searches the server (#82)', () => {
  it('typing searches once after the debounce, and a member outside the preload can be picked with its plan', async () => {
    const fn = stubFetch(() => listOf([late]));
    renderForm(true);
    typeInPicker('Zeta');
    const option = await screen.findByRole('option', { name: 'Zeta Trading (Start-up / 2026)' });
    const calls = searchCalls(fn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.searchParams.get('q')).toBe('Zeta');
    expect(calls[0]?.searchParams.get('status')).toBe('active,inactive');
    expect(calls[0]?.searchParams.get('limit')).toBe('25');
    fireEvent.click(option);
    expect(document.getElementById('memberId')).toHaveValue('Zeta Trading (Start-up / 2026)');
    expect(screen.getByText('Start-up')).toBeInTheDocument();
  });

  it('shows the searching text while the request runs, and the failed text when it fails', async () => {
    let release: (r: Response) => void = () => {};
    stubFetch(() => new Promise<Response>((r) => (release = r)));
    const { unmount } = renderForm(true);
    typeInPicker('Zeta');
    expect(await screen.findByText(picker.searching ?? '<missing searching>', NOTE)).toBeInTheDocument();
    release(listOf([]));
    unmount();
    vi.unstubAllGlobals();
    stubFetch(() => new Response('{}', { status: 500 }));
    renderForm(true);
    typeInPicker('Zeta');
    expect(await screen.findByText(picker.searchFailed ?? '<missing searchFailed>', NOTE)).toBeInTheDocument();
  });

  it('with less than a full preload, typing filters locally and asks the server nothing', async () => {
    const fn = stubFetch(() => listOf([late]));
    renderForm(false);
    typeInPicker('Acme');
    expect(await screen.findByRole('option', { name: /Acme/ })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 400));
    expect(searchCalls(fn)).toHaveLength(0);
  });
});
