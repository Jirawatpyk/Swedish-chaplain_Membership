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
import { StrictMode } from 'react';
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
  it('sets province, district AND sub-district (stored as ENGLISH — see file-header comment), shows an auto-filled hint with Undo, and announces it', async () => {
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

    await waitFor(() => expect(byId('province')).toHaveTextContent('Bangkok'), {
      timeout: 3000,
    });
    expect(byId('city')).toHaveTextContent('Pathum Wan');
    expect(byId('sub_district')).toHaveTextContent('Wang Mai');

    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
    await waitFor(() => expect(liveRegionText()).toMatch(/auto-filled/i));
  });

  it('Undo reverts all three fields and hides the hint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ candidates: UNAMBIGUOUS }));
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.change(byId('postal_code'), { target: { value: '10330' } });
    await waitFor(() => expect(byId('province')).toHaveTextContent('Bangkok'), {
      timeout: 3000,
    });

    fireEvent.click(screen.getByRole('button', { name: /undo/i }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /undo/i })).toBeNull());
    expect(byId('province')).not.toHaveTextContent('Bangkok');
    expect(byId('city')).not.toHaveTextContent('Pathum Wan');
    expect(byId('sub_district')).not.toHaveTextContent('Wang Mai');
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
    expect(byId('province')).toHaveTextContent('Bangkok');
  });
});

describe('AddressSection — the picker STORES English, Thai is secondary text only (PR-B language reversal: ประกาศอธิบดีฯ ฉบับที่ 92 pre-approves English + THB tax invoices; TSCC corpus is 132/132 English addresses)', () => {
  it('picking an unambiguous TH postcode stores the English province/district/sub-district, and the Thai name appears in the picker as secondary text', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/geo/postal/10330') return jsonResponse({ candidates: UNAMBIGUOUS });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.change(byId('postal_code'), { target: { value: '10330' } });

    // The STORED (and displayed, primary-label) value is English.
    await waitFor(() => expect(byId('province')).toHaveTextContent('Bangkok'), {
      timeout: 3000,
    });
    expect(byId('city')).toHaveTextContent('Pathum Wan');
    expect(byId('sub_district')).toHaveTextContent('Wang Mai');
    // ...never the Thai name — it must not leak into the trigger's primary
    // label.
    expect(byId('province')).not.toHaveTextContent('กรุงเทพมหานคร');

    // Thai is demoted to secondary `detail` text inside the picker, not
    // dropped — open each combobox and confirm both texts are present.
    fireEvent.click(byId('province'));
    let listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Bangkok')).toBeInTheDocument();
    expect(within(listbox).getByText('กรุงเทพมหานคร')).toBeInTheDocument();
    fireEvent.keyDown(listbox, { key: 'Escape' });

    fireEvent.click(byId('city'));
    listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Pathum Wan')).toBeInTheDocument();
    expect(within(listbox).getByText('เขตปทุมวัน')).toBeInTheDocument();
    fireEvent.keyDown(listbox, { key: 'Escape' });

    fireEvent.click(byId('sub_district'));
    listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Wang Mai')).toBeInTheDocument();
    expect(within(listbox).getByText('วังใหม่')).toBeInTheDocument();
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

    // The primary (stored) option label is English; the district's Thai
    // name is available as secondary `detail` text on the same option.
    fireEvent.click(byId('city'));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Khlong Toei')).toBeInTheDocument();
    expect(within(listbox).getByText('Watthana')).toBeInTheDocument();
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

    // English is the primary (stored) option label; Thai renders as
    // secondary `detail` text.
    fireEvent.click(byId('province'));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Phra Nakhon Si Ayutthaya')).toBeInTheDocument();
    expect(within(listbox).getByText('Lopburi')).toBeInTheDocument();
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

    // Click the ENGLISH option label — that is the primary, selectable
    // (and stored) text now; Thai is secondary `detail` text on the item.
    fireEvent.click(byId('city'));
    let listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByText('Watthana'));

    await waitFor(() => expect(byId('city')).toHaveTextContent('Watthana'));

    fireEvent.click(byId('sub_district'));
    listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Khlong Tan Nuea')).toBeInTheDocument();
    expect(within(listbox).getByText('คลองตันเหนือ')).toBeInTheDocument();
    expect(within(listbox).queryByText('Khlong Tan')).toBeNull();
    expect(within(listbox).queryByText('Khlong Toei')).toBeNull();
    expect(within(listbox).queryByText('คลองตัน')).toBeNull();
    expect(within(listbox).queryByText('คลองเตย')).toBeNull();
  });
});

