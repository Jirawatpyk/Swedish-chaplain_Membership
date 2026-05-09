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
});
