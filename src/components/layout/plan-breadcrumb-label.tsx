'use client';

import { useEffect } from 'react';

import { useBreadcrumbLabels } from '@/components/layout/breadcrumb-provider';

/**
 * Registers a dynamic breadcrumb label for the given URL segment.
 *
 * Pages drop this component into the tree once the label is known
 * (typically right after fetching the plan / resource). Re-renders are
 * safe — setLabel is a stable callback, and duplicate values short-circuit.
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
