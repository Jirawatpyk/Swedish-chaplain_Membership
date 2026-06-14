/**
 * F9 US5 (T083) — recent directory exports list. Presentational server
 * component: shows each generated artefact's kind, status (text badge, not
 * colour alone), requested time, and a download link once `ready|delivered`.
 * The download link points at the staff prepare-and-redirect route, which mints
 * a fresh single-use token before redirecting to the private proxy.
 */
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
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
import { exportStatusVariant } from '@/lib/export-status-variant';

export interface RecentExportRow {
  readonly jobId: string;
  readonly kindLabel: string;
  readonly status: ExportStatus;
  readonly statusLabel: string;
  readonly downloadable: boolean;
  readonly requestedAt: string;
}

export interface RecentExportsLabels {
  readonly heading: string;
  readonly empty: string;
  readonly caption: string;
  readonly kindLabel: string;
  readonly statusLabel: string;
  readonly requestedLabel: string;
  readonly download: string;
}

export function RecentExports({
  rows,
  labels,
}: {
  readonly rows: readonly RecentExportRow[];
  readonly labels: RecentExportsLabels;
}): React.JSX.Element {
  return (
    <section aria-labelledby="recent-exports-heading" className="space-y-3">
      <h2 id="recent-exports-heading" className="text-sm font-semibold">
        {labels.heading}
      </h2>
      {rows.length === 0 ? (
        <p className="rounded-md border py-6 text-center text-sm text-muted-foreground">
          {labels.empty}
        </p>
      ) : (
        <Table>
          <TableCaption className="sr-only">{labels.caption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{labels.kindLabel}</TableHead>
              <TableHead scope="col">{labels.statusLabel}</TableHead>
              <TableHead scope="col">{labels.requestedLabel}</TableHead>
              <TableHead scope="col" className="sr-only">{labels.download}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.jobId}>
                <TableCell className="font-medium">{row.kindLabel}</TableCell>
                <TableCell>
                  <Badge variant={exportStatusVariant(row.status)}>{row.statusLabel}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{row.requestedAt}</TableCell>
                <TableCell className="text-right">
                  {row.downloadable ? (
                    <a
                      href={`/api/admin/directory/exports/${row.jobId}/download`}
                      // H2: contextual label so SR users hear which export each
                      // "Download" link targets (WCAG 2.4.6), not "Download" ×N.
                      aria-label={`${labels.download} — ${row.kindLabel}, ${row.requestedAt}`}
                      className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    >
                      {labels.download}
                    </a>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
