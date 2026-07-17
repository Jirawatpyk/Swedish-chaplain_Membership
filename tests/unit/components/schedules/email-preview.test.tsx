/**
 * F8 Phase 4 Wave I2 · Task 7 — `EmailPreview` client-safe no-copy warning /
 * preview heading strip (spec §5.2, §5.5).
 *
 * Design contract:
 *   - Client-safe: imports only `@/modules/renewals/client` (domain
 *     constants), never the infrastructure `copy.ts` — that module pulls
 *     in the full 3-locale copy matrix and is server-only.
 *   - If `offsetDays` is NOT one of the tier's `TIER_REMINDER_OFFSETS` →
 *     render a destructive `role="alert"` "will not be sent" warning
 *     (`stepCard.preview.noCopyWarning`).
 *   - If it IS covered → render the `stepCard.preview.heading` label plus
 *     a localized one-line summary built from `stepCard.offsetDay.*`.
 */
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { EmailPreview } from '@/app/(staff)/admin/settings/renewals/schedules/_components/email-preview';

const wrap = (ui: React.ReactNode) =>
  render(<NextIntlClientProvider locale="en" messages={messages}>{ui}</NextIntlClientProvider>);

it('warns when the offset has no copy for the tier', () => {
  wrap(<EmailPreview tierBucket="regular" offsetDays={-45} />); // -45 not in regular set
  expect(screen.getByRole('alert')).toHaveTextContent(/will not be sent/i);
});

it('shows the preview heading when the offset is covered', () => {
  wrap(<EmailPreview tierBucket="regular" offsetDays={-30} />); // t-30 is in regular set
  expect(screen.getByText(/email that will be sent/i)).toBeInTheDocument();
});
