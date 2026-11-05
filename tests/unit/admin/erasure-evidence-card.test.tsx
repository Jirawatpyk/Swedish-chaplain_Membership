import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { EvidenceCard } from '@/app/(staff)/admin/compliance/erasure-log/_components/evidence-card';
import type { GroupedEvidence } from '@/modules/insights';

const NOW = new Date('2026-06-20T00:00:00.000Z');
const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

function baseRow(over: Partial<GroupedEvidence> = {}): GroupedEvidence {
  return {
    memberId: 'm1', memberNumber: 42, erasedAt: new Date('2026-06-19T00:00:00.000Z'),
    requestedAt: new Date('2026-06-19T00:00:00.000Z'), reason: 'gdpr_erasure_request',
    identityVerified: true, verificationMethod: 'in_person', note: null,
    completedAt: new Date('2026-06-19T00:05:00.000Z'), sessionsRevokedTotal: 1,
    invitationsRevokedCount: 0, reDrive: false, userErasedProofs: [], taxRedactions: [],
    subprocessorOutcome: null, halfRun: false, isOverdue: false, ...over,
  };
}
function renderCard(row: GroupedEvidence, topBannerPresent = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <EvidenceCard row={row} memberPrefix="SCCM" fmt={fmt} now={NOW} topBannerPresent={topBannerPresent} />
    </NextIntlClientProvider>,
  );
}
afterEach(cleanup);

