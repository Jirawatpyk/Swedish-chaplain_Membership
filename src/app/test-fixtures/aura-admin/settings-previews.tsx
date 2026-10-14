'use client';

/**
 * 122 US10c (T1027) — client helpers for the member-change approval preview:
 * open the switch-off confirmation, or show the read-only refusal, by
 * clicking the real switch once the page has hydrated.
 */
import { useEffect, useRef, type ReactNode } from 'react';

function useClickSwitchOnce(ref: React.RefObject<HTMLDivElement | null>, before?: () => void) {
  useEffect(() => {
    let tries = 0;
    const id = window.setInterval(() => {
      const sw = ref.current?.querySelector<HTMLButtonElement>('[role="switch"]');
      if (sw || ++tries > 50) window.clearInterval(id);
      if (!sw) return;
      before?.();
      sw.click();
    }, 100);
    return () => window.clearInterval(id);
  }, [ref, before]);
}

/** `&dialog=off`: switching off with requests waiting opens the confirmation. */
export function OpenSwitchOffDialog({ children }: { readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useClickSwitchOnce(ref);
  return <div ref={ref}>{children}</div>;
}

const readOnlyFetch = () => {
  window.fetch = async () =>
    new Response(JSON.stringify({ error: 'read-only-mode' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
};

/** `state=readonly`: the PATCH is answered 503 read-only, so the inline alert shows. */
export function ShowReadOnlyRefusal({ children }: { readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useClickSwitchOnce(ref, readOnlyFetch);
  return <div ref={ref}>{children}</div>;
}
