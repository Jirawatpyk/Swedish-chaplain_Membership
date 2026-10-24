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
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Card, buttonClass } from '@jirawatpyk/aura-react';
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
}

export function QuotaDisplay({
  refreshKey = 0,
  initial = null,
  showComposeCta = false,
  nextResetCopy = null,
  planChangedExplainer = null,
  endpoint = '/api/broadcasts/quota',
  live = true,
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
  }, [endpoint, live, refreshKey, retryNonce]);

  // Clamp percentage at 100 to avoid race conditions where used+reserved
  // briefly exceeds cap (P6 finding).
  // Board `Portal-broadcasts`: the used part solid, the reserved part hatched
  // beside it. Both clamp so they never run past the bar together.
  const usedPct = snap && snap.cap > 0 ? Math.min(100, (snap.used / snap.cap) * 100) : 0;
  const reservedPct =
    snap && snap.cap > 0 ? Math.min(100 - usedPct, (snap.reserved / snap.cap) * 100) : 0;
  const exhausted = snap !== null && snap.remaining === 0;
  const ariaValueNow = snap ? Math.min(snap.cap, snap.used + snap.reserved) : 0;

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
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-[var(--aura-bg-surface-hover)]"
              role="progressbar"
              aria-valuenow={ariaValueNow}
              aria-valuemax={snap.cap}
              aria-valuemin={0}
              aria-label={t('progressLabel')}
            >
              <div
                className={cn(
                  'flex h-full',
                  exhausted ? '[--quota-fill:var(--aura-fg-danger)]' : '[--quota-fill:var(--aura-fg-accent)]',
                )}
              >
                <span
                  data-segment="used"
                  className="h-full bg-[var(--quota-fill)] motion-safe:transition-all"
                  style={{ width: `${usedPct}%` }}
                />
                <span
                  data-segment="reserved"
                  className="h-full opacity-60 motion-safe:transition-all"
                  style={{
                    width: `${reservedPct}%`,
                    backgroundImage:
                      'repeating-linear-gradient(45deg, var(--quota-fill) 0 3px, transparent 3px 6px)',
                  }}
                />
              </div>
            </div>
            {/* The legend repeats what the counters above already say, so it
                is not read twice. */}
            <div
              aria-hidden="true"
              className="flex flex-wrap gap-x-4 gap-y-1 aura-text-caption text-[var(--aura-fg-secondary)]"
            >
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 shrink-0 rounded-[2px] bg-[var(--aura-fg-accent)]" />
                {t('used')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="size-2.5 shrink-0 rounded-[2px]"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(45deg, var(--aura-fg-accent) 0 3px, transparent 3px 6px)',
                  }}
                />
                {t('reservedLegend')}
              </span>
            </div>
            {exhausted ? (
              <p className="aura-text-caption text-[var(--aura-fg-danger)]">
                {t('exhausted', {
                  year: formatCalendarYear(snap.quotaYear, locale),
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
