// tests/unit/components/plans/locked-field-labels.test.ts
//
// The `prior_year_locked_fields` toast names the locked fields by their form
// labels, not by the raw API keys in `error.details.locked_fields`.

import { describe, it, expect } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { lockedFieldLabels } from '@/components/plans/locked-field-labels';
import { LOCKED_FIELDS_ON_PRIOR_YEAR } from '@/modules/plans';

const t = createTranslator({
  locale: 'en',
  messages: en,
  namespace: 'admin.plans.create.labels',
});

describe('lockedFieldLabels', () => {
  it('labels every prior-year locked field', () => {
    expect(lockedFieldLabels([...LOCKED_FIELDS_ON_PRIOR_YEAR], t)).toEqual([
      'Annual fee',
      'Minimum turnover',
      'Maximum turnover',
      'Max duration (years)',
      'Max member age',
      'Member type',
      'Bundled corporate plan',
      'Benefit matrix',
    ]);
  });

  it('keeps an unknown key as-is rather than dropping it', () => {
    expect(lockedFieldLabels(['annual_fee_minor_units', 'future_field'], t)).toEqual([
      'Annual fee',
      'future_field',
    ]);
  });

  it('ignores a missing or malformed list', () => {
    expect(lockedFieldLabels(undefined, t)).toEqual([]);
    expect(lockedFieldLabels('annual_fee_minor_units', t)).toEqual([]);
    expect(lockedFieldLabels([42, 'max_member_age'], t)).toEqual(['Max member age']);
  });
});
