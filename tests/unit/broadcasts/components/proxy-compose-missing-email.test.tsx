/**
 * Task 6 — proxy-compose-form primary-contact email pre-validation.
 *
 * Guards:
 *  1. Static i18n coverage: the two new keys (`missingContactEmailWarning` +
 *     `missingContactEmailError`) are present and non-empty in canonical en.json.
 *     (unit-test mocks mock next-intl so t() never throws on a missing key;
 *     check:i18n is parity-only and won't catch a typo'd ref; this test closes
 *     the gap — mirrors admin-toast-i18n.test.ts pattern.)
 *
 *  2. Component render: when the selected member has `hasPrimaryContactEmail:false`
 *     - the inline warning is shown
 *     - the "Submit for review" button is disabled
 *     When `hasPrimaryContactEmail:true` the warning is absent (the button
 *     remains disabled for other reasons: empty subject/body/segment, which
 *     we cannot satisfy in jsdom without a live Tiptap editor).
 *
 * Sub-components that require heavy browser/Tiptap runtime are mocked so
 * the tests run in jsdom.
 *
 * Pattern note: vi.mock() is hoisted to the top of the module by Vitest.
 * To capture the `onSelect` callback from the MemberPicker mock and call
 * it inside a test, we use a module-level variable (`capturedOnSelect`)
 * that the mock factory closes over. `act()` wraps the state-updating call
 * so React flushes the update before assertions.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import type { MemberPickerOption } from '@/components/broadcast/member-picker';

// ─── 1. Static i18n coverage test ─────────────────────────────────────────

type ProxySubmitDialogKeys = {
  missingContactEmailWarning?: string;
  missingContactEmailError?: string;
  [key: string]: string | undefined;
};

const proxySubmitDialog = (
  en as unknown as {
    admin: {
      broadcasts: {
        proxySubmitDialog: ProxySubmitDialogKeys;
      };
    };
  }
).admin.broadcasts.proxySubmitDialog;

const REQUIRED_PROXY_KEYS = [
  'missingContactEmailWarning',
  'missingContactEmailError',
] as const;

describe('proxySubmitDialog — EN i18n coverage (Task 6)', () => {
  it('every new key has a non-empty EN string in en.json', () => {
    const missing = REQUIRED_PROXY_KEYS.filter(
      (k) => typeof proxySubmitDialog[k] !== 'string' || proxySubmitDialog[k]!.length === 0,
    );
    expect(
      missing,
      `Missing/empty admin.broadcasts.proxySubmitDialog EN key(s): ${missing.join(', ')} — ` +
        'the ProxyComposeForm calls t(<key>) on these; add them to en.json ' +
        '(+ th/sv for check:i18n parity) or the warning renders the raw key path at runtime.',
    ).toEqual([]);
  });
});

// ─── 2. Component render tests ─────────────────────────────────────────────

// Shared capture variable — the MemberPicker mock factory closes over this.
let capturedOnSelect: ((m: MemberPickerOption) => void) | null = null;

// Mock all sub-components that are too complex to render in jsdom.
vi.mock('@/components/broadcast/member-picker', () => ({
  MemberPicker: ({
    value,
    onSelect,
    label,
  }: {
    value: MemberPickerOption | null;
    onSelect: (m: MemberPickerOption) => void;
    label: string;
  }) => {
    capturedOnSelect = onSelect;
    return (
      <div>
        <span>{label}</span>
        {value ? <span data-testid="selected-member">{value.companyName}</span> : null}
      </div>
    );
  },
}));

vi.mock('@/components/broadcast/segment-picker', () => ({
  SegmentPicker: () => <div data-testid="segment-picker" />,
}));

vi.mock('@/components/broadcast/custom-list-input', () => ({
  CustomListInput: () => <div data-testid="custom-list-input" />,
  parseLines: (s: string) => s.split('\n').filter(Boolean),
}));

vi.mock('@/components/broadcast/schedule-picker', () => ({
  SchedulePicker: () => <div data-testid="schedule-picker" />,
}));

vi.mock('@/components/broadcast/preview-pane', () => ({
  PreviewPane: () => <div data-testid="preview-pane" />,
}));

vi.mock('@/components/broadcast/submit-button', () => ({
  SubmitButton: ({
    disabled,
    onClick,
  }: {
    disabled: boolean;
    submitting: boolean;
    onClick: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick} data-testid="submit-btn">
      Submit for review
    </button>
  ),
}));

vi.mock('@/components/broadcast/compose-form', () => ({
  buildSegmentPayload: vi.fn(() => ({ kind: 'all_members' })),
}));

// TiptapEditor dynamic loader — return a simple textarea stub.
vi.mock('@/components/ui/tiptap-loader', () => ({
  loadTiptapEditor: () => {
    const Stub = ({
      onChange,
    }: {
      initialHtml: string;
      onChange: (html: string) => void;
      disabled?: boolean;
      labelledById?: string;
    }) => (
      <textarea
        data-testid="tiptap-stub"
        onChange={(e) => onChange(e.target.value)}
      />
    );
    Stub.displayName = 'TiptapEditorStub';
    return Stub;
  },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// ---------------------------------------------------------------------------
// Helpers for the pickerError server-response test (F8)
// ---------------------------------------------------------------------------

/** Build a minimal Response that looks like a 422 from the proxy-submit route. */
function makeFetchResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Lazy-import ProxyComposeForm AFTER all vi.mock() declarations.
// Vitest hoists vi.mock() above the import, so mocks are in place when
// the module is loaded here.
const { ProxyComposeForm } = await import('@/components/broadcast/proxy-compose-form');

