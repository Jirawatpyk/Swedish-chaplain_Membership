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
  /** Phone card line, with `{target}`: "Target: {target}". */
  readonly cardTarget: string;
  /** Phone card line, with `{actor}`: "by {actor}". */
  readonly cardBy: string;
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
  // Spec 122 US10b (T1012): AURA's static Table from 640px up, with today's
  // cells. Below 640px, board `Admin-audit-mobile`'s compact cards instead
  // (maintainer, parity comments 13 Oct); the raw codes stay in the table.
  // A client file: AURA's Table is not in `/server`.
  // codes and ids have no break points, so they alone may break anywhere (AURA 5.60 wraps
  // the cell between words, #174). A payload value breaks anywhere only when it is a long
  // token (a uuid, an email): `anywhere` also shrinks the column's min-content to one letter,
  // which split short values such as `admin` mid-word (R81). The value wraps under its
  // label when the column is narrow, so the pair never forces the column wider
  const code = 'block font-mono aura-text-caption text-[var(--aura-fg-secondary)] [overflow-wrap:anywhere]';
  const payloadWrap = (value: string) =>
    value.length > 16 && !/\s/.test(value) ? '[overflow-wrap:anywhere]' : 'break-words';
  return (
    <>
    <div className="max-sm:hidden">
    <Table caption={labels.caption} captionHidden bleed>
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
            <Td>
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
                    <div key={e.label} className="flex flex-wrap gap-x-1.5">
                      <dt className="shrink-0 text-[var(--aura-fg-secondary)]">{e.label}:</dt>
                      <dd className={payloadWrap(e.value)}>{e.value}</dd>
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
    </div>
    <ul aria-label={labels.caption} className="flex flex-col gap-[var(--aura-space-3)] sm:hidden">
      {rows.map((r) => {
        const target = r.targetUserId === null ? null : (r.targetLabel ?? r.targetUserId);
        const by = [
          labels.cardBy.replace('{actor}', r.actorLabel),
          ...r.payloadEntries.map((e) => `${e.label}: ${e.value}`),
        ].join(' · ');
        return (
          <li
            key={r.id}
            className="flex flex-col gap-[var(--aura-space-1)] rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] p-[var(--aura-space-4)] break-words"
          >
            <p className="aura-text-caption text-[var(--aura-fg-secondary)]">
              <time dateTime={r.occurredAtUtc}>{r.occurredAtLocal}</time>
              {' · '}
              <span className="sr-only">{labels.utcLabel}: </span>
              {r.occurredAtUtc.slice(11, 16)} {labels.utcLabel}
            </p>
            <p className="font-semibold">{r.eventTypeLabel}</p>
            {target !== null ? <p>{labels.cardTarget.replace('{target}', target)}</p> : null}
            <p>{r.summary}</p>
            <p className="aura-text-caption text-[var(--aura-fg-secondary)]">{by}</p>
          </li>
        );
      })}
    </ul>
    </>
  );
}
