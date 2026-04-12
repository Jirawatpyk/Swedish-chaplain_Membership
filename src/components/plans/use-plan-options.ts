/**
 * Shared Select option arrays for plan forms — single source of truth
 * for items that appear in both plan-form-wizard and plan-edit-form.
 *
 * Uses useTranslations + useMemo so labels render in the active locale.
 */
'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

export function usePlanOptions() {
  const tOpts = useTranslations('admin.plans.create.options');

  const categoryOptions = useMemo(() => [
    { value: 'corporate', label: tOpts('planCategory.corporate') },
    { value: 'partnership', label: tOpts('planCategory.partnership') },
  ], [tOpts]);

  const memberTypeOptions = useMemo(() => [
    { value: 'company', label: tOpts('memberTypeScope.company') },
    { value: 'individual', label: tOpts('memberTypeScope.individual') },
    { value: 'both', label: tOpts('memberTypeScope.both') },
  ], [tOpts]);

  return { categoryOptions, memberTypeOptions };
}
