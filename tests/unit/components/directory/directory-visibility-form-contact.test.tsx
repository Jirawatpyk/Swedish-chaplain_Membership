// @vitest-environment jsdom
/**
 * Directory listing settings — whose contact details the toggles publish.
 *
 * GDPR Art. 6 / PDPA §19, §24: the directory publishes the member's LIVE
 * primary contact's name and email, and only that person may decide to. The
 * form names the person on the toggles, disables them for a colleague (the
 * POST route enforces the same rule), and previews the listing from the
 * CURRENT form state, saying so while it differs from what is saved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import {
  DirectoryVisibilityForm,
  type DirectoryContactContext,
} from '@/components/directory/directory-visibility-form';

// Base UI's Switch/Checkbox pointer handling references the global
// `PointerEvent`, which jsdom does not define (same polyfill as
// tests/unit/components/auth/change-role-dialog.test.tsx).
if (typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, params: MouseEventInit = {}) {
      super(type, params);
    }
  }
  globalThis.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PRIMARY = { name: 'Anna Lindqvist', email: 'anna@acme.example' };
const nameLabel = `Primary contact's name (${PRIMARY.name})`;
const emailLabel = `Primary contact's email (${PRIMARY.email})`;

function renderForm(contact: DirectoryContactContext, fieldVisibility: Record<string, boolean>) {
  render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <DirectoryVisibilityForm
        initial={{
          listed: true,
          fieldVisibility,
          industry: 'Logistics',
          description: null,
          website: null,
          locationCity: null,
          locationCountry: null,
        }}
        contact={contact}
        identity={{ companyName: 'Acme Co', tier: null, logoUrl: null, primaryContact: PRIMARY }}
      />
    </NextIntlClientProvider>,
  );
}

/** The checkbox carrying exactly this `aria-label` (the wrapping <label> repeats it in the computed name). */
function checkbox(label: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${label}"]`);
  if (el === null) throw new Error(`no checkbox labelled ${label}`);
  return el;
}

const stored = { name: true, industry: true, contact_name: true, contact_email: false };

describe('DirectoryVisibilityForm — contact toggles', () => {
  it("names the primary contact on both toggles", () => {
    renderForm({ viewerIsPrimary: true, chosenByPrimary: true, hasListing: true }, stored);
    expect(checkbox(nameLabel)).toBeTruthy();
    expect(checkbox(emailLabel)).toBeTruthy();
  });

  it('disables them for a colleague and tells them who decides', () => {
    renderForm({ viewerIsPrimary: false, chosenByPrimary: true, hasListing: true }, stored);
    expect(checkbox(emailLabel).hasAttribute('data-disabled')).toBe(true);
    expect(
      screen.getByText(
        `Only your company's primary contact (${PRIMARY.name}) can choose whether their name and email are published. Let ${PRIMARY.name} know if you'd like them shown.`,
      ),
    ).toBeTruthy();
  });

  it("a colleague's save resubmits the STORED contact toggles unchanged", async () => {
    // Nothing stored for the contact toggles: the defaults (name on) must not
    // be sent, or the server's primary-only gate would refuse the save.
    renderForm({ viewerIsPrimary: false, chosenByPrimary: false, hasListing: true }, { name: true });
    fireEvent.click(screen.getByRole('button', { name: en.directorySettings.save }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.fieldVisibility.contact_name).toBe(false);
    expect(body.fieldVisibility.contact_email).toBe(false);
  });

  it("asks a new primary to confirm a predecessor's choice and shows the fallback (email hidden)", () => {
    renderForm(
      { viewerIsPrimary: true, chosenByPrimary: false, hasListing: true },
      { ...stored, contact_email: true },
    );
    expect(screen.getByTestId('directory-contact-confirm')).toBeTruthy();
    expect(checkbox(emailLabel).getAttribute('aria-checked')).toBe('false');
  });
});

describe('DirectoryVisibilityForm — preview', () => {
  it('previews the saved listing, then the unsaved change', () => {
    renderForm({ viewerIsPrimary: true, chosenByPrimary: true, hasListing: true }, stored);
    const preview = screen.getByTestId('directory-listing-preview');
    expect(preview.textContent).toContain(en.directorySettings.previewHeading);
    expect(preview.textContent).not.toContain(en.directorySettings.previewUnsaved);
    expect(preview.textContent).toContain(`${PRIMARY.name} — ${en.directorySettings.previewContactForm}`);

    fireEvent.click(checkbox(emailLabel));

    expect(preview.textContent).toContain(en.directorySettings.previewUnsaved);
    expect(screen.getByTestId('directory-preview-contact').textContent).toBe(
      `${PRIMARY.name} — ${PRIMARY.email}`,
    );
  });

  it('says the organisation is not listed when the listing is switched off', () => {
    renderForm({ viewerIsPrimary: true, chosenByPrimary: true, hasListing: true }, stored);
    fireEvent.click(screen.getAllByRole('switch')[0]!);
    expect(screen.getByTestId('directory-listing-preview').textContent).toContain(
      en.directorySettings.previewNotListed,
    );
  });
});
