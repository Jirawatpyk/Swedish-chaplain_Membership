/**
 * PR-B task 6 — Address section: the postcode FILTERS, it never overwrites.
 *
 * Of 955 Thai postal codes, 781 map to one district, 144 to two, 26 to
 * three, 4 to four — and 8 span two provinces. An autofill that guesses is
 * wrong by construction, so the four cases below are the whole point:
 *   1. Unambiguous code (single district, single sub-district) → province,
 *      district AND sub-district are set; an "auto-filled" hint with an
 *      Undo appears; the live region announces it.
 *   2. Ambiguous district (multiple districts, one province) → NOTHING is
 *      set; the district combobox narrows to the candidates; the live
 *      region announces the count.
 *   3. Multi-province code → NOTHING is set; the province combobox narrows
 *      to the candidates.
 *   4. Unknown code (404) → nothing is set, no block, a hint invites manual
 *      entry.
 * Plus: picking a district from an ambiguous set narrows the sub-district
 * combobox to that district's candidates.
 *
 * Rendered against the REAL en.json (not a key-echo mock) so the live-region
 * / hint copy assertions are meaningful. `fetch` is mocked per-test — this
 * suite never talks to the real /api/geo/postal/[code] route or imports the
 * server-only dataset. Same jsdom workarounds as combobox-a11y.test.tsx /
 * country-combobox.test.tsx (real timers, ResizeObserver + scrollIntoView
 * stubs) since this opens the real Popover + cmdk stack.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MemberForm, type PlanOption } from '@/components/members/member-form';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const PLANS: PlanOption[] = [
  { plan_id: 'premium', plan_year: 2026, display_name: 'Premium — 2026' },
];

type Name = { readonly th: string; readonly en: string };
type Candidate = {
  readonly subDistrict: Name;
  readonly district: Name;
  readonly province: Name;
};

const UNAMBIGUOUS: Candidate[] = [
  {
    subDistrict: { th: 'วังใหม่', en: 'Wang Mai' },
    district: { th: 'เขตปทุมวัน', en: 'Pathum Wan' },
    province: { th: 'กรุงเทพมหานคร', en: 'Bangkok' },
  },
];

// Mirrors the shape of the real 10110 (2 districts, 1 province) without
// depending on the real dataset — this suite mocks fetch, it never imports
// the server-only lookup module.
const AMBIGUOUS_DISTRICT: Candidate[] = [
  {
    subDistrict: { th: 'คลองตัน', en: 'Khlong Tan' },
    district: { th: 'เขตคลองเตย', en: 'Khlong Toei' },
    province: { th: 'กรุงเทพมหานคร', en: 'Bangkok' },
  },
  {
    subDistrict: { th: 'คลองเตย', en: 'Khlong Toei' },
    district: { th: 'เขตคลองเตย', en: 'Khlong Toei' },
    province: { th: 'กรุงเทพมหานคร', en: 'Bangkok' },
  },
  {
    subDistrict: { th: 'คลองตันเหนือ', en: 'Khlong Tan Nuea' },
    district: { th: 'เขตวัฒนา', en: 'Watthana' },
    province: { th: 'กรุงเทพมหานคร', en: 'Bangkok' },
  },
];

// Mirrors the real 13240 (spans two provinces).
const MULTI_PROVINCE: Candidate[] = [
  {
    subDistrict: { th: 'บ้านกลึง', en: 'Ban Klueng' },
    district: { th: 'อำเภอบางปะหัน', en: 'Bang Pahan' },
    province: { th: 'พระนครศรีอยุธยา', en: 'Phra Nakhon Si Ayutthaya' },
  },
  {
    subDistrict: { th: 'ชอนม่วง', en: 'Chon Muang' },
    district: { th: 'อำเภอบ้านหมี่', en: 'Ban Mi' },
    province: { th: 'ลพบุรี', en: 'Lopburi' },
  },
];

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

function liveRegionText(): string {
  return document.querySelector('[role="status"]')?.textContent ?? '';
}

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MemberForm
        plans={PLANS}
        defaultPlanYear={2026}
        onSubmit={vi.fn()}
        submitting={false}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useFakeTimers({
    now: new Date('2026-04-09T12:00:00.000Z'),
    shouldAdvanceTime: false,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
});

describe('AddressSection — the live region mounts empty from the start', () => {
  it('renders an empty role="status" live region before any postcode is typed', () => {
    renderForm();
    const region = document.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe('');
  });

  it('states the SC 3.3.2 instruction up front on the postcode field', () => {
    renderForm();
    expect(
      screen.getByText(/entering a postcode fills province, district and sub-district/i),
    ).toBeInTheDocument();
  });
});

describe('AddressSection — case 1: unambiguous postcode', () => {
  it('sets province, district AND sub-district, shows an auto-filled hint with Undo, and announces it', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/geo/postal/10330') return jsonResponse({ candidates: UNAMBIGUOUS });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.change(byId('postal_code'), { target: { value: '10330' } });

    await waitFor(
      () => expect(fetchMock).toHaveBeenCalledWith('/api/geo/postal/10330', expect.anything()),
      { timeout: 3000 },
    );

    await waitFor(() => expect(byId('province')).toHaveTextContent('กรุงเทพมหานคร'), {
      timeout: 3000,
    });
    expect(byId('city')).toHaveTextContent('เขตปทุมวัน');
    expect(byId('sub_district')).toHaveTextContent('วังใหม่');

    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
    await waitFor(() => expect(liveRegionText()).toMatch(/auto-filled/i));
  });

  it('Undo reverts all three fields and hides the hint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ candidates: UNAMBIGUOUS }));
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.change(byId('postal_code'), { target: { value: '10330' } });
    await waitFor(() => expect(byId('province')).toHaveTextContent('กรุงเทพมหานคร'), {
      timeout: 3000,
    });

    fireEvent.click(screen.getByRole('button', { name: /undo/i }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /undo/i })).toBeNull());
    expect(byId('province')).not.toHaveTextContent('กรุงเทพมหานคร');
    expect(byId('city')).not.toHaveTextContent('เขตปทุมวัน');
    expect(byId('sub_district')).not.toHaveTextContent('วังใหม่');
  });

  it('hides the Undo hint once the admin edits the postcode away from the code it refers to', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/geo/postal/10330') return jsonResponse({ candidates: UNAMBIGUOUS });
      return jsonResponse({ error: { code: 'postal_code_not_found' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.change(byId('postal_code'), { target: { value: '10330' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument(), {
      timeout: 3000,
    });

    // The admin keeps typing (postcode no longer reads 10330) — the stale
    // hint must disappear immediately, without waiting for the next lookup
    // to resolve, and WITHOUT touching the values it already set.
    fireEvent.change(byId('postal_code'), { target: { value: '10339' } });
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    expect(byId('province')).toHaveTextContent('กรุงเทพมหานคร');
  });
});

describe('AddressSection — case 2: ambiguous district (single province)', () => {
  it('sets NOTHING, narrows the district combobox to the candidates, and announces the count', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ candidates: AMBIGUOUS_DISTRICT }));
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.change(byId('postal_code'), { target: { value: '10110' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 3000 });

    await waitFor(() => expect(liveRegionText()).toMatch(/2 districts match postcode 10110/i), {
      timeout: 3000,
    });

    // Nothing set — province/city/sub_district all still show their placeholder.
    expect(byId('province')).toHaveTextContent(/select a province/i);
    expect(byId('city')).toHaveTextContent(/select a district/i);
    expect(byId('sub_district')).toHaveTextContent(/select a sub-district/i);

    fireEvent.click(byId('city'));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('เขตคลองเตย')).toBeInTheDocument();
    expect(within(listbox).getByText('เขตวัฒนา')).toBeInTheDocument();
  });
});

describe('AddressSection — case 3: multi-province postcode', () => {
  it('sets NOTHING and narrows the province combobox to the candidates', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ candidates: MULTI_PROVINCE }));
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.change(byId('postal_code'), { target: { value: '13240' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 3000 });

    await waitFor(() => expect(liveRegionText()).toMatch(/2 provinces match postcode 13240/i), {
      timeout: 3000,
    });

    expect(byId('province')).toHaveTextContent(/select a province/i);

    fireEvent.click(byId('province'));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('พระนครศรีอยุธยา')).toBeInTheDocument();
    expect(within(listbox).getByText('ลพบุรี')).toBeInTheDocument();
  });
});

describe('AddressSection — case 4: unknown postcode', () => {
  it('sets nothing, does not block, and shows a manual-entry hint', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: 'postal_code_not_found' } }, 404),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.change(byId('postal_code'), { target: { value: '99999' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 3000 });

    await waitFor(
      () => expect(screen.getByText(/no match for this postcode/i)).toBeInTheDocument(),
      { timeout: 3000 },
    );

    expect(byId('postal_code')).not.toHaveAttribute('aria-invalid', 'true');
    expect(byId('province')).toHaveTextContent(/select a province/i);
    expect(byId('city')).toHaveTextContent(/select a district/i);
  });
});

describe('AddressSection — plus: picking a district narrows sub-district options', () => {
  it('after choosing a district from an ambiguous set, the sub-district combobox narrows to that district', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ candidates: AMBIGUOUS_DISTRICT }));
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.change(byId('postal_code'), { target: { value: '10110' } });
    await waitFor(() => expect(liveRegionText()).toMatch(/districts match postcode 10110/i), {
      timeout: 3000,
    });

    fireEvent.click(byId('city'));
    let listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByText('เขตวัฒนา'));

    await waitFor(() => expect(byId('city')).toHaveTextContent('เขตวัฒนา'));

    fireEvent.click(byId('sub_district'));
    listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('คลองตันเหนือ')).toBeInTheDocument();
    expect(within(listbox).queryByText('คลองตัน')).toBeNull();
    expect(within(listbox).queryByText('คลองเตย')).toBeNull();
  });
});

describe('AddressSection — country ≠ TH falls back to plain manual fields', () => {
  it('renders plain text inputs for city/province/postal_code and never calls the lookup route', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm
          plans={PLANS}
          defaultPlanYear={2026}
          onSubmit={vi.fn()}
          submitting={false}
          initialValues={{ country: 'SE' }}
        />
      </NextIntlClientProvider>,
    );

    expect(byId('city').tagName).toBe('INPUT');
    expect(byId('province').tagName).toBe('INPUT');
    expect(document.getElementById('sub_district')).toBeNull();

    fireEvent.change(byId('postal_code'), { target: { value: '11122' } });
    // The debounced effect's own no-op reset (country ≠ TH) still schedules
    // and fires a timer — wrap the wait in act() so that state update is
    // flushed cleanly instead of warning "not wrapped in act(...)".
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AddressSection — edit mode never blocks; shows an incomplete-address banner instead', () => {
  it('shows a banner with a jump link when the address is incomplete on edit, and does not render it in create mode', () => {
    const { unmount } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm
          plans={PLANS}
          defaultPlanYear={2026}
          onSubmit={vi.fn()}
          submitting={false}
          mode="edit"
          initialValues={{ company_name: 'Acme', country: 'TH' }}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/address incomplete/i)).toBeInTheDocument();
    const link = screen.getByText(/complete the address/i).closest('a');
    expect(link).toHaveAttribute('href', '#address_line1');
    unmount();

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm plans={PLANS} defaultPlanYear={2026} onSubmit={vi.fn()} submitting={false} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText(/address incomplete/i)).toBeNull();
  });
});
