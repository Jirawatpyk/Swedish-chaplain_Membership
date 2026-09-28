/**
 * F9 US5 (T083) — recent directory exports list. Presentational server
 * component: shows each generated artefact's kind, status (text badge, not
 * colour alone), requested time, and a download link once `ready|delivered`.
 * The download link points at the staff prepare-and-redirect route, which mints
 * a fresh single-use token before redirecting to the private proxy.
 */
import { StatusPill, buttonClass } from '@jirawatpyk/aura-react/server';
import { Table, TBody, THead, Td, Th, Tr } from '@/components/shell/aura-table';
import type { ExportStatus } from '@/modules/insights';
import { exportStatusTone } from '@/lib/export-status-variant';

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
  // 122 US5a (T506) — the board's "Recent exports" card: an AURA table with
  // the status as a StatusPill, rows as cards below 640px.
  return (
    <section
      aria-labelledby="recent-exports-heading"
      className="flex flex-col gap-4 rounded-[var(--aura-card-radius)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] p-5 max-sm:p-4"
    >
      <h2 id="recent-exports-heading" className="m-0 text-base font-semibold">
        {labels.heading}
      </h2>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--aura-fg-secondary)]">{labels.empty}</p>
      ) : (
        <Table caption={labels.caption} captionHidden stackBelow="sm">
          <THead>
            <Tr>
              <Th>{labels.kindLabel}</Th>
              <Th>{labels.statusLabel}</Th>
              <Th>{labels.requestedLabel}</Th>
              <Th align="end">
                <span className="sr-only">{labels.download}</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {rows.map((row) => (
              <Tr key={row.jobId}>
                <Td className="font-medium">{row.kindLabel}</Td>
                <Td>
                  <StatusPill tone={exportStatusTone(row.status)}>{row.statusLabel}</StatusPill>
                </Td>
                <Td className="text-[var(--aura-fg-secondary)]">{row.requestedAt}</Td>
                <Td align="end">
                  {row.downloadable ? (
                    <a
                      href={`/api/admin/directory/exports/${row.jobId}/download`}
                      // H2: contextual label so SR users hear which export each
                      // "Download" link targets (WCAG 2.4.6), not "Download" ×N.
                      aria-label={`${labels.download} — ${row.kindLabel}, ${row.requestedAt}`}
                      className={buttonClass({ variant: 'secondary', size: 'sm' })}
                    >
                      {labels.download}
                    </a>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </section>
  );
}
