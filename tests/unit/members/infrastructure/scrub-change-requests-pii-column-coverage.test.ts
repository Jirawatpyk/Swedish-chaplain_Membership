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
 *
 * Unlike its two siblings the SCRUBBED sets are NOT hand-copied here: they are
 * the adapter's own exported column lists, which the adapter's `.set({...})`
 * calls are typed against (`satisfies Record<column, unknown>`), so a column
 * dropped from a `.set()` fails the ADAPTER's typecheck and a column added
 * to the list without a `.set()` entry fails it too (review round 1, P-6 /
 * SEC-S2: the guard used to read a constant the adapter never saw).
 */
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { memberChangeRequestFields, memberChangeRequests } from '@/modules/members/infrastructure/db/schema-change-requests';
import { FIELD_SCRUBBED_COLUMNS, REQUEST_SCRUBBED_COLUMNS } from '@/modules/members/infrastructure/adapters/change-request-scrub-adapter';

// member_change_requests — rewritten by `scrubForMemberInTx` (the adapter's own list:
// decisionReason / decisionNote → '[erased]' when set; state / withdrawnReason /
// withdrawnAt for a pending row; updatedAt)
const REQUEST_SCRUBBED = new Set<string>(REQUEST_SCRUBBED_COLUMNS);

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

// member_change_request_fields — the two value columns carry the PII (the adapter's own list)
const FIELD_SCRUBBED = new Set<string>(FIELD_SCRUBBED_COLUMNS);

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

  it('the value columns and the reviewer free text are in the SCRUBBED sets (positive control: the adapter lists are non-empty)', () => {
    expect(REQUEST_SCRUBBED_COLUMNS.length).toBeGreaterThan(0);
    expect(FIELD_SCRUBBED_COLUMNS.length).toBeGreaterThan(0);
    for (const col of ['seenValue', 'proposedValue']) expect(FIELD_SCRUBBED.has(col), col).toBe(true);
    for (const col of ['decisionReason', 'decisionNote']) expect(REQUEST_SCRUBBED.has(col), col).toBe(true);
  });
});
