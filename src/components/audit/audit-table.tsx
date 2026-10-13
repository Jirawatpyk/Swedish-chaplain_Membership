'use client';

/**
 * F9 US2 (T048) — read-only audit-log table (presentational).
 *
 * Renders the filtered audit page. Strictly read-only (FR-010 — no edit/delete
 * affordances). Each row shows a dual timestamp (FR-012): the UTC ISO instant
 * (machine-stable) plus a locale-local rendering. Payload is already
 * role-redacted upstream (FR-011) and shown as readable label/value pairs. All
 * display strings are pre-formatted by the page so this stays a dumb,
 * locale-correct presentational component.
 */
import { ScrollTextIcon } from 'lucide-react';
import { Table, TBody, Td, Th, THead, Tr } from '@jirawatpyk/aura-react';
import { EmptyState } from '@/components/shell/empty-state';

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
  /** Human-readable actor (display name / raw id / sentinel — never email). */
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
  readonly emptyTitle: string;
  readonly empty: string;
  readonly none: string;
  /** sr-only prefix clarifying the second timestamp line is UTC (Gregorian). */
  readonly utcLabel: string;
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
      <EmptyState icon={ScrollTextIcon} title={labels.emptyTitle} description={labels.empty} />
    );
  }

  // No wrapper div: the shared <Table> primitive already provides the
  // overflow-x-auto scroll region, and the page's <Card> provides the border +
  // radius — matching the Members/Plans/Invoices house style (no double frame).
  // Spec 122 US10b (T1012): AURA's static Table, stacking into cards below
  // `sm` with the event as each card's title (board `Admin-audit-mobile`).
  // The cells are today's. A client file: AURA's Table is not in `/server`.
  const code = 'block font-mono aura-text-caption text-[var(--aura-fg-secondary)]';
  return (
    <Table caption={labels.caption} captionHidden stackBelow="sm" stackStyle="cards" bleed>
      <THead>
        <Tr>
          <Th>{labels.time}</Th>
          <Th>{labels.event}</Th>
          <Th>{labels.actor}</Th>
          <Th>{labels.target}</Th>
          <Th>{labels.summary}</Th>
          <Th>{labels.payload}</Th>
        </Tr>
      </THead>
      <TBody>
        {rows.map((r) => (
          <Tr key={r.id}>
            <Td className="whitespace-nowrap">
              <time dateTime={r.occurredAtUtc} className="block font-medium">
                {r.occurredAtLocal}
              </time>
              <span className={code}>
                <span className="sr-only">{labels.utcLabel}: </span>
                {r.occurredAtUtc}
              </span>
            </Td>
            <Td card="title">
              <span className="block font-medium">{r.eventTypeLabel}</span>
              <span className={code}>{r.eventType}</span>
            </Td>
            <Td>
              <span className="block">{r.actorLabel}</span>
              {r.actorLabel !== r.actorUserId ? <span className={`${code} break-all`}>{r.actorUserId}</span> : null}
            </Td>
            <Td>
              {r.targetUserId === null ? (
                '—'
              ) : (
                <>
                  <span className="block">{r.targetLabel ?? r.targetUserId}</span>
                  {r.targetLabel && r.targetLabel !== r.targetUserId ? (
                    <span className={`${code} break-all`}>{r.targetUserId}</span>
                  ) : null}
                </>
              )}
            </Td>
            <Td className="max-w-sm break-words">{r.summary}</Td>
            <Td>
              {r.payloadEntries.length > 0 ? (
                <dl className="grid max-w-xs gap-0.5 aura-text-caption">
                  {r.payloadEntries.map((e) => (
                    <div key={e.label} className="flex gap-1.5">
                      <dt className="shrink-0 text-[var(--aura-fg-secondary)]">{e.label}:</dt>
                      <dd className="break-words">{e.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <span className="text-[var(--aura-fg-secondary)]">{labels.none}</span>
              )}
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}