describe('AddressSection — country ≠ TH falls back to plain manual fields', () => {
  it('renders plain text inputs for city/province/postal_code and never calls the lookup route', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(
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
    unmount();
  });

  // Task 6 data-path review fix: the reason the `!countryIsTH` branch calls
  // `setValue('sub_district', '', { shouldDirty: true })` is that
  // `create-member-client.tsx`'s `toPayload` forwards `sub_district`
  // unconditionally — a stale Thai sub-district would otherwise ride along
  // on a switched-to-non-TH member's POST. The test above only proved the
  // WIDGET unmounts; it never asserted the underlying form VALUE actually
  // clears. Seed a TH address WITH a sub_district, switch country away from
  // TH through the real UI, and read the value back via a submitted payload
  // (the field itself is gone from the DOM once non-TH, so this is the only
  // way to observe it).
  it('clears the stale sub_district VALUE (not just the widget) when the country is switched away from TH', async () => {
    // I1 fix: the mount run now fetches (to populate candidate lists on the
    // Edit form — see the effect's I1 docblock), so this needs a real
    // response instead of the old no-op `vi.fn()` (which relied on the
    // mount fetch never happening at all).
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/geo/postal/10330') return jsonResponse({ candidates: UNAMBIGUOUS });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSubmit = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm
          plans={PLANS}
          defaultPlanYear={2026}
          onSubmit={onSubmit}
          submitting={false}
          mode="edit"
          initialValues={{
            company_name: 'Acme',
            country: 'TH',
            plan_id: 'premium',
            address_line1: '99 Nimman Rd',
            postal_code: '10330',
            province: 'เชียงใหม่',
            city: 'อำเภอเมืองเชียงใหม่',
            sub_district: 'ศรีภูมิ',
            primary_contact: {
              first_name: 'A',
              last_name: 'B',
              email: 'a@b.com',
              preferred_language: 'en',
            },
          }}
        />
      </NextIntlClientProvider>,
    );

    expect(byId('sub_district')).toHaveTextContent('ศรีภูมิ');

    // Let the mount-time lookup settle deterministically BEFORE switching
    // country, so the fetch-count assertion below isn't a race against the
    // 300ms debounce. Nothing is written by it (I1 anti-overwrite guarantee
    // — proven directly above and by the dedicated I1 mount-run suite).
    await waitFor(
      () => expect(fetchMock).toHaveBeenCalledWith('/api/geo/postal/10330', expect.anything()),
      { timeout: 3000 },
    );

    fireEvent.click(byId('country'));
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByText('Sweden'));

    // The widget unmounts on the very next render...
    await waitFor(() => expect(document.getElementById('sub_district')).toBeNull());

    // ...but the underlying RHF value only clears once the debounced
    // effect's non-TH branch actually runs — give it the full window.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    // The country-switch run's `!countryIsTH` branch returns BEFORE any
    // fetch — total calls across the whole flow stay at the single
    // mount-time lookup above.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.submit(document.querySelector('form') as HTMLFormElement);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.sub_district).toBe('');
  });
});

describe('AddressSection — edit mode must not AUTO-FILL/announce on mount, but the lookup still runs (I1 fix, Critical 2 regression scope preserved)', () => {
  it('DOES fetch and populate candidates for a pre-populated resolvable postcode, but writes/announces/dirties nothing', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/geo/postal/10330') return jsonResponse({ candidates: UNAMBIGUOUS });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    // "nothing is dirty" proxy: member-form.tsx only registers the
    // `beforeunload` unsaved-changes guard once RHF's `isDirty` flips true
    // (see member-form.tsx's own comment on why `isDirty` must be read at
    // component top level). If the mount run silently wrote a field via
    // `setValue({ shouldDirty: true })`, this listener would be registered.
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm
          plans={PLANS}
          defaultPlanYear={2026}
          onSubmit={vi.fn()}
          submitting={false}
          mode="edit"
          initialValues={{
            company_name: 'Acme',
            country: 'TH',
            address_line1: '99 Nimman Rd',
            postal_code: '10330',
            // Deliberately a DIFFERENT (but real) Thai address than what
            // 10330 resolves to (UNAMBIGUOUS = Bangkok/Pathum Wan/Wang Mai)
            // so a silent overwrite is unmistakable if the bug reproduces.
            province: 'เชียงใหม่',
            city: 'อำเภอเมืองเชียงใหม่',
            sub_district: 'ศรีภูมิ',
          }}
        />
      </NextIntlClientProvider>,
    );

    // I1 fix: the mount run now DOES fetch — this is the whole point (the
    // option lists must populate on the Edit form). RED against the
    // pre-fix code (which skipped the fetch entirely on mount) needs this
    // assertion to actually observe the regression.
    await waitFor(
      () => expect(fetchMock).toHaveBeenCalledWith('/api/geo/postal/10330', expect.anything()),
      { timeout: 3000 },
    );
    // Let the resolved fetch's `.then` chain finish applying `setCandidates`.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Anti-overwrite guarantee (Critical 2 / a11y re-review) — nothing
    // written, nothing announced, nothing dirtied, no Undo affordance.
    expect(liveRegionText()).toBe('');
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    expect(byId('province')).toHaveTextContent('เชียงใหม่');
    expect(byId('city')).toHaveTextContent('อำเภอเมืองเชียงใหม่');
    expect(byId('sub_district')).toHaveTextContent('ศรีภูมิ');
    expect(addEventListenerSpy).not.toHaveBeenCalledWith(
      'beforeunload',
      expect.any(Function),
    );

    // But the candidate list IS populated — the province combobox offers
    // the fetched postcode's province (Bangkok) alongside the admin's own
    // current value (เชียงใหม่), proving the option list narrowed instead
    // of staying empty.
    fireEvent.click(byId('province'));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Bangkok')).toBeInTheDocument();
    expect(within(listbox).getByText('เชียงใหม่')).toBeInTheDocument();
  });
});

