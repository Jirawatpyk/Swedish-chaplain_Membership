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
import { render, screen, cleanup, act } from '@testing-library/react';
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
});
