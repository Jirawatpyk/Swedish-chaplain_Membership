/**
 * F8 Phase 8 Round 5 review-fix I-11 close — `<YearInCyclePill>` unit
 * tests. Pins:
 *   - Single-year (1/1) collapses the year prefix to just the task type
 *   - Multi-year (2/3) renders "Year 2 of 3 · {taskType}" in compact
 *   - Full variant exposes both pill prefix + company name
 *   - Compact variant carries an `aria-label` for AT parity (I-22)
 *   - Defensive against invalid totalYears (0 / NaN treated as single-
 *     year — no "Year X of 0" rendered)
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { YearInCyclePill } from '@/app/(staff)/admin/renewals/_components/year-in-cycle-pill';

const messages = {
  admin: {
    renewals: {
      tasks: {
        yearInCycle: {
          pill: 'Year {year} of {total}',
          aria_label: 'Year {year} of {total} · {taskType} · {company}',
          aria_label_no_company: 'Year {year} of {total} · {taskType}',
        },
      },
    },
  },
};

function renderPill(props: React.ComponentProps<typeof YearInCyclePill>) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <YearInCyclePill {...props} />
    </NextIntlClientProvider>,
  );
}

describe('<YearInCyclePill> (F8 T220 / Phase 8 R5 I-11)', () => {
  it('single-year (1/1) collapses to just the task-type label', () => {
    renderPill({
      yearInCycle: 1,
      totalYears: 1,
      taskTypeLabel: 'Phone call',
    });
    expect(screen.queryByText(/year 1 of 1/i)).toBeNull();
    expect(screen.getByText('Phone call')).toBeInTheDocument();
  });

  it('multi-year (2/3) renders "Year 2 of 3" prefix in compact', () => {
    renderPill({
      yearInCycle: 2,
      totalYears: 3,
      taskTypeLabel: 'Quarterly review',
    });
    expect(screen.getByText('Year 2 of 3')).toBeInTheDocument();
    expect(screen.getByText('Quarterly review')).toBeInTheDocument();
  });

  it('full variant renders pill + task type + company name', () => {
    renderPill({
      yearInCycle: 2,
      totalYears: 3,
      taskTypeLabel: 'Quarterly review',
      memberCompanyName: 'Fogmaker AB',
      variant: 'full',
    });
    expect(screen.getByText('Year 2 of 3')).toBeInTheDocument();
    expect(screen.getByText('Quarterly review')).toBeInTheDocument();
    expect(screen.getByText('Fogmaker AB')).toBeInTheDocument();
  });

  it('full variant exposes the canonical aria-label', () => {
    renderPill({
      yearInCycle: 2,
      totalYears: 3,
      taskTypeLabel: 'Quarterly review',
      memberCompanyName: 'Fogmaker AB',
      variant: 'full',
    });
    expect(
      screen.getByLabelText('Year 2 of 3 · Quarterly review · Fogmaker AB'),
    ).toBeInTheDocument();
  });

  it('full variant without company name falls through to compact', () => {
    renderPill({
      yearInCycle: 2,
      totalYears: 3,
      taskTypeLabel: 'Quarterly review',
      variant: 'full',
    });
    // Compact aria-label uses the bullet-separated short form because
    // there's no company name to interpolate into the canonical aria.
    expect(screen.queryByText('Fogmaker AB')).toBeNull();
    expect(screen.getByText('Quarterly review')).toBeInTheDocument();
  });

  it('compact variant carries an aria-label for AT parity (I-22)', () => {
    const { container } = renderPill({
      yearInCycle: 2,
      totalYears: 3,
      taskTypeLabel: 'Phone call',
    });
    const labelled = container.querySelector('[aria-label]');
    expect(labelled).not.toBeNull();
    expect(labelled?.getAttribute('aria-label')).toContain('Year 2 of 3');
    expect(labelled?.getAttribute('aria-label')).toContain('Phone call');
  });

  it('compact single-year aria-label is the task-type label only', () => {
    const { container } = renderPill({
      yearInCycle: 1,
      totalYears: 1,
      taskTypeLabel: 'Phone call',
    });
    const labelled = container.querySelector('[aria-label]');
    expect(labelled?.getAttribute('aria-label')).toBe('Phone call');
  });

  // R6 close — defensive against invalid totalYears claimed by the
  // file header. `showYearPrefix = totalYears > 1` collapses to false
  // for 0 / NaN / negative inputs; tests pin that contract.
  it('totalYears=0 collapses to single-year (no "Year 1 of 0" rendered)', () => {
    renderPill({
      yearInCycle: 1,
      totalYears: 0,
      taskTypeLabel: 'Phone call',
    });
    expect(screen.queryByText(/year 1 of 0/i)).toBeNull();
    expect(screen.getByText('Phone call')).toBeInTheDocument();
  });

  it('totalYears=NaN treated as single-year', () => {
    renderPill({
      yearInCycle: 1,
      totalYears: Number.NaN,
      taskTypeLabel: 'Phone call',
    });
    expect(screen.queryByText(/year/i)).toBeNull();
    expect(screen.getByText('Phone call')).toBeInTheDocument();
  });

  it('totalYears=-1 (negative) treated as single-year', () => {
    renderPill({
      yearInCycle: 1,
      totalYears: -1,
      taskTypeLabel: 'Phone call',
    });
    expect(screen.queryByText(/year/i)).toBeNull();
    expect(screen.getByText('Phone call')).toBeInTheDocument();
  });

  // R6 UX-I-3 close — when memberCompanyName is undefined and we have
  // a year prefix, the compact aria-label uses the dedicated
  // aria_label_no_company key (no raw template string concatenation).
  it('full-without-company falls through to compact aria_label_no_company key', () => {
    const { container } = renderPill({
      yearInCycle: 2,
      totalYears: 3,
      taskTypeLabel: 'Quarterly review',
      variant: 'full',
    });
    const labelled = container.querySelector('[aria-label]');
    expect(labelled?.getAttribute('aria-label')).toBe(
      'Year 2 of 3 · Quarterly review',
    );
  });
});
