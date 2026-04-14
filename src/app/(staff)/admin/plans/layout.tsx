/**
 * Thin passthrough kept so Next.js route resolution still visits this
 * segment. A plans-wide data provider or state context (e.g. a selected
 * plan for bulk operations) can be introduced here without touching
 * individual page files.
 */
import type { ReactNode } from 'react';

export default function PlansLayout({ children }: { children: ReactNode }) {
  return children;
}
