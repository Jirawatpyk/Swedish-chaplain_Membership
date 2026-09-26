// @vitest-environment jsdom
/**
 * Portal error states — the read-only 503 on every member mutation
 * (follow-up to #388, which fixed compose submit, the change-request form and
 * pay/initiate).
 *
 * While `READ_ONLY_MODE=true` the proxy answers every write with 503 and a
 * FLAT `{ error: 'read-only-mode' }`. These surfaces read only `error.code`,
 * found nothing, and told the member "failed — try again": advice that cannot
 * work until the freeze lifts. Each now says the system is read-only and that
 * nothing changed, as a WARNING (it is not the member's error, nor a fault).
 *
 * Table-driven on purpose: the defect and the fix are the same shape at every
 * site, so the evidence is too. Each row renders the real component under the
 * real `en.json`, performs the one mutation, and answers it with the proxy's
 * literal response.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from '@/lib/toast';
import en from '@/i18n/messages/en.json';
import { AcknowledgementBannerClient } from '@/app/(member)/portal/_components/marketing-acknowledgement-banner-client';
import { ResendInvoiceButton } from '@/app/(member)/portal/invoices/_components/resend-invoice-button';
import { RenewalRemindersToggle } from '@/app/(member)/portal/preferences/renewals/_components/renewal-reminders-toggle';
import { CancelBroadcastDialog } from '@/components/broadcast/cancel-broadcast-dialog';
import { MemberSignOffActions } from '@/components/broadcast/approval/member-sign-off-actions';
import { DataExportPanel, type DataExportLabels } from '@/components/data-export/data-export-panel';
import { DirectoryLogoControl } from '@/components/directory/directory-logo-control';
import { DirectoryVisibilityForm } from '@/components/directory/directory-visibility-form';
import { InviteColleagueForm } from '@/components/members/invite-colleague-form';
import { PortalEditForm } from '@/components/members/portal-edit-form';
import { PortalMarketingToggle } from '@/components/members/portal-marketing-toggle';
import { PreferredLocaleForm } from '@/components/portal/preferred-locale-form';
import { ChangePasswordForm } from '@/components/auth/change-password-form';

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

/** `src/proxy.ts` `build503`, verbatim. */
function readOnly503(): Response {
  return new Response(
    JSON.stringify({
      error: 'read-only-mode',
      message: 'The system is currently in read-only mode for maintenance.',
      retryAfterSeconds: 300,
      supportUrl: '/admin/support',
    }),
    { status: 503, headers: { 'content-type': 'application/json', 'Retry-After': '300' } },
  );
}

const LABELS: DataExportLabels = {
  requestButton: 'Request export',
  requesting: 'Requesting…',
  requestedTitle: 'Requested',
  requestedBody: 'We will email you.',
  statusHeading: 'Status',
  empty: 'None yet',
  download: 'Download',
  errorTitle: 'Export failed',
  errorBody: 'Try again.',
  expiresHint: 'Expires',
  colStatus: 'Status',
  colRequested: 'Requested',
  caption: 'Exports',
  alreadyPending: 'Pending',
};

const PROFILE = {
  firstName: 'Anna',
  lastName: 'Svensson',
  phone: '+66812345678',
  roleTitle: '',
  companyName: 'Nordic Co',
  website: '',
  description: '',
};

const byName = (name: string | RegExp) => screen.getByRole('button', { name });
const type = (selector: string, value: string, root: HTMLElement) =>
  fireEvent.change(root.querySelector(selector)!, { target: { value } });

interface Surface {
  readonly name: string;
  readonly ui: () => React.ReactElement;
  readonly act: (root: HTMLElement) => Promise<void> | void;
  /**
   * PR #392 review D5 — `dialog`: a dialog stays open over the refusal and is
   * the ONE channel (a toast would sit behind the modal, hidden from AT), so
   * the whole warning is asserted inside it instead. Default: the toast.
   */
  readonly channel?: 'dialog';
}

