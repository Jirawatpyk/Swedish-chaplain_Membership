'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type BreadcrumbLabelsApi = {
  setLabel: (segment: string, label: string) => void;
};

const MISSING_PROVIDER_MESSAGE =
  '[BreadcrumbProvider] setLabel called outside <BreadcrumbProvider>. ' +
  'Wrap the route group with <BreadcrumbProvider>.';

const EMPTY_API: BreadcrumbLabelsApi = {
  setLabel:
    process.env.NODE_ENV === 'development'
      ? () => {
          throw new Error(MISSING_PROVIDER_MESSAGE);
        }
      : () => undefined,
};

const EMPTY_MAP: ReadonlyMap<string, string> = new Map();

const ApiContext = createContext<BreadcrumbLabelsApi>(EMPTY_API);
const MapContext = createContext<ReadonlyMap<string, string>>(EMPTY_MAP);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<ReadonlyMap<string, string>>(() => new Map());

  // Functional update keeps React 19 concurrent renders consistent — no
  // separate ref mirror, so the committed state is always the single
  // source of truth for consumers.
  const setLabel = useCallback((segment: string, label: string) => {
    setMap((prev) => {
      if (prev.get(segment) === label) return prev;
      const next = new Map(prev);
      next.set(segment, label);
      return next;
    });
  }, []);

  const api = useMemo<BreadcrumbLabelsApi>(() => ({ setLabel }), [setLabel]);

  return (
    <ApiContext.Provider value={api}>
      <MapContext.Provider value={map}>{children}</MapContext.Provider>
    </ApiContext.Provider>
  );
}

export function useBreadcrumbLabels(): BreadcrumbLabelsApi {
  return useContext(ApiContext);
}

export function useBreadcrumbLabelMap(): ReadonlyMap<string, string> {
  return useContext(MapContext);
}
