/**
 * F9 US5 (T083) — recent directory exports list. Presentational server
 * component: shows each generated artefact's kind, status (text badge, not
 * colour alone), requested time, and a download link once `ready|delivered`.
 * The download link points at the staff prepare-and-redirect route, which mints
 * a fresh single-use token before redirecting to the private proxy.
 */
import { DownloadIcon } from 'lucide-react';
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
  // 122 US5a — the board's "Recent exports" card (`Admin-directory`): a plain
  // table (small capitals in the head, a rule between rows, no inner frame),
  // every row centred on its line, Download with its icon. On a phone
  // (`Admin-directory-mobile`) a one-line list instead: the name, the time
  // under it, and the status pill — or, once ready, "· Ready" in the time line
  // and an icon-only download. The table hides below 640px and the list above
  // it, so assistive tech meets only the one on screen.
  const downloadHref = (row: RecentExportRow) => `/api/admin/directory/exports/${row.jobId}/download`;
  // H2: contextual label so SR users hear which export each "Download" link
  // targets (WCAG 2.4.6), not "Download" ×N.
  const downloadLabel = (row: RecentExportRow) => `${labels.download} — ${row.kindLabel}, ${row.requestedAt}`;
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
        <>
          <div className="max-sm:hidden [&_.aura-tbl-wrap]:rounded-none [&_.aura-tbl-wrap]:border-0 [&_.aura-tbl-wrap]:bg-transparent [&_thead_th]:bg-transparent">
            <Table
              caption={labels.caption}
              captionHidden
              className="rounded-none border-0 bg-transparent [&_.aura-tbl\_\_td]:align-middle [&_.aura-tbl\_\_td:first-child]:pl-0 [&_.aura-tbl\_\_td:last-child]:pr-0 [&_.aura-tbl\_\_th]:text-[11px] [&_.aura-tbl\_\_th]:font-medium [&_.aura-tbl\_\_th]:tracking-[0.06em] [&_.aura-tbl\_\_th]:text-[var(--aura-fg-secondary)] [&_.aura-tbl\_\_th]:uppercase [&_.aura-tbl\_\_th:first-child]:pl-0 [&_.aura-tbl\_\_th:last-child]:pr-0 [&_thead_tr]:border-b [&_thead_tr]:border-[var(--aura-border-default)]"
            >
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
                    <Td className="text-[15px]">{row.kindLabel}</Td>
                    <Td>
                      <StatusPill tone={exportStatusTone(row.status)}>{row.statusLabel}</StatusPill>
                    </Td>
                    <Td className="text-[var(--aura-fg-secondary)]">{row.requestedAt}</Td>
                    <Td align="end">
                      {row.downloadable ? (
                        <a
                          href={downloadHref(row)}
                          aria-label={downloadLabel(row)}
                          className={buttonClass({ variant: 'secondary', size: 'sm' })}
                        >
                          <DownloadIcon aria-hidden="true" className="size-4" />
                          {labels.download}
                        </a>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
          <ul className="m-0 flex list-none flex-col divide-y divide-[var(--aura-border-default)] border-t border-[var(--aura-border-default)] p-0 sm:hidden">
            {rows.map((row) => (
              <li key={row.jobId} className="flex min-h-14 items-center gap-3 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[15px] [overflow-wrap:anywhere]">{row.kindLabel}</span>
                  <span className="text-[13px] text-[var(--aura-fg-secondary)]">
                    {row.downloadable ? `${row.requestedAt} · ${row.statusLabel}` : row.requestedAt}
                  </span>
                </div>
                {row.downloadable ? (
                  <a
                    href={downloadHref(row)}
                    aria-label={downloadLabel(row)}
                    title={labels.download}
                    className={buttonClass({ variant: 'ghost', size: 'sm', className: 'size-11 shrink-0 px-0' })}
                  >
                    <DownloadIcon aria-hidden="true" className="size-5" />
                  </a>
                ) : (
                  <StatusPill tone={exportStatusTone(row.status)} className="shrink-0">
                    {row.statusLabel}
                  </StatusPill>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