const SURFACES: readonly Surface[] = [
  {
    name: 'marketing acknowledgement banner',
    ui: () => (
      <AcknowledgementBannerClient
        title="Marketing"
        body="Body"
        acknowledge="I acknowledge"
        remindLater="Remind me later"
        locale="en"
      />
    ),
    act: () => fireEvent.click(byName('I acknowledge')),
  },
  {
    name: 'resend invoice button',
    ui: () => <ResendInvoiceButton invoiceId="inv-1" documentNumber="INV-1" />,
    act: () => fireEvent.click(byName(/email a fresh copy/i)),
  },
  {
    name: 'renewal reminders toggle',
    ui: () => <RenewalRemindersToggle initialOptedOut={false} />,
    act: () => fireEvent.click(screen.getByRole('switch')),
  },
  {
    name: 'cancel broadcast dialog',
    ui: () => (
      <CancelBroadcastDialog
        open
        onOpenChange={vi.fn()}
        endpoint="/api/broadcasts/b1/cancel"
        namespace="portal.broadcasts.detail.cancelDialog"
        toastNamespace="portal.broadcasts.detail.toast"
        reasonRequired={false}
        subject="Spring mixer"
      />
    ),
    act: () => {
      fireEvent.change(screen.getByLabelText(en.portal.broadcasts.detail.cancelDialog.subjectLabel), {
        target: { value: 'Spring mixer' },
      });
      fireEvent.click(byName(en.portal.broadcasts.detail.cancelDialog.confirm));
    },
  },
  // F119 (PR #392 review C1) — the member's E-Blast decision: approve,
  // request changes and withdraw approval share one POST, so one row covers
  // the mapping all three go through.
  {
    name: 'E-Blast sign-off decision',
    ui: () => (
      <MemberSignOffActions
        broadcastId="b1"
        subject="Spring mixer"
        version={{ id: 'v1', versionNo: 1 }}
        canDecide
        canWithdrawApproval={false}
        canWithdrawEblast={false}
      />
    ),
    act: async () => {
      fireEvent.click(screen.getByTestId('eblast-approve'));
      fireEvent.click(await screen.findByTestId('eblast-approve-confirm'));
    },
    channel: 'dialog',
  },
  {
    name: 'data export panel',
    ui: () => <DataExportPanel rows={[]} labels={LABELS} />,
    act: () => fireEvent.click(byName('Request export')),
  },
  {
    name: 'directory logo removal',
    ui: () => <DirectoryLogoControl currentLogoUrl="https://blob.example/logo.png" />,
    act: async () => {
      fireEvent.click(byName(en.directorySettings.logoRemove));
      fireEvent.click(await screen.findByRole('button', { name: en.directorySettings.logoRemoveConfirm }));
    },
  },
  {
    name: 'directory listing form',
    ui: () => (
      <DirectoryVisibilityForm
        initial={{
          listed: true,
          fieldVisibility: {},
          industry: null,
          description: null,
          website: null,
          locationCity: null,
          locationCountry: null,
        }}
        contact={{ viewerIsPrimary: true, chosenByPrimary: true, hasListing: true }}
        identity={{ companyName: 'Acme Co', tier: null, logoUrl: null, primaryContact: null }}
      />
    ),
    act: () => fireEvent.click(byName(en.directorySettings.save)),
  },
  {
    name: 'invite colleague form',
    ui: () => <InviteColleagueForm />,
    act: (root) => {
      type('#first_name', 'Jane', root);
      type('#last_name', 'Doe', root);
      type('#email', 'jane@example.com', root);
      fireEvent.submit(root.querySelector('form')!);
    },
  },
  {
    name: 'profile edit form',
    ui: () => <PortalEditForm initialValues={PROFILE} />,
    act: (root) => {
      type('#firstName', 'Annika', root);
      fireEvent.submit(root.querySelector('form')!);
    },
  },
  {
    name: 'marketing preference toggle',
    ui: () => <PortalMarketingToggle state="on" isPrimary={false} />,
    act: () => fireEvent.click(screen.getByRole('switch')),
  },
  {
    name: 'preferred locale form',
    ui: () => <PreferredLocaleForm initialValue="th" />,
    act: (root) => fireEvent.submit(root.querySelector('form')!),
  },
  {
    name: 'change password form',
    ui: () => <ChangePasswordForm />,
    act: (root) => {
      type('#current-password', 'old password that is long', root);
      type('#new-password', 'Correct horse battery staple 42', root);
      type('#confirm-password', 'Correct horse battery staple 42', root);
      fireEvent.submit(root.querySelector('form')!);
    },
  },
];

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom (Base UI dispatches these)
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(t: string, params?: PointerEventInit) {
        super(t, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal('fetch', vi.fn(async () => readOnly503()));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('a member mutation refused by the read-only proxy', () => {
  it.each(SURFACES)('$name says the system is read-only and nothing changed', async (s) => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        {s.ui()}
      </NextIntlClientProvider>,
    );
    await s.act(container);

    if (s.channel === 'dialog') {
      const alert = await within(screen.getByRole('alertdialog')).findByRole('alert');
      expect(alert).toHaveTextContent(en.errors.readOnlyMode);
      expect(alert).toHaveTextContent(en.errors.readOnlyNothingChanged);
      expect(alert).toHaveAttribute('data-tone', 'warning');
      expect(toast.warning).not.toHaveBeenCalled();
    } else {
      await waitFor(() =>
        expect(toast.warning).toHaveBeenCalledWith(en.errors.readOnlyMode, {
          description: en.errors.readOnlyNothingChanged,
        }),
      );
    }
    expect(toast.error, 'a freeze is not a failure the member can fix').not.toHaveBeenCalled();
  });
});
