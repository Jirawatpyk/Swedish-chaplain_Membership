/**
 * Spec 122 US10b (T1012) — the audit table on AURA's static Table from 640px
 * up: the dual timestamp (FR-012), the raw event and actor codes, the
 * role-redacted payload as label/value pairs, and the empty state. Below
 * 640px, board `Admin-audit-mobile`'s compact cards (maintainer, parity
 * comments 13 Oct): time · UTC, the event, Target, the summary, by actor ·
 * details.
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
  cardTarget: 'Target: {target}',
  cardBy: 'by {actor}',
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

const table = () => screen.getByRole('table', { name: labels.caption });
const cards = () => screen.getByRole('list', { name: labels.caption });

describe('<AuditTable> on AURA', () => {
  it('is an AURA table named by its caption from 640px up, and a list of cards below it', () => {
    render(<AuditTable rows={[ROW]} labels={labels} />);
    expect(table()).toHaveClass('aura-tbl');
    expect(table()).not.toHaveClass('aura-tbl--stack-sm');
    expect(table().closest('.max-sm\\:hidden')).not.toBeNull();
    expect(cards()).toHaveClass('sm:hidden');
    expect(within(cards()).getAllByRole('listitem')).toHaveLength(1);
  });

  it('a phone card reads as the board: time · UTC, the event, Target, the summary, by actor · details', () => {
    render(<AuditTable rows={[ROW]} labels={labels} />);
    const card = within(cards()).getByRole('listitem');
    const time = within(card).getByText(ROW.occurredAtLocal);
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('dateTime', ROW.occurredAtUtc);
    expect(card).toHaveTextContent('24 Sep 2026, 10:18 · UTC: 03:18 UTC');
    expect(within(card).getByText(ROW.eventTypeLabel)).toBeInTheDocument();
    expect(within(card).getByText('Target: Midsommar Hospitality Co., Ltd.')).toBeInTheDocument();
    expect(within(card).getByText(ROW.summary)).toBeInTheDocument();
    expect(within(card).getByText('by Johan Strand · Outcome: partially approved')).toBeInTheDocument();
    expect(within(card).queryByText(ROW.eventType)).toBeNull();
  });

  it('a phone card has no Target line when the event has no target', () => {
    render(<AuditTable rows={[{ ...ROW, targetLabel: null, targetUserId: null }]} labels={labels} />);
    expect(within(cards()).queryByText(/^Target:/)).toBeNull();
  });

  it('AURA 5.60 (#174): only codes, ids and payload values break anywhere; the labels wrap between words', () => {
    render(<AuditTable rows={[ROW]} labels={labels} />);
    const table = screen.getByRole('table');
    const row = within(table).getAllByRole('row')[1]!;
    for (const cell of within(row).getAllByRole('cell')) expect(cell).not.toHaveClass('is-wrap-anywhere');
    expect(within(table).getByText(ROW.eventType)).toHaveClass('[overflow-wrap:anywhere]');
    expect(within(table).getByText('partially approved')).toHaveClass('[overflow-wrap:anywhere]');
  });

  it('the table keeps the event with its raw code under it', () => {
    render(<AuditTable rows={[ROW]} labels={labels} />);
    const cell = within(table()).getByText(ROW.eventTypeLabel).closest('td')!;
    expect(within(cell).getByText(ROW.eventType)).toBeInTheDocument();
  });

  it('the table keeps the dual timestamp: the local time on a <time> and the UTC instant named as UTC', () => {
    render(<AuditTable rows={[ROW]} labels={labels} />);
    const time = within(table()).getByText(ROW.occurredAtLocal);
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('dateTime', ROW.occurredAtUtc);
    expect(within(table()).getByText(ROW.occurredAtUtc, { exact: false }).textContent).toContain('UTC');
  });

  it('the table shows the payload as label/value pairs, and "None" when there is none', () => {
    render(<AuditTable rows={[ROW, { ...ROW, id: 'a-2', payloadEntries: [] }]} labels={labels} />);
    const dt = within(table()).getByText('Outcome:');
    expect(dt.tagName).toBe('DT');
    expect(dt.nextElementSibling).toHaveTextContent('partially approved');
    expect(within(table()).getByText(labels.none)).toBeInTheDocument();
  });

  it('shows the empty state when nothing matches', () => {
    render(<AuditTable rows={[]} labels={labels} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText(labels.emptyTitle)).toBeInTheDocument();
  });
});
