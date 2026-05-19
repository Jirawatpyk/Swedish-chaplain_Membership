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
  const t = useTranslations('member.broadcasts.compose.clamavBanner');
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
      } catch {
        if (!cancelled) setUnreachable(true);
      }
    };
    void probe();
    const id = window.setInterval(probe, 30_000);
    return (): void => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!unreachable) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 p-3 border border-warning rounded bg-warning/10"
    >
      <AlertCircle className="w-4 h-4 mt-0.5 text-warning" aria-hidden />
      <div>
        <p className="text-body font-medium">{t('title')}</p>
        <p className="text-caption">{t('description')}</p>
      </div>
    </div>
  );
}
