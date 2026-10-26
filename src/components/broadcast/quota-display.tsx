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
 *
 * 122 US12d-1 (T1235, board `Portal-broadcasts`): an AURA card. The head reads
 * the year on the left and "plan · renewal" on the right; each counter is a
 * label above its number; the bar, live region, testids and retry are kept.
 * The reserved part is drawn hatched beside the used part, with a legend and
 * the board's footnote (copy added with the user's approval, 24 Oct).
 *
 * 25 Oct (the user: one quota bar on the Dashboard and here): the bar is AURA
 * `Progress` with `secondaryValue`, as the Dashboard's; the legend shows only
 * while something is reserved (AURA `Progress` `legend`), and the bar turns danger once
 * the quota is used up.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Card, Progress, buttonClass } from '@jirawatpyk/aura-react';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
import { formatCalendarYear } from '@/lib/format-date-localised';
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
  /** AS1: localised "Resets on <date>" copy rendered inside the card footer. */
  readonly nextResetCopy?: string | null;
  /** AS2: localised "Plan changed on <date>" explainer when applicable. */
  readonly planChangedExplainer?: string | null;
  /**
   * F119 T145 (FR-039) — where the counter comes from. The member's own
   * allowance is the default; the staff compose-on-behalf form passes
   * `/api/admin/broadcasts/quota?memberId=<picked member>`, which returns the
   * IDENTICAL envelope (`src/lib/broadcasts-draft-response.ts`). Changing it
   * re-fetches, so picking a different member shows that member's allowance
   * rather than a stale one.
   */
  readonly endpoint?: string;
  /**
   * Spec 122 US12d-1 — `false` renders `initial` as given and never fetches:
   * the preview harness shows the card without a session. Pages leave it on.
   */
  readonly live?: boolean;
  /**
   * Spec 122 US12d-3 (T1265) — the numbers the card shows, each time a fetch
   * lands, so the compose form's submit confirmation names the same remaining
   * allowance as the bar rather than the page's first paint.
   */
  readonly onLoaded?: (snapshot: QuotaSnapshot) => void;
}

