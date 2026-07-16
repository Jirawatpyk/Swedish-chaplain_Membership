/**
 * F9 dashboard-interactive-charts — shared accessible data table for every
 * chart. Every Recharts canvas in this feature is `aria-hidden` (the shape
 * is decorative reinforcement, not information — WCAG 1.1.1 / 1.3.1 /
 * 1.4.1); this `<table>` IS the sole accessible + no-JS path, so it is
 * visually hidden (`sr-only`) but **never** `aria-hidden` and **never**
 * gated behind a client mount check. It is pure markup from props — no
 * `'use client'` — so it renders in the server/SSR output exactly like the
 * existing sparkline's inline hidden table (`_mini-series-chart.tsx`),
 * which this component supersedes as the shared implementation.
 *
 * Cells are already display-ready (formatted THB strings, percentages,
 * counts) — this component does no i18n/number formatting of its own; the
 * caller composes `columns`/`rows` from translated + formatted values.
 *
 * Table semantics: the first cell of every row is the row header
 * (`<th scope="row">`, e.g. a month or tier label); remaining cells are
 * data (`<td>`). This covers every caller shape in the design doc — a
 * 2-column month→value series, a tier→count/% breakdown, and an invoice
 * bucket→THB/count/% breakdown, each optionally ending in a "Total" row
 * (just another row; no separate prop).
 */
export interface ChartDataTableProps {
  /** Visible-to-SR-only `<caption>` naming the chart (e.g. the chart title). */
  readonly caption: string;
  /** Column header labels, left to right. */
  readonly columns: readonly string[];
  /** One entry per table row; each row's first cell is its row header. */
  readonly rows: readonly (readonly (string | number)[])[];
}

export function ChartDataTable({ caption, columns, rows }: ChartDataTableProps) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) =>
              cellIndex === 0 ? (
                <th key={cellIndex} scope="row">
                  {cell}
                </th>
              ) : (
                <td key={cellIndex}>{cell}</td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
