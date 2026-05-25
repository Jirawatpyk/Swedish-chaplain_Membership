/**
 * F9 (FR-001a) — internal self-built SVG mini chart for the dashboard trend
 * cards. NO charting dependency (Constitution X). Pure presentational server
 * component with a STABLE display-ready prop contract — the SVG renderer is a
 * swappable internal (research R8); callers never depend on its markup.
 *
 * Accessibility (WCAG 1.4.1 — no colour-only): the `<svg>` is decorative
 * (`aria-hidden`); the data is conveyed by an always-present, visually-hidden
 * `<table>` (the accessible equivalent) AND by bar height / line position, not
 * by colour. Single series → no colour is used to distinguish categories.
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface MiniSeriesPoint {
  /** Stable key (e.g. 'YYYY-MM'). */
  readonly key: string;
  /** Localised axis/row label (e.g. 'Jun 2026'). */
  readonly label: string;
  /** Numeric magnitude for the SVG geometry. */
  readonly value: number;
  /** Display-ready value for the table cell (e.g. '฿1,200' or '42'). */
  readonly valueLabel: string;
}

const VIEW_W = 320;
const VIEW_H = 80;
const PAD = 4;

function BarSvg({ points, max }: { readonly points: readonly MiniSeriesPoint[]; readonly max: number }) {
  const innerW = VIEW_W - PAD * 2;
  const innerH = VIEW_H - PAD * 2;
  const slot = innerW / points.length;
  const barW = Math.max(1, slot * 0.7);
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="h-20 w-full" aria-hidden="true" role="presentation">
      {points.map((p, i) => {
        const h = max > 0 ? (p.value / max) * innerH : 0;
        const x = PAD + i * slot + (slot - barW) / 2;
        const y = PAD + innerH - h;
        return <rect key={p.key} x={x} y={y} width={barW} height={h} rx={1} className="fill-primary" />;
      })}
    </svg>
  );
}

function LineSvg({ points, max }: { readonly points: readonly MiniSeriesPoint[]; readonly max: number }) {
  const innerW = VIEW_W - PAD * 2;
  const innerH = VIEW_H - PAD * 2;
  const step = points.length > 1 ? innerW / (points.length - 1) : 0;
  const coords = points.map((p, i) => {
    const x = PAD + i * step;
    const y = PAD + innerH - (max > 0 ? (p.value / max) * innerH : 0);
    return { x, y };
  });
  const path = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="h-20 w-full" aria-hidden="true" role="presentation">
      <polyline points={path} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {coords.map((c, i) => (
        <circle key={points[i]!.key} cx={c.x} cy={c.y} r={2} className="fill-primary" />
      ))}
    </svg>
  );
}

export function MiniSeriesChart({
  title,
  emptyLabel,
  labelHeader,
  valueHeader,
  variant,
  points,
}: {
  readonly title: string;
  readonly emptyLabel: string;
  readonly labelHeader: string;
  readonly valueHeader: string;
  readonly variant: 'bar' | 'line';
  readonly points: readonly MiniSeriesPoint[];
}) {
  const hasData = points.length > 0 && points.some((p) => p.value > 0);
  const max = points.reduce((m, p) => Math.max(m, p.value), 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <p className="text-body text-muted-foreground">{emptyLabel}</p>
        ) : (
          <>
            {variant === 'bar' ? <BarSvg points={points} max={max} /> : <LineSvg points={points} max={max} />}
            {/* Accessible equivalent (WCAG 1.4.1) — visually hidden, carries the
                exact values the SVG depicts. */}
            <table className="sr-only">
              <caption>{title}</caption>
              <thead>
                <tr>
                  <th scope="col">{labelHeader}</th>
                  <th scope="col">{valueHeader}</th>
                </tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.key}>
                    <th scope="row">{p.label}</th>
                    <td>{p.valueLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
