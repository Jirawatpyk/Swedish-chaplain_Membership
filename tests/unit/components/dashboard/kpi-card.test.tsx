/**
 * KpiCard — label + value + optional basis caption.
 *
 * The caption is the disambiguator that lets the dashboard keep short KPI
 * labels while every tile still states its own basis (e.g. revenue is
 * fiscal-year/ex-VAT, distinct from the VAT-inclusive donut). These tests pin
 * that the caption renders when given and is absent — not an empty node — when
 * omitted, so a card without a basis note stays clean.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KpiCard } from '@/components/dashboard/kpi-card';

describe('KpiCard', () => {
  it('renders the label and value', () => {
    render(<KpiCard label="Total members" value="477" />);
    expect(screen.getByText('Total members')).toBeInTheDocument();
    expect(screen.getByText('477')).toBeInTheDocument();
  });

  it('renders the basis caption when provided', () => {
    render(<KpiCard label="Paid revenue" value="฿ 1,632,645" caption="Fiscal year to date · ex-VAT" />);
    expect(screen.getByText('Fiscal year to date · ex-VAT')).toBeInTheDocument();
  });

  it('renders no caption element when caption is omitted', () => {
    const { container } = render(<KpiCard label="Active members" value="475" />);
    // Only the label + value text nodes — no stray empty <p> for the caption.
    expect(container.querySelector('p')).toBeNull();
  });
});