export function QuotaDisplay({
  refreshKey = 0,
  initial = null,
  showComposeCta = false,
  nextResetCopy = null,
  planChangedExplainer = null,
  endpoint = '/api/broadcasts/quota',
  live = true,
  onLoaded,
}: QuotaDisplayProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.quota');
  const tCompose = useTranslations('portal.broadcasts.compose');
  // U30 — the year is a DISPLAY value and goes through the same calendar the
  // reset date beside it uses; the card used to print a raw CE integer above a
  // BE date. Storage is untouched (CLAUDE.md § Conventions).
  const locale = useLocale();
  const [snap, setSnap] = useState<QuotaSnapshot | null>(initial);
  const [loading, setLoading] = useState<boolean>(live && initial === null);
  const [error, setError] = useState<boolean>(false);
  const [retryNonce, setRetryNonce] = useState<number>(0);
  // Held in a ref so a caller's inline callback never re-runs the fetch.
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(false);
      try {
        const res = await fetch(endpoint, {
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
          const next: QuotaSnapshot = {
            used: body.used,
            reserved: body.reserved,
            remaining: body.remaining,
            cap: body.cap,
            quotaYear: body.quotaYear,
            planName: body.planName ?? null,
          };
          setSnap(next);
          onLoadedRef.current?.(next);
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
  }, [endpoint, live, refreshKey, retryNonce]);

  const exhausted = snap !== null && snap.remaining === 0;

  const showReset = nextResetCopy !== null && snap !== null && !error;

  return (
    <Card aria-busy={loading} data-testid="quota-display" data-compose-feature="quota">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="font-semibold">
            {t('headerLabel', {
              year: formatCalendarYear(
                snap === null ? new Date().getFullYear() : snap.quotaYear,
                locale,
              ),
            })}
          </span>
          {snap?.planName || showReset ? (
            <span className="aura-text-caption text-[var(--aura-fg-secondary)]">
              {snap?.planName ? t('planLabel', { plan: snap.planName }) : null}
              {snap?.planName && showReset ? ' · ' : null}
              {/* AS1 reset-date copy: quota metadata, beside the plan
                  (board `Portal-broadcasts`). */}
              {showReset ? <span data-testid="quota-next-reset">{nextResetCopy}</span> : null}
            </span>
          ) : null}
        </div>
        {error ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="aura-text-caption text-[var(--aura-fg-danger)]">{t('fetchError')}</p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              touchHeight
              onClick={() => setRetryNonce((n) => n + 1)}
            >
              {t('retry')}
            </Button>
          </div>
        ) : snap !== null ? (
          <>
            <div className="grid grid-cols-4 gap-2 max-[359px]:grid-cols-2 sm:gap-4" aria-live="polite">
              <Counter label={t('used')} value={snap.used} />
              <Counter label={t('reserved')} value={snap.reserved} />
              <Counter label={t('remaining')} value={snap.remaining} emphasise={exhausted} />
              <Counter label={t('cap')} value={snap.cap} />
            </div>
            {/* AURA clamps used + reserved to the bar, as the old hand-drawn one did (P6). */}
            <Progress
              aria-label={t('progressLabel')}
              value={snap.used}
              secondaryValue={snap.reserved}
              max={snap.cap}
              tone={exhausted ? 'danger' : 'accent'}
              valueText={t('valueText', {
                used: snap.used,
                reserved: snap.reserved,
                remaining: snap.remaining,
                cap: snap.cap,
              })}
              // AURA's key (5.64.0, #179): shown only while the reserved part
              // is drawn, aria-hidden, swatches in the bar's tone.
              legend={{ value: t('used'), secondary: t('reservedLegend') }}
            />
            {exhausted ? (
              <p className="aura-text-caption text-[var(--aura-fg-danger)]">
                {/* Says what is still reserved, not "all used" (the user, 25 Oct). */}
                {t('exhausted', {
                  year: formatCalendarYear(snap.quotaYear, locale),
                  reserved: snap.reserved,
                })}
              </p>
            ) : showComposeCta ? (
              <Link
                href="/portal/broadcasts/new"
                className={buttonClass({ size: 'sm', touchHeight: true, className: 'self-start' })}
              >
                {tCompose('title')}
              </Link>
            ) : null}
            <p className="aura-text-caption text-[var(--aura-fg-secondary)]">{t('footnote')}</p>
            {/* AS2 plan-changed explainer — quota metadata inside the card. */}
            {planChangedExplainer !== null ? (
              <p
                data-testid="quota-plan-changed-explainer"
                className="aura-text-caption text-[var(--aura-fg-warning)]"
              >
                {planChangedExplainer}
              </p>
            ) : null}
          </>
        ) : (
          // G1 UX hardening — skeleton MUST mirror the real layout
          // (4-counter grid + progress bar + footer line) or the
          // page jumps when data arrives (CLS).
          <>
            <div className="grid grid-cols-4 gap-2 max-[359px]:grid-cols-2 sm:gap-4" aria-hidden="true">
              <SkeletonBlock className="h-14 w-full" />
              <SkeletonBlock className="h-14 w-full" />
              <SkeletonBlock className="h-14 w-full" />
              <SkeletonBlock className="h-14 w-full" />
            </div>
            <SkeletonBlock className="h-2 w-full" aria-hidden="true" />
            <SkeletonBlock className="h-4 w-48" aria-hidden="true" />
          </>
        )}
      </div>
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
  // Board `Portal-broadcasts`: the label above its number, left-aligned; four
  // in a row (`-mobile`), the number a step smaller on phones. Below 360px two
  // per row: at 320 "Remaining", "Reserverat" and "Paketgräns" broke mid-word.
  return (
    <div className="flex flex-col gap-0.5">
      <span className="aura-text-caption break-words text-[var(--aura-fg-secondary)]">{label}</span>
      <span
        className={cn(
          'text-xl font-semibold tabular-nums sm:text-2xl',
          emphasise && 'text-[var(--aura-fg-danger)]',
        )}
      >
        {value}
      </span>
    </div>
  );
}
