'use client';

/**
 * T089 — Quota display (used / reserved / remaining / cap).
 *
 * Fetches `GET /api/broadcasts/quota` on mount + on `refreshKey` change.
 * Progress bar turns destructive when remaining=0. Displays the four
 * counters per FR-003.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface QuotaSnapshot {
  readonly used: number;
  readonly reserved: number;
  readonly remaining: number;
  readonly cap: number;
  readonly quotaYear: number;
}

export interface QuotaDisplayProps {
  /** Bumping this re-fetches (e.g., after a successful submit). */
  readonly refreshKey?: number;
  /** Initial value for SSR + first paint. */
  readonly initial?: QuotaSnapshot | null;
}

export function QuotaDisplay({
  refreshKey = 0,
  initial = null,
}: QuotaDisplayProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.quota');
  const [snap, setSnap] = useState<QuotaSnapshot | null>(initial);
  const [loading, setLoading] = useState<boolean>(initial === null);
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(false);
      try {
        const res = await fetch('/api/broadcasts/quota', {
          credentials: 'same-origin',
        });
        if (!res.ok) {
          if (!cancelled) {
            setSnap(null);
            setError(true);
          }
          return;
        }
        const body = (await res.json()) as {
          quotaYear: number;
          used: number;
          reserved: number;
          remaining: number;
          cap: number;
        };
        if (!cancelled) {
          setSnap({
            used: body.used,
            reserved: body.reserved,
            remaining: body.remaining,
            cap: body.cap,
            quotaYear: body.quotaYear,
          });
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const pct =
    snap && snap.cap > 0 ? ((snap.used + snap.reserved) / snap.cap) * 100 : 0;
  const exhausted = snap !== null && snap.remaining === 0;

  return (
    <Card aria-busy={loading} aria-live="polite">
      <CardContent className="space-y-3 pt-6">
        <div className="text-sm font-medium">
          {snap === null
            ? t('headerLabel', { year: new Date().getFullYear() })
            : t('headerLabel', { year: snap.quotaYear })}
        </div>
        {error ? (
          <p className="text-xs text-destructive">{t('fetchError')}</p>
        ) : snap !== null ? (
          <>
            <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4 sm:gap-2">
              <Counter label={t('used')} value={snap.used} />
              <Counter label={t('reserved')} value={snap.reserved} />
              <Counter
                label={t('remaining')}
                value={snap.remaining}
                emphasise={exhausted}
              />
              <Counter label={t('cap')} value={snap.cap} />
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={snap.used + snap.reserved}
              aria-valuemax={snap.cap}
              aria-valuemin={0}
              aria-label={t('progressLabel')}
            >
              <div
                className={cn(
                  'h-full transition-all',
                  exhausted ? 'bg-destructive' : 'bg-primary',
                )}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            {exhausted ? (
              <p className="text-xs text-destructive">
                {t('exhausted', { year: snap.quotaYear })}
              </p>
            ) : null}
          </>
        ) : (
          <Skeleton className="h-12 w-full" />
        )}
      </CardContent>
    </Card>
  );
}

function Counter({
  label,
  value,
  emphasise = false,
}: {
  readonly label: string;
  readonly value: number;
  readonly emphasise?: boolean;
}): React.ReactElement {
  return (
    <div>
      <div
        className={cn(
          'text-2xl font-semibold tabular-nums',
          emphasise && 'text-destructive',
        )}
      >
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