describe('AddressSection — edit mode must not AUTO-FILL/announce on mount under React StrictMode (a11y re-review, dev-server-visible regression)', () => {
  it('fetches exactly ONCE (not twice) on the StrictMode setup→cleanup→setup mount replay, and still writes/announces nothing', async () => {
    // Same fixture as the plain (non-StrictMode) test above — a
    // pre-populated, resolvable postcode paired with a DIFFERENT real Thai
    // address, so a silent overwrite is unmistakable. The only difference
    // is the `<StrictMode>` wrapper: `next.config.ts`'s
    // `reactStrictMode: true` replays every effect once on mount (setup →
    // cleanup → setup again) on the dev server — which is where UAT runs
    // (:3100) — and RTL's plain `render()` does NOT reproduce that replay,
    // so the test above alone cannot catch a guard that only survives a
    // SINGLE setup, nor a double-fetch regression only StrictMode's replay
    // would expose.
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/geo/postal/10330') return jsonResponse({ candidates: UNAMBIGUOUS });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <StrictMode>
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <MemberForm
            plans={PLANS}
            defaultPlanYear={2026}
            onSubmit={vi.fn()}
            submitting={false}
            mode="edit"
            initialValues={{
              company_name: 'Acme',
              country: 'TH',
              address_line1: '99 Nimman Rd',
              postal_code: '10330',
              province: 'เชียงใหม่',
              city: 'อำเภอเมืองเชียงใหม่',
              sub_district: 'ศรีภูมิ',
            }}
          />
        </NextIntlClientProvider>
      </StrictMode>,
    );

    await waitFor(
      () => expect(fetchMock).toHaveBeenCalledWith('/api/geo/postal/10330', expect.anything()),
      { timeout: 3000 },
    );
    // Give any (incorrect) second fetch every chance to fire before
    // asserting the call count stayed at exactly one.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(liveRegionText()).toBe('');
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    expect(byId('province')).toHaveTextContent('เชียงใหม่');
    expect(byId('city')).toHaveTextContent('อำเภอเมืองเชียงใหม่');
    expect(byId('sub_district')).toHaveTextContent('ศรีภูมิ');
  });
});

describe('AddressSection — edit mode: the postcode picker is NOT inert (I1 headline regression)', () => {
  it('narrows the sub-district combobox for an existing TH member whose sub_district is NULL (the ~132 imported TSCC members shape)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/geo/postal/10330') return jsonResponse({ candidates: UNAMBIGUOUS });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm
          plans={PLANS}
          defaultPlanYear={2026}
          onSubmit={vi.fn()}
          submitting={false}
          mode="edit"
          initialValues={{
            company_name: 'Acme',
            country: 'TH',
            address_line1: '99 Nimman Rd',
            postal_code: '10330',
            // Province/city already resolved+English (per the file-header
            // "Data" fact — the 132 imported members are 100% English) so
            // they match the fetched candidate's province/district and the
            // cascade actually narrows city → sub-district. sub_district
            // itself is EMPTY — the exact shape of every imported member.
            province: 'Bangkok',
            city: 'Pathum Wan',
            sub_district: '',
          }}
        />
      </NextIntlClientProvider>,
    );

    await waitFor(
      () => expect(fetchMock).toHaveBeenCalledWith('/api/geo/postal/10330', expect.anything()),
      { timeout: 3000 },
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Anti-overwrite guarantee still holds: sub_district was NOT written,
    // nothing announced, no Undo offered.
    expect(byId('sub_district')).toHaveTextContent(/select a sub-district/i);
    expect(liveRegionText()).toBe('');
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();

    // The headline behaviour: opening the sub-district combobox offers
    // THIS postcode's real sub-district — not an empty list forcing the
    // admin to hand-type the แขวง.
    fireEvent.click(byId('sub_district'));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Wang Mai')).toBeInTheDocument();
  });
});

describe('AddressSection — manual entry when the postcode has no candidates (Critical 1 regression)', () => {
  it('lets the admin type a province directly into the combobox and commit it', async () => {
    renderForm();

    fireEvent.click(byId('province'));
    const searchInput = await screen.findByPlaceholderText(/search provinces/i);

    fireEvent.change(searchInput, { target: { value: 'Farmland Province' } });

    const useItem = await screen.findByText(/use.*farmland province/i);
    fireEvent.click(useItem);

    await waitFor(() => expect(byId('province')).toHaveTextContent('Farmland Province'));
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
