'use client';

/**
 * F9 US6 (T093) — member GDPR data-export panel (client).
 *
 * A "Request my data export" button (POST → `/api/portal/account/data-export`,
 * 202 on enqueue) with toast feedback + `router.refresh()` so the recent-requests
 * table re-renders with the new job, plus a status table with a download link
 * once a job is `ready|delivered` (the link hits the member prepare-and-redirect
 * route, which mints a fresh single-use token).
 *
 * RSC boundary: imports the `ExportStatus` TYPE only from the insights barrel
 * (erased at compile) — never the server-only runtime (mirrors the directory
 * forms' convention).
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Download, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ExportStatus } from '@/modules/insights';

export interface DataExportRow {
  readonly jobId: string;
  readonly status: ExportStatus;
  readonly statusLabel: string;
  readonly downloadable: boolean;
  readonly requestedAt: string;
}

export interface DataExportLabels {
  readonly requestButton: string;
  readonly requesting: string;
  readonly requestedTitle: string;
  readonly requestedBody: string;
  readonly statusHeading: string;
  readonly empty: string;
  readonly download: string;
  readonly errorTitle: string;
  readonly errorBody: string;
  readonly expiresHint: string;
  readonly colStatus: string;
  readonly colRequested: string;
  readonly caption: string;
}

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

// Text already encodes meaning (WCAG 1.4.1); the variant is a redundant cue.
const STATUS_VARIANT = {
  requested: 'secondary',
  processing: 'secondary',
  ready: 'default',
  delivered: 'default',
  expired: 'destructive',
  failed: 'destructive',
} as const satisfies Record<ExportStatus, BadgeVariant>;

export function DataExportPanel({
  rows,
  labels,
  requestUrl = '/api/portal/account/data-export',
  downloadUrlBase = '/api/portal/account/data-export',
}: {
  readonly rows: readonly DataExportRow[];
  readonly labels: DataExportLabels;
  /** POST endpoint that enqueues the export (member self vs admin on-behalf). */
  readonly requestUrl?: string;
  /** Base for the per-job download link: `${downloadUrlBase}/${jobId}/download`. */
  readonly downloadUrlBase?: string;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  async function requestExport(): Promise<void> {
    setPending(true);
    try {
      const res = await fetch(requestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        toast.error(labels.errorTitle, { description: labels.errorBody });
        return;
      }
      toast.success(labels.requestedTitle, { description: labels.requestedBody });
      router.refresh();
    } catch {
      toast.error(labels.errorTitle, { description: labels.errorBody });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Button onClick={requestExport} disabled={pending} aria-busy={pending}>
          {pending ? (
            <>
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              {labels.requesting}
            </>
          ) : (
            labels.requestButton
          )}
        </Button>
      </div>

      <section aria-labelledby="data-export-recent-heading" className="space-y-3">
        <h2 id="data-export-recent-heading" className="text-sm font-semibold">
          {labels.statusHeading}
        </h2>
        {rows.length === 0 ? (
          <p className="rounded-md border py-6 text-center text-sm text-muted-foreground">
            {labels.empty}
          </p>
        ) : (
          <>
            <Table>
              <TableCaption className="sr-only">{labels.caption}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{labels.colStatus}</TableHead>
                  <TableHead>{labels.colRequested}</TableHead>
                  <TableHead className="sr-only">{labels.download}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.jobId}>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[row.status]}>{row.statusLabel}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{row.requestedAt}</TableCell>
                    <TableCell className="text-right">
                      {row.downloadable ? (
                        <a
                          href={`${downloadUrlBase}/${row.jobId}/download`}
                          aria-label={`${labels.download} — ${row.requestedAt}`}
                          className={buttonVariants({ variant: 'outline', size: 'sm' })}
                        >
                          <Download aria-hidden="true" className="size-4" />
                          {labels.download}
                        </a>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-xs text-muted-foreground">{labels.expiresHint}</p>
          </>
        )}
      </section>
    </div>
  );
}
