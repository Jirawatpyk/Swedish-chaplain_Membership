/**
 * F114 T070 / research R10 — the table-scoped erasure guard registration for
 * `member_change_requests` + `member_change_request_fields`.
 *
 * Mirror of the `members` / `contacts` allowlist guards
 * (scrub-pii-column-coverage.test.ts, scrub-contacts-pii-column-coverage.test.ts):
 * the change-request scrub adapter uses a DENYLIST (an explicit `.set({...})`
 * of columns to anonymise), so a column added to either table in a future
 * feature would be SILENTLY left un-scrubbed. This test inverts the contract
 * into an ALLOWLIST over the ACTUAL Drizzle columns: every column is either
 * SCRUBBED (rewritten by `scrubForMemberInTx`) or KEPT (retained on purpose,
 * with a one-word rationale). A new column fails here until it is classified.
 */
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { memberChangeRequestFields, memberChangeRequests } from '@/modules/members/infrastructure/db/schema-change-requests';

// member_change_requests — rewritten by `scrubForMemberInTx`
const REQUEST_SCRUBBED = new Set<string>([
  'decisionReason', // → '[erased]' when set (never NULL — reason_iff_rejected_ck)
  'decisionNote', // → '[erased]' when set
  'state', // pending → 'withdrawn' (a pending request cannot be decided after erasure)
  'withdrawnReason', // pending → 'erasure'
  'withdrawnAt', // pending → the erasure time
  'updatedAt',
]);

// member_change_requests — retained: the EXISTENCE + OUTCOME of every request stay countable (FR-030)
const REQUEST_KEPT = new Set<string>([
  'id', // identity
  'tenantId', // tenancy
  'memberId', // binding (the erased member row itself is the sentinel record)
  'submittedByUserId', // pseudonymous actor id — the F1 user erasure sweeps the login
  'submittedByContactId', // binding to the (scrubbed) contact row
  'submitterRoleAtSubmission', // 'primary' | 'secondary' — no identifier
  'scope', // closed enum
  'outcome', // accountability (which decision was taken)
  'replacedByRequestId', // request-graph pointer
  'submittedAt', // timestamp
  'staffNotifiedAt', // timestamp
  'decidedAt', // timestamp
  'decidedByUserId', // the REVIEWER (staff, never the data subject)
  'outcomeAcknowledgedAt', // timestamp
  'createdAt', // record-keeping
]);

// member_change_request_fields — the two value columns carry the PII
const FIELD_SCRUBBED = new Set<string>([
  'seenValue', // → '[erased]'
  'proposedValue', // → '[erased]'
]);

const FIELD_KEPT = new Set<string>([
  'id', // identity
  'tenantId', // tenancy
  'requestId', // binding
  'fieldKey', // closed enum — WHICH field was proposed, never its value
  'target', // closed enum
  'outcome', // accountability
  'appliedAt', // timestamp
  'affectsTaxDocuments', // boolean flag
]);

function assertPartition(label: string, table: Record<string, unknown>, scrubbed: Set<string>, kept: Set<string>) {
  const actualColumns = Object.keys(table);
  const classified = new Set<string>([...scrubbed, ...kept]);
  const actual = new Set(actualColumns);
  const inBoth = [...scrubbed].filter((c) => kept.has(c));
  expect(inBoth, `${label}: columns classified as BOTH scrubbed and kept: ${inBoth.join(', ')}`).toEqual([]);
  const unclassified = actualColumns.filter((c) => !classified.has(c));
  expect(unclassified, `unclassified ${label} columns — add each to SCRUBBED or KEPT in this test AND (if PII) to scrubForMemberInTx: ${unclassified.join(', ')}`).toEqual([]);
  const stale = [...classified].filter((c) => !actual.has(c));
  expect(stale, `stale columns in SCRUBBED/KEPT no longer on ${label}: ${stale.join(', ')}`).toEqual([]);
}

describe('change-request scrub — column-coverage allowlist guard (F114 FR-030)', () => {
  it('partitions every member_change_requests column into exactly SCRUBBED ∪ KEPT', () => {
    assertPartition('member_change_requests', getTableColumns(memberChangeRequests), REQUEST_SCRUBBED, REQUEST_KEPT);
  });

  it('partitions every member_change_request_fields column into exactly SCRUBBED ∪ KEPT', () => {
    assertPartition('member_change_request_fields', getTableColumns(memberChangeRequestFields), FIELD_SCRUBBED, FIELD_KEPT);
  });

  it('the value columns and the reviewer free text are in the SCRUBBED sets', () => {
    for (const col of ['seenValue', 'proposedValue']) expect(FIELD_SCRUBBED.has(col), col).toBe(true);
    for (const col of ['decisionReason', 'decisionNote']) expect(REQUEST_SCRUBBED.has(col), col).toBe(true);
  });
});
