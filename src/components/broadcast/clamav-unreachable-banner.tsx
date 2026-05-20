'use client';

/**
 * T081 (F7.1a US2) — Inline banner shown on member compose when the
 * ClamAV daemon is unreachable. Auto-clears on next successful health
 * probe.
 *
 * Behaviour:
 *   - Polls `GET /api/internal/clamav/health` every 30s
 *   - Renders only when the most-recent probe failed (ok=false or
 *     network error)
 *   - role="status" + aria-live="polite" so SR users hear the state
 *     change without focus-stealing
 *
 * The health endpoint is a thin wrapper around
 * `VirusScannerPort.scan(emptyBuffer)`; the endpoint is OUT OF SCOPE
 * for Phase 4 in this commit — the component renders an empty fragment
 * when the endpoint 404s, keeping the surface inert. The endpoint will
 * be added by the Wave J observability gap-fill once the ClamAV runbook
 * (T124) lands.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle } from 'lucide-react';

export function ClamavUnreachableBanner(): React.ReactElement | null {
  const t = useTranslations('portal.broadcasts.compose.clamavBanner');
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const probe = async (): Promise<void> => {
      try {
        const res = await fetch('/api/internal/clamav/health', {
          cache: 'no-store',
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
        // eslint-disable-next-line no-console
        console.warn(
          { err: String(err) },
          'broadcasts.clamav_health_probe_failed',
        );
        setUnreachable(true);
      }
    };
    void probe();
    const id = window.setInterval(probe, 30_000);
    return (): void => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // PR-review fix 2026-05-20 UX-C2 — persistent live-region wrapper.
  // The outer <div role="status" aria-live="polite"> MUST be in the
  // DOM at all times so screen readers announce the state CHANGE
  // (content mutation), not the element-mount event (which NVDA/JAWS
  // do not announce reliably for late-mounted live regions).
  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      {unreachable ? (
        <div className="flex items-start gap-2 p-3 border border-warning rounded bg-warning/10">
          <AlertCircle className="w-4 h-4 mt-0.5 text-warning" aria-hidden />
          <div>
            <p className="text-body font-medium">{t('title')}</p>
            <p className="text-caption">{t('description')}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
