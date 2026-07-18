/**
 * F8 Phase 4 Wave I2 · Task 7 — `EmailPreview` client-safe no-copy warning /
 * preview heading strip (spec §5.2, §5.5).
 *
 * Design contract:
 *   - Client-safe: imports only `@/modules/renewals/client` (domain
 *     constants), never the infrastructure `copy.ts` — that module pulls
 *     in the full 3-locale copy matrix and is server-only.
 *   - If `offsetDays` is NOT one of the tier's `TIER_REMINDER_OFFSETS` →
 *     render a destructive `role="status"` (polite live region) "will not
 *     be sent" warning (`stepCard.preview.noCopyWarning`). Polite, not
 *     assertive: this warning remounts on every timing change in the
 *     parent `StepCard`, and an assertive `role="alert"` would interrupt
 *     screen-reader users on each change.
 *   - If it IS covered → render the `stepCard.preview.heading` label plus
 *     a localized one-line plain-language summary built by
 *     `timingSentence` (`stepCard.timing.*` keys — the cryptic "T-30"
 *     form was removed in v3 cleanup).
 */
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { EmailPreview } from '@/app/(staff)/admin/settings/renewals/schedules/_components/email-preview';

const wrap = (ui: React.ReactNode) =>
  render(<NextIntlClientProvider locale="en" messages={messages}>{ui}</NextIntlClientProvider>);

it('warns when the offset has no copy for the tier', () => {
  wrap(<EmailPreview tierBucket="regular" offsetDays={-45} />); // -45 not in regular set
  expect(screen.getByRole('status')).toHaveTextContent(/will not be sent/i);
});

// I6 follow-up fix (`.superpowers/sdd/followup-reminder-uxwave-brief.md`)
// — "Email that will be sent" implied a real body preview spec §9
// explicitly defers; reworded to state only what's actually configured.
it('shows the reworded preview heading when the offset is covered', () => {
  wrap(<EmailPreview tierBucket="regular" offsetDays={-30} />); // t-30 is in regular set
  expect(
    screen.getByText(/reminder email is configured for this timing/i),
  ).toBeInTheDocument();
  expect(screen.queryByText(/email that will be sent/i)).not.toBeInTheDocument();
});

// I4 follow-up fix — the not-covered branch used to be a `<p role=
// "status">` and the covered branch a `<div>` with NO role; toggling
// between them (every timing change) unmounted/remounted the live
// region. ONE stable role="status" node must now persist across the
// coverage boundary — proven here by capturing the DOM node reference
// before and after a rerender that flips `covered`, not merely the text.
it('keeps the SAME role="status" live-region node across a coverage-state change (does not remount)', () => {
  const { rerender } = wrap(<EmailPreview tierBucket="regular" offsetDays={-45} />);
  const notCoveredNode = screen.getByRole('status');

  rerender(
    <NextIntlClientProvider locale="en" messages={messages}>
      <EmailPreview tierBucket="regular" offsetDays={-30} />
    </NextIntlClientProvider>,
  );
  const coveredNode = screen.getByRole('status');
  expect(coveredNode).toBe(notCoveredNode);
  expect(coveredNode).toHaveAttribute('aria-live', 'polite');
});
