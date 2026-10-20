/**
 * Spec 122 US12c-1 (parity comment, 20 Oct) — the approval-round detail's
 * Lifecycle timeline on AURA: one AURA Card titled at h2 like the other
 * cards, a hollow circle per past step and a check on the latest one (board
 * `Admin-broadcast-review`), and no legacy colour tokens. The rows and their
 * order come from the audit log unchanged.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { AuditTimelineView } from '@/components/broadcast/admin/audit-timeline';
import { InlineError } from '@/components/broadcast/approval/inline-error';

const events = [
  {
    key: 'broadcast_drafted-1',
    label: 'Drafted',
    instant: '2026-09-25T08:58:00.000Z',
    when: '25 Sep 2026, 15:58',
    actor: 'by anna.lindqvist@lindqvist.example',
    actorId: 'u-1',
  },
  {
    key: 'broadcast_submitted-2',
    label: 'Submitted',
    instant: '2026-09-25T09:40:00.000Z',
    when: '25 Sep 2026, 16:40',
    actor: 'by anna.lindqvist@lindqvist.example',
    actorId: 'u-1',
  },
] as const;

describe('AuditTimelineView', () => {
  it('is an AURA card titled at h2, its region named by the title', () => {
    render(<AuditTimelineView title="Lifecycle timeline" events={events} />);
    const heading = screen.getByRole('heading', { level: 2, name: 'Lifecycle timeline' });
    expect(heading.closest('.aura-card')).not.toBeNull();
    expect(screen.getByRole('region', { name: 'Lifecycle timeline' })).toBeInTheDocument();
  });

  it('lists the steps in order, the latest marked with a check', () => {
    render(<AuditTimelineView title="Lifecycle timeline" events={events} />);
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('p')?.textContent)).toEqual(['Drafted', 'Submitted']);
    expect(items[0]?.getAttribute('data-step')).toBe('past');
    expect(items[1]?.getAttribute('data-step')).toBe('latest');
    const time = items[1]?.querySelector('time');
    expect(time?.getAttribute('dateTime')).toBe('2026-09-25T09:40:00.000Z');
    expect(time?.textContent).toBe('25 Sep 2026, 16:40');
    expect(items[1]?.textContent).toContain('by anna.lindqvist@lindqvist.example');
  });

  it('shows the empty sentinel when there are no events', () => {
    render(<AuditTimelineView title="Lifecycle timeline" events={[]} />);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('uses AURA tokens, never the legacy kit colours', () => {
    const { container } = render(<AuditTimelineView title="Lifecycle timeline" events={events} />);
    expect(container.innerHTML).not.toMatch(/bg-muted|text-muted-foreground|text-primary/);
  });
});

describe('InlineError', () => {
  it('is coloured with the AURA danger token, not the legacy destructive one', () => {
    render(<InlineError id="e" message="Refused" />);
    const line = screen.getByRole('alert');
    expect(line.className).toContain('--aura-fg-danger');
    expect(line.className).not.toContain('text-destructive');
  });
});
