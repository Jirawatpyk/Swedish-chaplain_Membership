/**
 * Unit: formatOverrideWarning — maps a 422 validation-warning `details`
 * payload to a localised message key + values, replacing the old
 * `JSON.stringify(details)` that leaked raw server objects to admins.
 *
 * The translator is mocked to echo its key and capture its values so the
 * branching logic is asserted independently of the i18n templates (those
 * are covered by `check:i18n` parity).
 */
import { describe, expect, it } from 'vitest';
import { formatOverrideWarning } from '@/components/members/override-warning-message';

type Call = { key: string; values?: Record<string, unknown> };

function makeT() {
  const calls: Call[] = [];
  const t = ((key: string, values?: Record<string, unknown>) => {
    calls.push({ key, values });
    return key;
  }) as unknown as Parameters<typeof formatOverrideWarning>[1];
  return { t, calls };
}

const fmt = (n: number) => new Intl.NumberFormat().format(n);

describe('formatOverrideWarning', () => {
  it('turnover out of band with both bounds → turnoverOutOfBand', () => {
    const { t, calls } = makeT();
    const out = formatOverrideWarning(
      {
        type: 'turnover_out_of_band',
        turnoverThb: 500_000,
        band: { minThb: 1_000_000, maxThb: 2_000_000 },
      },
      t,
    );
    expect(out).toBe('warnings.turnoverOutOfBand');
    expect(calls.at(-1)?.values).toEqual({
      turnover: fmt(500_000),
      min: fmt(1_000_000),
      max: fmt(2_000_000),
    });
  });

  it('turnover with only a minimum → turnoverBelow', () => {
    const { t, calls } = makeT();
    const out = formatOverrideWarning(
      {
        type: 'turnover_out_of_band',
        turnoverThb: 500_000,
        band: { minThb: 1_000_000, maxThb: null },
      },
      t,
    );
    expect(out).toBe('warnings.turnoverBelow');
    expect(calls.at(-1)?.values).toEqual({
      turnover: fmt(500_000),
      min: fmt(1_000_000),
    });
  });

  it('turnover with only a maximum → turnoverAbove', () => {
    const { t } = makeT();
    expect(
      formatOverrideWarning(
        {
          type: 'turnover_out_of_band',
          turnoverThb: 9_000_000,
          band: { minThb: null, maxThb: 2_000_000 },
        },
        t,
      ),
    ).toBe('warnings.turnoverAbove');
  });

  it('turnover with no usable band → generic', () => {
    const { t } = makeT();
    expect(
      formatOverrideWarning(
        {
          type: 'turnover_out_of_band',
          turnoverThb: 500_000,
          band: { minThb: null, maxThb: null },
        },
        t,
      ),
    ).toBe('warnings.generic');
  });

  it('startup too old → startupTooOld with string values (years not grouped)', () => {
    const { t, calls } = makeT();
    const out = formatOverrideWarning(
      { type: 'startup_too_old', foundedYear: 2019, maxAllowedYears: 5 },
      t,
    );
    expect(out).toBe('warnings.startupTooOld');
    // String, not grouped — a year must render "2019" not "2,019".
    expect(calls.at(-1)?.values).toEqual({ year: '2019', maxYears: '5' });
  });

  it('age not eligible → ageNotEligible', () => {
    const { t, calls } = makeT();
    const out = formatOverrideWarning(
      { type: 'age_not_eligible', ageYears: 42, maxAge: 35 },
      t,
    );
    expect(out).toBe('warnings.ageNotEligible');
    expect(calls.at(-1)?.values).toEqual({ age: '42', maxAge: '35' });
  });

  it('unknown type → generic', () => {
    const { t } = makeT();
    expect(formatOverrideWarning({ type: 'something_new' }, t)).toBe(
      'warnings.generic',
    );
  });

  it('null / undefined / non-object details → generic (no throw)', () => {
    const { t } = makeT();
    expect(formatOverrideWarning(null, t)).toBe('warnings.generic');
    expect(formatOverrideWarning(undefined, t)).toBe('warnings.generic');
    expect(formatOverrideWarning('oops', t)).toBe('warnings.generic');
  });
});
