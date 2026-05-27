/**
 * F9 US2 (T048) — read-only audit-log table (presentational).
 *
 * Renders the filtered audit page. Strictly read-only (FR-010 — no edit/delete
 * affordances). Each row shows a dual timestamp (FR-012): the UTC ISO instant
 * (machine-stable) plus a locale-local rendering. Payload is already
 * role-redacted upstream (FR-011) and shown as compact JSON. All display
 * strings are pre-formatted by the page so this stays a dumb, locale-correct
 * presentational component.
 */
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface AuditPayloadEntry {
  /** Humanised payload field name (e.g. `result_count` → `Result count`). */
  readonly label: string;
  /** Display-formatted value. */
  readonly value: string;
}

export interface AuditTableRow {
  readonly id: string;
  readonly occurredAtUtc: string;
  readonly occurredAtLocal: string;
  /** Localised event-type label (resolved per-locale in the page). */
  readonly eventTypeLabel: string;
  /** Raw event-type code — shown small for forensic precision. */
  readonly eventType: string;
  /** Human-readable actor (display name / email / sentinel). */
  readonly actorLabel: string;
  /** Raw actor id — shown small for forensic precision. */
  readonly actorUserId: string;
  /** Human-readable target (resolved user name; raw id / null otherwise). */
  readonly targetLabel: string | null;
  readonly targetUserId: string | null;
  readonly summary: string;
  /** Redacted payload as readable label/value pairs (empty → "none"). */
  readonly payloadEntries: readonly AuditPayloadEntry[];
}

export interface AuditTableLabels {
  readonly caption: string;
  readonly time: string;
  readonly event: string;
  readonly actor: string;
  readonly target: string;
  readonly summary: string;
  readonly payload: string;
  readonly empty: string;
  readonly none: string;
}

export function AuditTable({
  rows,
  labels,
}: {
  readonly rows: readonly AuditTableRow[];
  readonly labels: AuditTableLabels;
}): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed py-10 text-center text-muted-foreground">
        {labels.empty}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <caption className="sr-only">{labels.caption}</caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{labels.time}</TableHead>
            <TableHead scope="col">{labels.event}</TableHead>
            <TableHead scope="col">{labels.actor}</TableHead>
            <TableHead scope="col">{labels.target}</TableHead>
            <TableHead scope="col">{labels.summary}</TableHead>
            <TableHead scope="col">{labels.payload}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="whitespace-nowrap align-top">
                <time dateTime={r.occurredAtUtc} className="block font-medium">
                  {r.occurredAtLocal}
                </time>
                <span className="block text-caption text-muted-foreground">
                  {r.occurredAtUtc}
                </span>
              </TableCell>
              <TableCell className="align-top">
                <span className="block font-medium">{r.eventTypeLabel}</span>
                <span className="block font-mono text-caption text-muted-foreground">
                  {r.eventType}
                </span>
              </TableCell>
              <TableCell className="align-top">
                <span className="block">{r.actorLabel}</span>
                {r.actorLabel !== r.actorUserId ? (
                  <span className="block break-all font-mono text-caption text-muted-foreground">
                    {r.actorUserId}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="align-top">
                {r.targetUserId === null ? (
                  '—'
                ) : (
                  <>
                    <span className="block">{r.targetLabel ?? r.targetUserId}</span>
                    {r.targetLabel && r.targetLabel !== r.targetUserId ? (
                      <span className="block break-all font-mono text-caption text-muted-foreground">
                        {r.targetUserId}
                      </span>
                    ) : null}
                  </>
                )}
              </TableCell>
              <TableCell className="max-w-sm whitespace-normal break-words align-top">
                {r.summary}
              </TableCell>
              <TableCell className="align-top">
                {r.payloadEntries.length > 0 ? (
                  <dl className="grid max-w-xs gap-0.5 text-caption">
                    {r.payloadEntries.map((e) => (
                      <div key={e.label} className="flex gap-1.5">
                        <dt className="shrink-0 text-muted-foreground">{e.label}:</dt>
                        <dd className="break-words">{e.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <span className="text-muted-foreground">{labels.none}</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
