'use client';

/**
 * T081 (F7.1a US2) — Inline banner shown on member compose when the
 * ClamAV daemon is unreachable. Auto-clears on next successful health
 * probe.
 *
 * Behaviour:
 *   - Polls the caller's `healthEndpoint` every 30s — and nothing at all
 *     when none is passed (U34 below; no caller passes one today)
 *   - Renders only when the most-recent probe failed (ok=false or
 *     network error)
 *   - role="status" + aria-live="polite" so SR users hear the state
 *     change without focus-stealing
 *
 * The health endpoint is a thin wrapper around
 * `VirusScannerPort.scan(emptyBuffer)`; the endpoint is OUT OF SCOPE
 * for Phase 4 in this commit. The endpoint will be added by the Wave J
 * observability gap-fill once the ClamAV runbook (T124) lands.
 *
 * F119 walk U34 (2026-09-23) — the component used to poll the hard-coded
 * `/api/internal/clamav/health` anyway, and that route does NOT exist, so
 * every open compose tab logged a 404 on mount and every 30 s. It is now
 * INERT unless a caller passes `healthEndpoint`: no request, no DOM (not
 * even the live region). `tiptap-editor.tsx` passes none today.
 * TODO(U34): when a real health route ships under `src/app/api/`, pass its
 * path from `tiptap-editor.tsx` — the probe + persistent live region below
 * come back unchanged.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert } from '@jirawatpyk/aura-react';

export interface ClamavUnreachableBannerProps {
  /**
   * The ClamAV health route to poll. Omitted → the banner renders nothing and
   * makes no request (U34 — no such route exists yet).
   */
  readonly healthEndpoint?: string;
}

export function ClamavUnreachableBanner({
  healthEndpoint,
}: ClamavUnreachableBannerProps = {}): React.ReactElement | null {
  const t = useTranslations('portal.broadcasts.compose.clamavBanner');
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    if (healthEndpoint === undefined) return undefined;
    let cancelled = false;
    // Spec 122 US12d-2 round 2 (#17): an offline browser says nothing about
    // the scanner, so it is not reported as "scanner down"; a hidden tab is
    // not polled (it probes again when shown); and a probe that hangs gives
    // up after 10 s.
    // Round 3 (UX review): one probe at a time, aborted on unmount; going
    // offline clears a banner already shown.
    let inFlight: AbortController | null = null;
    const probe = async (): Promise<void> => {
      if (!navigator.onLine) {
        setUnreachable(false);
        return;
      }
      if (document.visibilityState === 'hidden' || inFlight !== null) return;
      const controller = new AbortController();
      inFlight = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(healthEndpoint, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (cancelled) return;
        if (!res.ok) {
          // 404 (endpoint not yet shipped) treated as "no signal" —
          // keep banner hidden so we don't false-alarm during early
          // F7.1a rollout.
          if (res.status === 404) {
            setUnreachable(false);
            return;
          }
          setUnreachable(true);
          return;
        }
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
        };
        setUnreachable(body.ok === false);
      } catch (err) {
        // PR-review fix 2026-05-20 SF-M2 — log probe failure so
        // CSP/CORS/offline are distinguishable in browser console
        // (silent setUnreachable(true) made the cause invisible).
        if (cancelled) return;
         
        console.warn(
          { err: String(err) },
          'broadcasts.clamav_health_probe_failed',
        );
        if (!navigator.onLine) return;
        setUnreachable(true);
      } finally {
        window.clearTimeout(timeout);
        inFlight = null;
      }
    };
    const probeWhenShown = (): void => {
      if (document.visibilityState === 'visible') void probe();
    };
    void probe();
    const id = window.setInterval(probe, 30_000);
    document.addEventListener('visibilitychange', probeWhenShown);
    window.addEventListener('online', probeWhenShown);
    return (): void => {
      cancelled = true;
      inFlight?.abort();
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', probeWhenShown);
      window.removeEventListener('online', probeWhenShown);
    };
  }, [healthEndpoint]);

  if (healthEndpoint === undefined) return null;

  // PR-review fix 2026-05-20 UX-C2 — persistent live-region wrapper.
  // The outer <div role="status" aria-live="polite"> MUST be in the
  // DOM at all times so screen readers announce the state CHANGE
  // (content mutation), not the element-mount event (which NVDA/JAWS
  // do not announce reliably for late-mounted live regions).
  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      {unreachable ? (
        // Spec 122 US12d-2 — an AURA warning Alert (its tokens carry the
        // contrast H5 fixed by hand). `role="none"`: the wrapper above is
        // the live region, so the Alert must not be a second one.
        <Alert tone="warning" role="none" title={t('title')}>
          {t('description')}
        </Alert>
      ) : null}
    </div>
  );
}
