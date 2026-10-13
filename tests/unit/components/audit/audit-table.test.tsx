/**
 * Spec 122 US10b (T1012) — the audit table on AURA's static Table, stacking
 * into cards on phones with the event as each card's title. What it shows is
 * today's: the dual timestamp (FR-012), the raw event and actor codes, the
 * role-redacted payload as label/value pairs, and the empty state.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { AuditTable, type AuditTableRow } from '@/components/audit/audit-table';

const labels = {
  caption: 'Audit events, newest first',
  time: 'Time',
  event: 'Event',
  actor: 'Actor',
  target: 'Target',
  summary: 'Summary',
  payload: 'Details',
  emptyTitle: 'No audit events',
  empty: 'No audit events match these filters.',
  none: 'None',
  utcLabel: 'UTC',
};

const ROW: AuditTableRow = {
  id: 'a-1',
  occurredAtUtc: '2026-09-24T03:18:00.000Z',
  occurredAtLocal: '24 Sep 2026, 10:18',
  eventTypeLabel: 'Member change request decided',
  eventType: 'member_change_request_decided',
  actorLabel: 'Johan Strand',
  actorUserId: '8b21-77c0',
  targetLabel: 'Midsommar Hospitality Co., Ltd.',
  targetUserId: 't-1',
  summary: 'Approved 2 fields, rejected 1',
  payloadEntries: [{ label: 'Outcome', value: 'partially approved' }],
};

describe('<AuditTable> on AURA', () => {
  it('is an AURA table named by its caption that stacks into cards on phones', () => {
    render(<AuditTable rows={[ROW]} labels={labels} />);
    const table = screen.getByRole('table', { name: labels.caption });
    expect(table).toHaveClass('aura-tbl', 'aura-tbl--stack-sm', 'aura-tbl--cards');
  });

  it('makes the event each card’s title, with its raw code under it', () => {
    render(<AuditTable rows={[ROW]} labels={labels} />);
    const cell = screen.getByText(ROW.eventTypeLabel).closest('td')!;
    expect(cell).toHaveAttribute('data-card', 'title');
    expect(within(cell).getByText(ROW.eventType)).toBeInTheDocument();
  });

  it('keeps the dual timestamp: the local time on a <time> and the UTC instant named as UTC', () => {
    render(<AuditTable rows={[ROW]} labels={labels} />);
    const time = screen.getByText(ROW.occurredAtLocal);
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('dateTime', ROW.occurredAtUtc);
    expect(screen.getByText(ROW.occurredAtUtc, { exact: false }).textContent).toContain('UTC');
  });

  it('shows the payload as label/value pairs, and "None" when there is none', () => {
    render(<AuditTable rows={[ROW, { ...ROW, id: 'a-2', payloadEntries: [] }]} labels={labels} />);
    const dt = screen.getByText('Outcome:');
    expect(dt.tagName).toBe('DT');
    expect(dt.nextElementSibling).toHaveTextContent('partially approved');
    expect(screen.getByText(labels.none)).toBeInTheDocument();
  });

  it('shows the empty state when nothing matches', () => {
    render(<AuditTable rows={[]} labels={labels} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(labels.emptyTitle)).toBeInTheDocument();
  });
});
