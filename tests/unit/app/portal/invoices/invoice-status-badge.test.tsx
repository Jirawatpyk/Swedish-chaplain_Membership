/**
 * Spec 122 US4 (T401) — the member invoice status is an AURA StatusPill in
 * the boards' tones: paid ready, issued in progress, overdue blocked, and
 * void / credited / draft neutral. The label is the caller's, unchanged.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InvoiceStatusBadge } from '@/app/(member)/portal/invoices/_components/invoice-status-badge';
import type { InvoiceRowDisplayStatus } from '@/app/(member)/portal/invoices/_utils/format';

const TONE_CLASS: Record<string, string | null> = {
  paid: 'aura-pill--ready',
  issued: 'aura-pill--progress',
  overdue: 'aura-pill--blocked',
  void: null,
  draft: null,
};

describe('<InvoiceStatusBadge>', () => {
  it.each(Object.entries(TONE_CLASS))('%s renders as an AURA pill in the board tone', (status, toneClass) => {
    render(<InvoiceStatusBadge status={status as InvoiceRowDisplayStatus} label={`label-${status}`} />);
    const pill = screen.getByText(`label-${status}`).closest('.aura-pill');
    expect(pill).not.toBeNull();
    for (const cls of ['aura-pill--ready', 'aura-pill--progress', 'aura-pill--blocked', 'aura-pill--warning']) {
      if (cls === toneClass) expect(pill).toHaveClass(cls);
      else expect(pill).not.toHaveClass(cls);
    }
  });
});