afterEach(() => {
  cleanup();
  capturedOnSelect = null;
});

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <ProxyComposeForm />
    </NextIntlClientProvider>,
  );
}

describe('ProxyComposeForm — missing primary contact email (Task 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submit is disabled and warning is shown when hasPrimaryContactEmail is false', async () => {
    renderForm();

    // capturedOnSelect is set during render by the MemberPicker mock.
    // Wrap state-update call in act() so React flushes synchronously
    // before assertions (required when calling state-setters outside
    // user-event / fireEvent — see RTL docs on `act()`).
    await act(async () => {
      capturedOnSelect?.({
        memberId: 'm-noemail',
        companyName: 'No Email Corp',
        primaryContactName: null,
        hasPrimaryContactEmail: false,
      });
    });

    // The inline warning must be visible.
    expect(
      screen.getByText(
        /no primary contact email/i,
      ),
    ).toBeInTheDocument();

    // The submit button must be disabled.
    expect(screen.getByTestId('submit-btn')).toBeDisabled();
  });

  it('no warning shown when hasPrimaryContactEmail is true', async () => {
    renderForm();

    await act(async () => {
      capturedOnSelect?.({
        memberId: 'm-hasemail',
        companyName: 'Has Email Corp',
        primaryContactName: 'Jane Doe',
        hasPrimaryContactEmail: true,
      });
    });

    // The missing-email warning must NOT appear.
    expect(screen.queryByText(/no primary contact email/i)).toBeNull();
  });

  it('server 422 broadcast_member_missing_primary_contact_email → pickerError: shows missingContactEmailError at picker level AND preserves member selection', async () => {
    // Arrange: mock global fetch to return a 422 with the missing-email error code.
    // The form blocks submit when hasPrimaryContactEmail===false, but the server
    // can still 422 when the picker data is stale (e.g. the member lost their
    // contact after the admin loaded the form). The `pickerError` path MUST:
    //   (a) show the `missingContactEmailError` i18n message at the picker level
    //       (NOT a generic toast — the member needs to know WHICH member is broken)
    //   (b) preserve the member selection (the admin may want to navigate to the
    //       member's profile to add a contact — clearing the picker loses context)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeFetchResponse(422, {
        error: { code: 'broadcast_member_missing_primary_contact_email' },
      }),
    );

    renderForm();

    // Select a member that HAS a primary contact email (so the client-side guard
    // does NOT disable submit) — stale picker scenario where server still 422s.
    await act(async () => {
      capturedOnSelect?.({
        memberId: 'm-stale',
        companyName: 'Stale Email Corp',
        primaryContactName: 'Alex Stale',
        hasPrimaryContactEmail: true,
      });
    });

    // Confirm the member IS selected.
    expect(screen.getByTestId('selected-member')).toBeInTheDocument();

    // Fill in the subject so SubmitSchema.safeParse passes and submitDisabled
    // becomes false (member is set + hasPrimaryContactEmail:true + subject ≥1).
    // The initial bodyHtml '<p></p>' has length > 0 so body validation passes.
    // Use the input's id directly (multiple textbox roles exist: input + tiptap stub).
    const subjectInput = document.getElementById('proxy-broadcast-subject') as HTMLInputElement;
    fireEvent.change(subjectInput, { target: { value: 'Test subject' } });

    // Now the submit button should be enabled. Click it and await the async fetch.
    const submitBtn = screen.getByTestId('submit-btn');
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // (a) The picker-level error message for missingContactEmailError must be
    //     visible as a `role="alert"` paragraph. The en.json value for this key
    //     contains "email" — assert case-insensitively so the test is not
    //     fragile to minor copy edits.
    const pickerError = screen.queryByRole('alert');
    expect(pickerError).not.toBeNull();
    expect(pickerError?.textContent?.toLowerCase()).toMatch(/email/);

    // (b) Member selection is PRESERVED — the selected-member span must still
    //     be present. The `picker` case (member_not_found) clears selection;
    //     `pickerError` MUST NOT clear it (the admin may want to navigate to
    //     the member profile to add a contact email first).
    expect(screen.getByTestId('selected-member')).toBeInTheDocument();
  });
});
