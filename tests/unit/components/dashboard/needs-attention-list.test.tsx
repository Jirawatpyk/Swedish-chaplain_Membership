/**
 * Spec 122 US11 — the "Needs attention" rows follow board `Admin-dashboard`:
 * one link per row holding a row icon, the label, the count pill and a
 * chevron; rows divided; the overdue-invoices pill is the danger tone.
 * Labels, counts and hrefs are the caller's and stay unchanged (FR-011).
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NeedsAttentionList, type NeedsAttentionItem } from '@/components/dashboard/needs-attention-list';

const items: NeedsAttentionItem[] = [
  { id: 'overdueInvoices', label: 'Overdue invoices', href: '/admin/invoices?status=overdue', count: '6', tone: 'danger' },
  { id: 'atRisk', label: 'At-risk members', href: '/admin/members?risk_band=critical,at-risk,warning', count: '9' },
  { id: 'broadcasts', label: 'E-Blasts awaiting approval', href: '/admin/broadcasts', count: '2' },
  { id: 'changeRequests', label: 'Change requests waiting', href: '/admin/change-requests', count: '3' },
];

function renderList() {
  return render(<NeedsAttentionList title="Needs attention" emptyLabel="All clear" items={items} />);
}

describe('NeedsAttentionList rows (board)', () => {
  it('each row is one link holding a decorative icon, the count pill and a decorative chevron', () => {
    renderList();
    for (const item of items) {
      const link = screen.getByRole('link', { name: new RegExp(`^${item.label}`) });
      expect(link.getAttribute('href')).toBe(item.href);
      const svgs = link.querySelectorAll('svg');
      expect(svgs).toHaveLength(2);
      svgs.forEach((svg) => expect(svg.getAttribute('aria-hidden')).toBe('true'));
      expect(within(link).getByText(item.count).className).toContain('aura-badge');
    }
  });

  it('the overdue pill is solid danger; the others stay accent', () => {
    renderList();
    const overdue = within(screen.getByRole('link', { name: /^Overdue invoices/ })).getByText('6');
    expect(overdue.className).toContain('aura-badge--danger');
    expect(overdue.className).toContain('is-solid');
    const atRisk = within(screen.getByRole('link', { name: /^At-risk members/ })).getByText('9');
    expect(atRisk.className).toContain('aura-badge--accent');
    expect(atRisk.className).not.toContain('aura-badge--danger');
  });

  it('rows are divided by AURA border dividers', () => {
    renderList();
    const list = screen.getByRole('list');
    expect(list.className).toContain('divide-y');
    expect(list.className).toContain('divide-[var(--aura-border-default)]');
  });
});
