/**
 * Integration test (verify-finding 2026-05-12) — F6 Phase 4 Drizzle
 * adapter paths against live Neon:
 *   - `drizzle-events-repository.list` (offset+pageSize+totalCount)
 *   - `drizzle-events-repository.getMatchCountsByEventIds` (batched GROUP BY)
 *   - `drizzle-events-repository.getEmptyContext` (3-variant context)
 *   - `drizzle-registrations-repository.findByEventId` (unmatchedOnly +
 *     matchTypeFilter + ilike substring + full-event matchCounts)
 *
 * Phase 4 review identified an integration-test gap — Drizzle paths are
 * uncovered by Phase 3 integration suite + cannot be caught at the
 * contract-test layer (mocks). GROUP BY cardinality bugs + RLS leak in
 * the `IN (eventIds)` query in particular are the highest-leverage
 * risks.
 *
 * Seeds 2 tenants × 3 events × 7 attendees with mixed match types,
 * archives 1 event, archives webhook config on one tenant — exercises
 * the 3 empty-state variants + cross-tenant isolation in one harness.
 *
 * Pattern mirrors tests/integration/events/tenant-isolation.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { asTenantId } from '@/modules/members';
import { asEventId, asExternalAttendeeId, asExternalEventId, asAttendeeEmail } from '@/modules/events';
import { makeDrizzleEventsRepository } from '@/modules/events/infrastructure/drizzle-events-repository';
import { makeDrizzleRegistrationsRepository } from '@/modules/events/infrastructure/drizzle-registrations-repository';
import {
  events,
  eventRegistrations,
  tenantWebhookConfigs,
} from '@/modules/events/infrastructure/schema';

const TENANT_A = `t-list-a-${Date.now().toString(36)}`;
const TENANT_B = `t-list-b-${Date.now().toString(36)}`;
const TENANT_C_EMPTY = `t-list-c-${Date.now().toString(36)}`;
const TENANT_D_NEVER_DELIVERED = `t-list-d-${Date.now().toString(36)}`;

// Capture seeded event ids for assertion.
const SEED: {
  tenantA: { eventId: string; name: string; archived: boolean }[];
  tenantB: { eventId: string }[];
} = { tenantA: [], tenantB: [] };

beforeAll(async () => {
  // ---- Tenant A: 3 events × 7 registrations with mixed match types ------
  const ctxA = asTenantContext(TENANT_A);
  await runInTenant(ctxA, async (tx) => {
    // 3 events — one each: active partner-benefit, active cultural, archived
    const insertedEvents = await tx
      .insert(events)
      .values([
        {
          tenantId: TENANT_A,
          source: 'eventcreate',
          externalId: 'evt-ext-A1',
          name: 'A1 networking',
          startDate: new Date('2026-06-21T10:00:00Z'),
          isPartnerBenefit: true,
        },
        {
          tenantId: TENANT_A,
          source: 'eventcreate',
          externalId: 'evt-ext-A2',
          name: 'A2 cultural',
          startDate: new Date('2026-05-10T10:00:00Z'),
          isCulturalEvent: true,
        },
        {
          tenantId: TENANT_A,
          source: 'eventcreate',
          externalId: 'evt-ext-A3',
          name: 'A3 archived',
          startDate: new Date('2026-04-01T10:00:00Z'),
          archivedAt: new Date('2026-04-15T10:00:00Z'),
        },
      ])
      .returning({ id: events.eventId, name: events.name, archivedAt: events.archivedAt });

    for (const e of insertedEvents) {
      SEED.tenantA.push({
        eventId: e.id,
        name: e.name,
        archived: e.archivedAt !== null,
      });
    }
    const [a1, a2, a3] = insertedEvents;

    // R6.B4 — seed UUIDs for matched_member_id + matched_contact_id so the
    // R3.4.2 read-time MatchResolutionInvariantError doesn't fire on
    // member_*/member_contact variants. These are arbitrary UUIDs not
    // linked to real F3 rows — sufficient for the repository-level read
    // tests which don't FK-join through members/contacts.
    const MEMBER_UUID_1 = '11111111-1111-4111-8111-aaaaaaaaaaa1';
    const MEMBER_UUID_2 = '11111111-1111-4111-8111-aaaaaaaaaaa2';
    const MEMBER_UUID_3 = '11111111-1111-4111-8111-aaaaaaaaaaa3';
    const MEMBER_UUID_4 = '11111111-1111-4111-8111-aaaaaaaaaaa4';
    const MEMBER_UUID_5 = '11111111-1111-4111-8111-aaaaaaaaaaa5';
    const CONTACT_UUID_1 = '22222222-2222-4222-8222-bbbbbbbbbbb1';
    const CONTACT_UUID_2 = '22222222-2222-4222-8222-bbbbbbbbbbb2';

    // 4 registrations on A1: 2 member_contact, 1 non_member, 1 unmatched
    await tx.insert(eventRegistrations).values([
      {
        tenantId: TENANT_A,
        eventId: a1!.id,
        externalId: 'att-A1-1',
        attendeeEmail: 'alice@member.example',
        attendeeName: 'Alice',
        matchType: 'member_contact',
        matchedMemberId: MEMBER_UUID_1,
        matchedContactId: CONTACT_UUID_1,
        registeredAt: new Date('2026-06-01T10:00:00Z'),
      },
      {
        tenantId: TENANT_A,
        eventId: a1!.id,
        externalId: 'att-A1-2',
        attendeeEmail: 'bob@member.example',
        attendeeName: 'Bob',
        matchType: 'member_contact',
        matchedMemberId: MEMBER_UUID_2,
        matchedContactId: CONTACT_UUID_2,
        registeredAt: new Date('2026-06-02T10:00:00Z'),
      },
      {
        tenantId: TENANT_A,
        eventId: a1!.id,
        externalId: 'att-A1-3',
        attendeeEmail: 'random@stranger.example',
        attendeeName: 'Random Stranger',
        matchType: 'non_member',
        registeredAt: new Date('2026-06-03T10:00:00Z'),
      },
      {
        tenantId: TENANT_A,
        eventId: a1!.id,
        externalId: 'att-A1-4',
        attendeeEmail: 'ambig@fuzzy.example',
        attendeeName: 'Ambig Fuzzy',
        matchType: 'unmatched',
        registeredAt: new Date('2026-06-04T10:00:00Z'),
      },
      // 2 on A2 — both member_domain (matched_member_id set, matched_contact_id null)
      {
        tenantId: TENANT_A,
        eventId: a2!.id,
        externalId: 'att-A2-1',
        attendeeEmail: 'c@corp.example',
        attendeeName: 'Carol',
        matchType: 'member_domain',
        matchedMemberId: MEMBER_UUID_3,
        registeredAt: new Date('2026-05-01T10:00:00Z'),
      },
      {
        tenantId: TENANT_A,
        eventId: a2!.id,
        externalId: 'att-A2-2',
        attendeeEmail: 'd@corp.example',
        attendeeName: 'Dave',
        matchType: 'member_domain',
        matchedMemberId: MEMBER_UUID_4,
        registeredAt: new Date('2026-05-02T10:00:00Z'),
      },
      // 1 on A3 (archived) — member_fuzzy (matched_member_id set, matched_contact_id null)
      {
        tenantId: TENANT_A,
        eventId: a3!.id,
        externalId: 'att-A3-1',
        attendeeEmail: 'e@fuzzy.example',
        attendeeName: 'Eve',
        matchType: 'member_fuzzy',
        matchedMemberId: MEMBER_UUID_5,
        registeredAt: new Date('2026-04-01T10:00:00Z'),
      },
    ]);

    // Webhook config row — enabled + delivered
    await tx.insert(tenantWebhookConfigs).values({
      tenantId: TENANT_A,
      source: 'eventcreate',
      webhookSecretActive: 'sec_active_test',
      enabled: true,
      lastReceivedAt: new Date('2026-06-04T10:00:00Z'),
    });
  });

  // ---- Tenant B: 1 event, no overlap with Tenant A ----------------------
  const ctxB = asTenantContext(TENANT_B);
  await runInTenant(ctxB, async (tx) => {
    const insertedB = await tx
      .insert(events)
      .values({
        tenantId: TENANT_B,
        source: 'eventcreate',
        externalId: 'evt-ext-B1',
        name: 'B1 tenant-b event',
        startDate: new Date('2026-07-15T10:00:00Z'),
      })
      .returning({ id: events.eventId });
    SEED.tenantB.push({ eventId: insertedB[0]!.id });
    await tx.insert(tenantWebhookConfigs).values({
      tenantId: TENANT_B,
      source: 'eventcreate',
      webhookSecretActive: 'sec_b_test',
      enabled: true,
      lastReceivedAt: new Date('2026-07-15T10:00:00Z'),
    });
  });

  // ---- Tenant C: no integration configured (variant a) ------------------
  // No webhook config row, no events.

  // ---- Tenant D: configured but never received (variant b) -------------
  const ctxD = asTenantContext(TENANT_D_NEVER_DELIVERED);
  await runInTenant(ctxD, async (tx) => {
    await tx.insert(tenantWebhookConfigs).values({
      tenantId: TENANT_D_NEVER_DELIVERED,
      source: 'eventcreate',
      webhookSecretActive: 'sec_d_test',
      enabled: true,
      // lastReceivedAt = null
    });
  });
});

