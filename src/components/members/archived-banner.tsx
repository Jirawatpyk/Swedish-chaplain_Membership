'use client';

/**
 * T141 — ArchivedBanner (US7).
 *
 * Shown on the member detail page when `status === 'archived'`. Renders:
 *   - "Archived on {archivedAt}" heading + descriptive copy
 *   - "Undelete" CTA when within the 90-day window; disabled button +
 *     tooltip when beyond 90 days (FR-005 AS3).
 *
 * Uses the Domain `archiveWindowStatus` policy computed server-side and
 * passed as props — the component itself is presentational only.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { toast } from 'sonner';
import { ArchiveRestoreIcon, AlertTriangleIcon } from 'lucide-react';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

type ArchiveWindow =
  | { state: 'within_window'; daysRemaining: number }
  | { state: 'window_expired'; daysSinceArchive: number };

type Props = {
  readonly memberId: string;
  readonly archivedAtIso: string;
  readonly windowStatus: ArchiveWindow;
};

export function ArchivedBanner({
  memberId,
  archivedAtIso,
  windowStatus,
}: Props) {
  const t = useTranslations('admin.members.archive');
  const locale = useLocale();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);

  const canUndelete = windowStatus.state === 'within_window';

  async function handleUndelete() {
    setLoading(true);
    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await fetch(`/api/members/${memberId}/undelete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
      });
      if (res.ok) {
        toast.success(t('undeleteSuccess'));
        startTransition(() => {
          router.refresh();
        });
      } else {
        const data = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string };
        };
        const code = data.error?.code ?? 'server_error';
        if (code === 'archive_window_expired') {
          toast.error(t('windowExpiredToast'));
        } else {
          toast.error(data.error?.message ?? t('undeleteError'));
        }
      }
    } catch {
      toast.error(t('undeleteError'));
    } finally {
      setLoading(false);
    }
  }

  // R007 (staff-review-20260417-us7) — Thai Buddhist Era display for
  // th-TH per CLAUDE.md "BE = CE + 543 is display-only for th-TH".
  // Same BCP47 pattern as src/lib/relative-time.ts:73 (`-u-ca-buddhist`
  // extension). Storage remains Gregorian ISO; this is pure display.
  const archivedDate = new Date(archivedAtIso);
  let isoDate: string;
  try {
    isoDate = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(archivedDate);
  } catch {
    isoDate = archivedDate.toISOString().slice(0, 10);
  }
  const disabled = loading || isPending;

  return (
    <Card className="border-destructive/40 bg-destructive/5 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <AlertTriangleIcon
            className="mt-0.5 size-5 shrink-0 text-destructive"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-semibold">
              {t('bannerTitle', { date: isoDate })}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {windowStatus.state === 'within_window'
                ? t('withinWindow', {
                    daysRemaining: windowStatus.daysRemaining,
                  })
                : t('windowExpired', {
                    daysSinceArchive: windowStatus.daysSinceArchive,
                  })}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center">
          {canUndelete ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleUndelete}
              disabled={disabled}
              aria-label={t('undeleteCta')}
            >
              <ArchiveRestoreIcon className="size-4" />
              {t('undeleteCta')}
            </Button>
          ) : (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger className="inline-flex">
                  <span
                    aria-disabled="true"
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-transparent px-3 text-sm text-muted-foreground opacity-50"
                    aria-label={t('undeleteCta')}
                  >
                    <ArchiveRestoreIcon className="size-4" aria-hidden="true" />
                    {t('undeleteCta')}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{t('windowExpiredTooltip')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>
    </Card>
  );
}
