/**
 * AURA 5.91 #211 — a list's Clear handler lives in the component that renders
 * `<FilterBar>`, outside the phone Filters sheet's context, so it cannot call
 * `useFilterBarSheet()` itself. Mount this bridge as one of the bar's children
 * (FilterBar renders its children in the row or in the sheet, never both) and
 * read the sheet through its ref: in the sheet, `focusDone()` before the
 * pressed control unmounts; outside, focus the bar's own search as before.
 */
'use client';

import { forwardRef, useImperativeHandle, useRef } from 'react';
import { useFilterBarSheet } from '@jirawatpyk/aura-react';

export type FilterSheetHandle = ReturnType<typeof useFilterBarSheet>;

export const FilterSheetBridge = forwardRef<FilterSheetHandle>(function FilterSheetBridge(_props, ref) {
  // AURA keeps this object the same on every render.
  const sheet = useFilterBarSheet();
  useImperativeHandle(ref, () => sheet, [sheet]);
  return null;
});

/** The ref a list hands to its `FilterSheetBridge`. */
export function useFilterSheetRef() {
  return useRef<FilterSheetHandle>(null);
}
