/**
 * Task 8 (2026-08-01-broadcast-review-queue-pr2) — a11y M1: the recipient
 * count sentence must be part of the approve dialog's ARIA-accessible
 * description, not a visual-only sibling paragraph.
 *
 * Before this fix, `<p>{t('recipientCount', …)}</p>` was rendered as a
 * SIBLING of `AlertDialogDescription` inside `AlertDialogHeader`. Base UI
 * wires the dialog's `aria-describedby` to the `AlertDialogDescription`
 * element only, so a screen reader announced the title + description on
 * open but never "Reaches ~N recipients". This test resolves
 * `aria-describedby` to its referenced element(s) and asserts the
 * recipient sentence is included in their combined text content.
 *
 * Mirrors the harness in tests/unit/broadcast/approve-dialog-recipient.test.tsx
 * (real NextIntlClientProvider + canonical en.json + mocked useRouter).
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ApproveDialog } from '@/components/broadcast/admin/approve-dialog';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(cleanup);

function describedText(el: Element): string {
  const describedById = el.getAttribute('aria-describedby');
  expect(describedById).toBeTruthy();
  return describedById!
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

describe('ApproveDialog aria-describedby', () => {
  it('includes the recipient count in the dialog accessible description', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ApproveDialog broadcastId="b1" open onOpenChange={() => {}} recipientCount={12} />
      </NextIntlClientProvider>,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(describedText(dialog)).toMatch(/Reaches ~12 recipients/);
  });

  it('describes only the base sentence when recipientCount is not provided', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ApproveDialog broadcastId="b1" open onOpenChange={() => {}} />
      </NextIntlClientProvider>,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(describedText(dialog)).not.toMatch(/Reaches ~/);
  });
});
