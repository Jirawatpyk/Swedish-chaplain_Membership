'use client';

import { useEffect } from 'react';

import { useBreadcrumbLabels } from '@/components/layout/breadcrumb-provider';

/**
 * Registers a dynamic breadcrumb label for the given URL segment.
 *
 * Pages drop this component into the tree once the label is known
 * (typically right after fetching the plan / resource). Re-renders are
 * safe — setLabel is a stable callback, and duplicate values short-circuit.
 *
 * Originally named `PlanBreadcrumbLabel` for F2 — the implementation is
 * fully generic. Use `DynamicBreadcrumbLabel` alias below at new
 * call-sites; both export the same component.
 */
export function PlanBreadcrumbLabel({
  segment,
  label,
}: {
  segment: string;
  label: string;
}) {
  const { setLabel } = useBreadcrumbLabels();
  useEffect(() => {
    setLabel(segment, label);
  }, [segment, label, setLabel]);
  return null;
}

/**
 * Generic alias — use this name in new feature work where the page
 * is not plan-related (events, invoices, members, etc.).
 */
export const DynamicBreadcrumbLabel = PlanBreadcrumbLabel;