afterAll(async () => {
  // Clean up — use root db (super-admin context) since tests own
  // these tenant rows.
  await db.execute(
    sql`DELETE FROM event_registrations WHERE tenant_id = ANY(ARRAY[${TENANT_A}, ${TENANT_B}, ${TENANT_C_EMPTY}, ${TENANT_D_NEVER_DELIVERED}])`,
  );
  await db.execute(
    sql`DELETE FROM events WHERE tenant_id = ANY(ARRAY[${TENANT_A}, ${TENANT_B}, ${TENANT_C_EMPTY}, ${TENANT_D_NEVER_DELIVERED}])`,
  );
  await db.execute(
    sql`DELETE FROM tenant_webhook_configs WHERE tenant_id = ANY(ARRAY[${TENANT_A}, ${TENANT_B}, ${TENANT_C_EMPTY}, ${TENANT_D_NEVER_DELIVERED}])`,
  );
});

describe('drizzle-events-repository.list — tenant-scoped paginated query', () => {
  it('returns ONLY tenant-A rows when run in tenant-A context', async () => {
    const ctx = asTenantContext(TENANT_A);
    const result = await runInTenant(ctx, async (tx) => {
      const repo = makeDrizzleEventsRepository(tx);
      return repo.list({
        tenantId: asTenantId(TENANT_A),
        includeArchived: false,
        partnerBenefitOnly: false,
        culturalEventOnly: false,
        categoryFilter: null,
        offset: 0,
        pageSize: 25,
      });
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // 3 seeded events on A, but `includeArchived=false` filters to 2 active.
    expect(result.value.totalCount).toBe(2);
    expect(result.value.items).toHaveLength(2);
    // No B event leaks in
    expect(
      result.value.items.every((e) => e.tenantId === TENANT_A),
    ).toBe(true);
  });

  it('includeArchived=true surfaces the archived event', async () => {
    const ctx = asTenantContext(TENANT_A);
    const result = await runInTenant(ctx, async (tx) => {
      const repo = makeDrizzleEventsRepository(tx);
      return repo.list({
        tenantId: asTenantId(TENANT_A),
        includeArchived: true,
        partnerBenefitOnly: false,
        culturalEventOnly: false,
        categoryFilter: null,
        offset: 0,
        pageSize: 25,
      });
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.totalCount).toBe(3);
    expect(
      result.value.items.some((e) => e.archivedAt !== null),
    ).toBe(true);
  });

  it('partnerBenefitOnly=true filters to A1', async () => {
    const ctx = asTenantContext(TENANT_A);
    const result = await runInTenant(ctx, async (tx) => {
      const repo = makeDrizzleEventsRepository(tx);
      return repo.list({
        tenantId: asTenantId(TENANT_A),
        includeArchived: false,
        partnerBenefitOnly: true,
        culturalEventOnly: false,
        categoryFilter: null,
        offset: 0,
        pageSize: 25,
      });
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.totalCount).toBe(1);
    expect(result.value.items[0]!.name).toBe('A1 networking');
  });
});

describe('drizzle-events-repository.getMatchCountsByEventIds — batched GROUP BY', () => {
  it('returns correct match aggregates per event with cross-tenant isolation', async () => {
    const ctx = asTenantContext(TENANT_A);
    const result = await runInTenant(ctx, async (tx) => {
      const repo = makeDrizzleEventsRepository(tx);
      const ids = SEED.tenantA.map((e) => asEventId(e.eventId));
      return repo.getMatchCountsByEventIds(asTenantId(TENANT_A), ids);
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // A1 has 4 regs (2 matched + 2 non-quota)
    const a1 = result.value.get(asEventId(SEED.tenantA[0]!.eventId));
    expect(a1).toBeDefined();
    expect(a1!.totalRegistrations).toBe(4);
    expect(a1!.matchedRegistrations).toBe(2); // both member_contact
    // A2 has 2 regs (both member_domain → matched)
    const a2 = result.value.get(asEventId(SEED.tenantA[1]!.eventId));
    expect(a2!.totalRegistrations).toBe(2);
    expect(a2!.matchedRegistrations).toBe(2);
  });

  it('returns empty Map when probed with tenant-B eventIds from tenant-A context (RLS isolation)', async () => {
    const ctx = asTenantContext(TENANT_A);
    const result = await runInTenant(ctx, async (tx) => {
      const repo = makeDrizzleEventsRepository(tx);
      const bId = asEventId(SEED.tenantB[0]!.eventId);
      return repo.getMatchCountsByEventIds(asTenantId(TENANT_A), [bId]);
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // RLS+FORCE blocks the read — no rows returned, so the Map is empty.
    expect(result.value.size).toBe(0);
  });

  it('empty eventIds[] short-circuits to empty Map (no SQL)', async () => {
    const ctx = asTenantContext(TENANT_A);
    const result = await runInTenant(ctx, async (tx) => {
      const repo = makeDrizzleEventsRepository(tx);
      return repo.getMatchCountsByEventIds(asTenantId(TENANT_A), []);
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.size).toBe(0);
  });
});

describe('drizzle-events-repository.getEmptyContext — 3-variant signal', () => {
  it('variant (a) — no integration configured for tenant-C', async () => {
    const ctx = asTenantContext(TENANT_C_EMPTY);
    const result = await runInTenant(ctx, async (tx) => {
      const repo = makeDrizzleEventsRepository(tx);
      return repo.getEmptyContext(asTenantId(TENANT_C_EMPTY));
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.integrationConfigured).toBe(false);
    expect(result.value.everReceivedDelivery).toBe(false);
    expect(result.value.totalArchived).toBe(0);
  });

  it('variant (b) — configured but never delivered for tenant-D', async () => {
    const ctx = asTenantContext(TENANT_D_NEVER_DELIVERED);
    const result = await runInTenant(ctx, async (tx) => {
      const repo = makeDrizzleEventsRepository(tx);
      return repo.getEmptyContext(asTenantId(TENANT_D_NEVER_DELIVERED));
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.integrationConfigured).toBe(true);
    expect(result.value.everReceivedDelivery).toBe(false);
  });

  it('variant (c) — tenant-A has 1 archived event', async () => {
    const ctx = asTenantContext(TENANT_A);
    const result = await runInTenant(ctx, async (tx) => {
      const repo = makeDrizzleEventsRepository(tx);
      return repo.getEmptyContext(asTenantId(TENANT_A));
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.integrationConfigured).toBe(true);
    expect(result.value.everReceivedDelivery).toBe(true);
    expect(result.value.totalArchived).toBe(1);
  });
});

describe('drizzle-registrations-repository.findByEventId — paginated attendees + matchCounts', () => {
  it('returns full-event matchCounts even when filtered by unmatchedOnly', async () => {
    const ctx = asTenantContext(TENANT_A);
    const eventId = asEventId(SEED.tenantA[0]!.eventId); // A1 (4 regs)
    const result = await runInTenant(ctx, async (tx) => {
      const repo = makeDrizzleRegistrationsRepository(tx);
      return repo.findByEventId({
        tenantId: asTenantId(TENANT_A),
        eventId,
        unmatchedOnly: true,
        matchTypeFilter: null,
        emailSearch: null,
        offset: 0,
        pageSize: 50,
      });
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // matchCounts reflects FULL event (4 regs total), NOT filtered:
    expect(
      result.value.matchCounts.memberContact +
        result.value.matchCounts.memberDomain +
        result.value.matchCounts.memberFuzzy +
        result.value.matchCounts.nonMember +
        result.value.matchCounts.unmatched,
    ).toBe(4);
    // But the items list IS filtered to non_member + unmatched (2 rows)
    expect(result.value.totalCount).toBe(2);
    // R6.B4 / Round 5 staff-review R004 closure — pin US2 AS4 filter
    // semantics. Prior assertion only checked totalCount which would
    // false-positive on a regression that filtered to `= 'unmatched'`
    // alone (excluding non_member). Now assert every returned item is
    // in the FR-002 unmatched-attention set: ('unmatched','non_member').
    expect(result.value.items).toHaveLength(2);
    const returnedTypes = result.value.items.map((r) => r.match.type).sort();
    expect(returnedTypes).toEqual(['non_member', 'unmatched']);
    for (const item of result.value.items) {
      expect(['unmatched', 'non_member']).toContain(item.match.type);
    }
  });

  it('matchTypeFilter narrows to exact match type', async () => {
    const ctx = asTenantContext(TENANT_A);
    const eventId = asEventId(SEED.tenantA[0]!.eventId);
    const result = await runInTenant(ctx, async (tx) => {
      const repo = makeDrizzleRegistrationsRepository(tx);
      return repo.findByEventId({
        tenantId: asTenantId(TENANT_A),
        eventId,
        unmatchedOnly: false,
        matchTypeFilter: 'member_contact',
        emailSearch: null,
        offset: 0,
        pageSize: 50,
      });
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.totalCount).toBe(2);
    expect(
      result.value.items.every((r) => r.match.type === 'member_contact'),
    ).toBe(true);
  });

  it('emailSearch matches substring on attendee_email + attendee_name (case-insensitive)', async () => {
    const ctx = asTenantContext(TENANT_A);
    const eventId = asEventId(SEED.tenantA[0]!.eventId);
    const result = await runInTenant(ctx, async (tx) => {
      const repo = makeDrizzleRegistrationsRepository(tx);
      return repo.findByEventId({
        tenantId: asTenantId(TENANT_A),
        eventId,
        unmatchedOnly: false,
        matchTypeFilter: null,
        emailSearch: 'aliCE',
        offset: 0,
        pageSize: 50,
      });
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.totalCount).toBe(1);
    expect(result.value.items[0]!.attendee.email).toContain('alice');
  });

  it('emailSearch query plan references event_regs_tenant_email_lower_idx (R011 staff-review fix)', async () => {
    // The contract (`admin-events-api.md § GET detail`) pins the
    // q-search column to `attendee_email_lower`, which is backed by
    // `event_regs_tenant_email_lower_idx` (migration 0131). The
    // companion behavioural test above asserts correctness ("aliCE"
    // matches "alice@member.example") but would PASS even if the
    // implementation bypassed the index by `ilike`-ing the un-lowered
    // `attendee_email` column. EXPLAIN-based test pins the planner
    // choice so a future repo edit that re-introduces `ilike` on the
    // raw column fails CI with a clear "index bypass" signal instead
    // of a silent perf regression.
    const ctx = asTenantContext(TENANT_A);
    const eventId = SEED.tenantA[0]!.eventId;
    const plan = await runInTenant(ctx, async (tx) => {
      const result = await tx.execute(sql`
        EXPLAIN (FORMAT TEXT)
        SELECT count(*)
        FROM event_registrations
        WHERE tenant_id = ${TENANT_A}
          AND event_id = ${eventId}
          AND (
            attendee_email_lower LIKE ${'%alice%'}
            OR attendee_name ILIKE ${'%alice%'}
          )
      `);
      // postgres-js returns Iterable<Record<string, unknown>>.
      // The EXPLAIN output is a column named "QUERY PLAN" on each row.
      const rows = result as unknown as ReadonlyArray<Record<string, string>>;
      return rows.map((r) => r['QUERY PLAN'] ?? '').join('\n');
    });
    // Planner-output sanity: at sub-table scale Postgres may pick a
    // Seq Scan over an index — assert the LIKE on `attendee_email_lower`
    // is reachable AND that no ILIKE is wrapping `attendee_email`
    // (the raw column). The latter is the smoking-gun if R001
    // regresses.
    expect(plan).not.toMatch(/attendee_email\s+~~\*/i); // ILIKE on raw column → planner shows `~~*`
    // attendee_email_lower must appear as a filter / index condition.
    expect(plan).toMatch(/attendee_email_lower/);
  });

  it('blocks cross-tenant probe — tenant-A context cannot read tenant-B event registrations', async () => {
    const ctx = asTenantContext(TENANT_A);
    const result = await runInTenant(ctx, async (tx) => {
      const repo = makeDrizzleRegistrationsRepository(tx);
      return repo.findByEventId({
        tenantId: asTenantId(TENANT_A),
        eventId: asEventId(SEED.tenantB[0]!.eventId),
        unmatchedOnly: false,
        matchTypeFilter: null,
        emailSearch: null,
        offset: 0,
        pageSize: 50,
      });
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.totalCount).toBe(0);
    expect(result.value.items).toEqual([]);
  });
});

// Suppress unused-symbol errors when these helpers are needed in future
// extensions.
void asExternalEventId;
void asExternalAttendeeId;
void asAttendeeEmail;