describe('EvidenceCard', () => {
  it('renders the canonical SCCM-NNNN heading', () => {
    renderCard(baseRow());
    expect(screen.getByText('Member SCCM-0042')).toBeInTheDocument();
  });

  it('a COMPLETE card is a collapsed <details> (no open attribute), inside a data-evidence details', () => {
    const { container } = renderCard(baseRow());
    const details = container.querySelector('details[data-evidence]');
    expect(details).not.toBeNull();
    expect(details!.hasAttribute('open')).toBe(false);
  });

  // Spec 140 s3 final Verify finding — a complete erasure whose Resend outcome
  // needs the DPO (partial / failed / not_attempted) read only "Complete" on the
  // collapsed card. It now flags the Resend action on the summary and opens.
  it.each(['partial', 'failed', 'not_attempted'] as const)(
    'a complete card whose Resend outcome is %s flags the action and opens',
    (resendOutcome) => {
      const { container } = renderCard(
        baseRow({ subprocessorOutcome: { resendOutcome, contactsRemoved: 0, contactsAlreadyAbsent: 0, contactsFailed: 0, detachWire: null } }),
      );
      const summary = container.querySelector('details[data-evidence] > summary')!;
      expect(summary.textContent).toContain('Action needed in Resend');
      expect(container.querySelector('details[data-evidence]')!.hasAttribute('open')).toBe(true);
      // The status reads first, then the flag (DOM order = reading order).
      expect(summary.textContent!.indexOf('Complete')).toBeLessThan(summary.textContent!.indexOf('Action needed in Resend'));
      if (resendOutcome !== 'not_attempted') {
        expect(container.textContent).toContain('The detach did not finish for every audience');
      }
    },
  );

  it.each(['ok', 'already_propagated'] as const)('a complete card whose Resend outcome is %s stays quiet and collapsed', (resendOutcome) => {
    const { container } = renderCard(
      baseRow({ subprocessorOutcome: { resendOutcome, contactsRemoved: 0, contactsAlreadyAbsent: 0, contactsFailed: 0, detachWire: null } }),
    );
    expect(container.querySelector('details[data-evidence] > summary')!.textContent).not.toContain('Action needed in Resend');
    expect(container.querySelector('details[data-evidence]')!.hasAttribute('open')).toBe(false);
  });

  it('an OVERDUE card is open by default', () => {
    const { container } = renderCard(baseRow({ halfRun: true, isOverdue: true, completedAt: null }));
    expect(container.querySelector('details[data-evidence]')!.hasAttribute('open')).toBe(true);
  });

  it('keeps the member heading as an <h2> inside the <summary> and adds no manual aria-expanded', () => {
    const { container } = renderCard(baseRow());
    const summary = container.querySelector('summary')!;
    expect(summary.querySelector('h2')).not.toBeNull();
    expect(summary.hasAttribute('aria-expanded')).toBe(false);
  });

  // Spec 140 s3 review round 1 (R1-I) — Resend answers 200 to a detach of an
  // address that was not in the segment, so the figure is the requests Resend
  // accepted, not memberships that existed; the note says it may include
  // addresses that were already absent.
  it('labels the detach figure as requests Resend accepted, and notes it may include absent addresses', () => {
    renderCard(
      baseRow({ subprocessorOutcome: { resendOutcome: 'ok', contactsRemoved: 2, contactsAlreadyAbsent: 0, contactsFailed: 0, detachWire: null } }),
    );
    expect(screen.getByText('Detach requests accepted by Resend')).toBeInTheDocument();
    expect(screen.getByText(/may include addresses that were already absent/i)).toBeInTheDocument();
  });

  // PR #756 review round 1 (pdpa M-1) — the counts note follows the wire that
  // wrote the record: a segment-wire row (`detachWire: 'segments'`) says what its
  // figures are; an older row keeps the old note, now marked as the older
  // records' note. Rendered fresh per case.
  it('a segment-wire record shows the Segments counts note, not the note for older records', () => {
    renderCard(
      baseRow({ subprocessorOutcome: { resendOutcome: 'ok', contactsRemoved: 1, contactsAlreadyAbsent: 1, contactsFailed: 0, detachWire: 'segments' } }),
    );
    expect(screen.getByText(/counts memberships Resend confirmed it removed/i)).toBeInTheDocument();
    expect(screen.getByText(/no membership in that segment for the address in lowercase/i)).toBeInTheDocument();
    expect(screen.queryByText(/may include addresses that were already absent/i)).toBeNull();
  });

  it('a record without the wire marker shows the note for older records, marked as such', () => {
    renderCard(
      baseRow({ subprocessorOutcome: { resendOutcome: 'ok', contactsRemoved: 1, contactsAlreadyAbsent: 0, contactsFailed: 0, detachWire: null } }),
    );
    expect(screen.getByText(/^For records written before the Segments detach: /)).toBeInTheDocument();
    expect(screen.queryByText(/counts memberships Resend confirmed it removed/i)).toBeNull();
  });

  // Spec 140 s3 review round 2 (R2-A) — a `not_attempted` row is a re-drive that
  // met only scrub sentinels. Its zeros are not "nothing to detach", so the card
  // says what the DPO must do instead of letting 0/0/0 read as done.
  it('explains a not_attempted outcome and sends the DPO to Resend; an ok outcome has no such note', () => {
    const note = /not attempted: the member's addresses were already scrubbed/i;
    renderCard(
      baseRow({ subprocessorOutcome: { resendOutcome: 'not_attempted', contactsRemoved: 0, contactsAlreadyAbsent: 0, contactsFailed: 0, detachWire: null } }),
    );
    expect(screen.getByText(note)).toBeInTheDocument();
    cleanup();
    renderCard(
      baseRow({ subprocessorOutcome: { resendOutcome: 'ok', contactsRemoved: 0, contactsAlreadyAbsent: 0, contactsFailed: 0, detachWire: null } }),
    );
    expect(screen.queryByText(note)).toBeNull();
  });

  it('degrades to the raw value instead of throwing when memberNumber is DB-invalid (0)', () => {
    expect(() => renderCard(baseRow({ memberNumber: 0 }))).not.toThrow();
    expect(screen.getByText('Member 0')).toBeInTheDocument();
  });

  // Spec 122 US10b (T1016; boards `Admin-erasure-log`, `Admin-state-erasure-breach`):
  // on AURA Card, StatusPill, Alert and Badge; the disclosure stays.
  describe('on AURA', () => {
    const e = enMessages.admin.compliance.erasureLog;

    it('is an AURA card holding the evidence disclosure', () => {
      const { container } = renderCard(baseRow());
      expect(container.querySelector('details[data-evidence]')!.closest('.aura-card')).not.toBeNull();
    });

    it.each([
      ['complete', baseRow(), e.status.complete, 'ready'],
      ['in progress', baseRow({ halfRun: true, completedAt: null }), e.status.halfRun, 'progress'],
      ['overdue', baseRow({ halfRun: true, isOverdue: true, completedAt: null }), e.status.overdue, 'blocked'],
    ])('a %s erasure shows a status pill toned by state', (_name, row, label, tone) => {
      renderCard(row);
      expect(screen.getByText(label)).toHaveAttribute('data-tone', tone);
    });

    it('the half-run note is an AURA alert: a status line, or an alert when overdue with no page banner', () => {
      const { rerender } = renderCard(baseRow({ halfRun: true, completedAt: null }));
      const pending = screen.getByRole('status');
      expect(pending).toHaveClass('aura-alert');
      rerender(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <EvidenceCard
            row={baseRow({ halfRun: true, isOverdue: true, completedAt: null })}
            memberPrefix="SCCM"
            fmt={fmt}
            now={NOW}
            topBannerPresent={false}
          />
        </NextIntlClientProvider>,
      );
      expect(screen.getByRole('alert')).toHaveClass('aura-alert');
    });

    it('names a redacted tax document’s kind on an AURA badge', () => {
      renderCard(baseRow({ taxRedactions: [{ documentKind: 'invoice', occurredAt: new Date('2026-06-19T01:00:00Z') }] }));
      expect(screen.getByText(e.documentKind.invoice).closest('.aura-badge')).not.toBeNull();
    });

    it('lays the evidence out as the board does: a bold title, three-up fields on wide screens, ruled sections', () => {
      const { container } = renderCard(baseRow({ halfRun: true, completedAt: null }));
      expect(container.querySelector('summary h2')).toHaveClass('font-semibold');
      const request = screen.getByRole('region', { name: e.sections.requested });
      expect(request.querySelector('dl')).toHaveClass('lg:grid-cols-3');
      expect(screen.getByRole('region', { name: e.sections.completion }).querySelector('dl')).toHaveClass('lg:grid-cols-3');
      expect(request.parentElement).toHaveClass('[&>section+section]:border-t');
    });
  });
});
