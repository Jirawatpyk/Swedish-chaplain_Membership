/* eslint-disable react-hooks/globals -- test probes legitimately capture hook return values into outer variables */
import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { useEffect, useRef } from 'react';

import {
  BreadcrumbProvider,
  useBreadcrumbLabels,
  useBreadcrumbLabelMap,
} from '@/components/layout/breadcrumb-provider';

describe('<BreadcrumbProvider>', () => {
  it('context Map starts empty', () => {
    let observed: ReadonlyMap<string, string> | null = null;
    function Probe() {
      observed = useBreadcrumbLabelMap();
      return null;
    }
    render(
      <BreadcrumbProvider>
        <Probe />
      </BreadcrumbProvider>,
    );
    expect(observed).not.toBeNull();
    expect(observed!.size).toBe(0);
  });

  it('setLabel registers and overwrites a segment→label pair', () => {
    let api: ReturnType<typeof useBreadcrumbLabels> | null = null;
    let map: ReadonlyMap<string, string> | null = null;
    function Probe() {
      api = useBreadcrumbLabels();
      map = useBreadcrumbLabelMap();
      return null;
    }
    render(
      <BreadcrumbProvider>
        <Probe />
      </BreadcrumbProvider>,
    );

    act(() => api!.setLabel('abc', 'First'));
    expect(map!.get('abc')).toBe('First');

    act(() => api!.setLabel('abc', 'Second'));
    expect(map!.get('abc')).toBe('Second');
  });

  it('setLabel keeps a stable reference across re-renders', () => {
    const seen: Array<(segment: string, label: string) => void> = [];
    function Probe() {
      const api = useBreadcrumbLabels();
      const ref = useRef(api.setLabel);
      useEffect(() => {
        seen.push(api.setLabel);
        ref.current = api.setLabel;
      });
      return null;
    }
    const { rerender } = render(
      <BreadcrumbProvider>
        <Probe />
      </BreadcrumbProvider>,
    );
    rerender(
      <BreadcrumbProvider>
        <Probe />
      </BreadcrumbProvider>,
    );
    // Both renders must produce the same setLabel reference — a missing
    // second effect is itself a regression.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[1]).toBe(seen[0]);
  });

  it('returns empty map and no-op setter when used outside provider', () => {
    let api: ReturnType<typeof useBreadcrumbLabels> | null = null;
    let map: ReadonlyMap<string, string> | null = null;
    function Probe() {
      api = useBreadcrumbLabels();
      map = useBreadcrumbLabelMap();
      return null;
    }
    render(<Probe />);
    expect(map!.size).toBe(0);
    expect(() => api!.setLabel('x', 'y')).not.toThrow();
  });
});
