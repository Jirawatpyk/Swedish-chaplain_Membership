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

  it('degrades to the raw value instead of throwing when memberNumber is DB-invalid (0)', () => {
    expect(() => renderCard(baseRow({ memberNumber: 0 }))).not.toThrow();
    expect(screen.getByText('Member 0')).toBeInTheDocument();
  });
});
