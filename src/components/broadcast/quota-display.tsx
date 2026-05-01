'use client';

/**
 * T089 — Quota display (used / reserved / remaining / cap).
 *
 * Fetches `GET /api/broadcasts/quota` on mount + on `refreshKey` change.
 * Progress bar turns destructive when remaining=0. Displays the four
 * counters per FR-003.
 *
 * Reviews applied (2026-04-30):
 *   - I1 — `aria-live` scoped to counter values only (was the entire
 *     Card → announced "Quota loading… Used 3 Reserved 1…" on every
 *     refresh)
 *   - I2 — error state has actionable Retry button instead of muted
 *     destructive text
 *   - Smart-4 — plan name + compose CTA when `remaining > 0`
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface QuotaSnapshot {
  readonly used: number;
  readonly reserved: number;
  readonly remaining: number;
  readonly cap: number;
  readonly quotaYear: number;
  /** Plan tier display name (e.g. "Premium Corporate"). Smart-4. */
  readonly planName?: string | null;
}

export interface QuotaDisplayProps {
  /** Bumping this re-fetches (e.g., after a successful submit). */
  readonly refreshKey?: number;
  /** Initial value for SSR + first paint. */
  readonly initial?: QuotaSnapshot | null;
  /** Show "Compose" deep-link when remaining>0 (Smart-4). Default false on compose page itself. */
  readonly showComposeCta?: boolean;
}

export function QuotaDisplay({
  refreshKey = 0,
  initial = null,
  showComposeCta = false,
}: QuotaDisplayProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.quota');
  const tCompose = useTranslations('portal.broadcasts.compose');
  const [snap, setSnap] = useState<QuotaSnapshot | null>(initial);
  const [loading, setLoading] = useState<boolean>(initial === null);
  const [error, setError] = useState<boolean>(false);
  const [retryNonce, setRetryNonce] = useState<number>(0);

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
          planName?: string | null;
        };
        if (!cancelled) {
          setSnap({
            used: body.used,
            reserved: body.reserved,
            remaining: body.remaining,
            cap: body.cap,
            quotaYear: body.quotaYear,
            planName: body.planName ?? null,
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
  }, [refreshKey, retryNonce]);

  // Clamp percentage at 100 to avoid race conditions where used+reserved
  // briefly exceeds cap (P6 finding).
  const rawPct =
    snap && snap.cap > 0 ? ((snap.used + snap.reserved) / snap.cap) * 100 : 0;
  const pct = Math.min(100, rawPct);
  const exhausted = snap !== null && snap.remaining === 0;
  const ariaValueNow = snap ? Math.min(snap.cap, snap.used + snap.reserved) : 0;

  return (
    <Card aria-busy={loading} data-testid="quota-display">
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-sm font-medium">
            {snap === null
              ? t('headerLabel', { year: new Date().getFullYear() })
              : t('headerLabel', { year: snap.quotaYear })}
          </div>
          {snap?.planName ? (
            <span className="text-xs text-muted-foreground">
              {t('planLabel', { plan: snap.planName })}
            </span>
          ) : null}
        </div>
        {error ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-destructive">{t('fetchError')}</p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setRetryNonce((n) => n + 1)}
            >
              {t('retry')}
            </Button>
          </div>
        ) : snap !== null ? (
          <>
            <div
              className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4 sm:gap-2"
              aria-live="polite"
            >
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
              aria-valuenow={ariaValueNow}
              aria-valuemax={snap.cap}
              aria-valuemin={0}
              aria-label={t('progressLabel')}
            >
              <div
                className={cn(
                  'h-full transition-all',
                  exhausted ? 'bg-destructive' : 'bg-primary',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            {exhausted ? (
              <p className="text-xs text-destructive">
                {t('exhausted', { year: snap.quotaYear })}
              </p>
            ) : showComposeCta ? (
              <Link
                href="/portal/broadcasts/new"
                className={cn(buttonVariants({ size: 'sm' }), 'mt-2')}
              >
                {tCompose('title')}
              </Link>
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
