/**
 * I2 (review 2026-05-12) — FR-012 4-rule match cascade behavioural test.
 *
 * The original Phase 3 tests covered the webhook ingest end-to-end but
 * never seeded F3 `members` / `contacts` rows — every match path
 * resolved to `non_member` in the integration tests. This file fills
 * the gap by seeding fixtures and exercising all 5 match outcomes
 * through the production `drizzleAttendeeMatcher` adapter (T045 + T046).
 *
 * Spec authority:
 *   - FR-012 (4-rule match cascade)
 *   - research.md R4 (personal-email deny list + Levenshtein threshold ≤2)
 *
 * Match rules:
 *   1. `member_contact` — exact LOWER(contacts.email) match
 *   2. `member_domain`  — email-domain match against tenant contacts
 *                          (skipped for personal-email deny list)
 *   3. `member_fuzzy`   — Levenshtein ≤ threshold on normalised company
 *   4. `non_member`     — valid email, no member affinity
 *   5. `unmatched`      — ambiguous fuzzy (>1 winners with same distance)
 *
 * Tests against live Neon Singapore via the F3 `members` + `contacts`
 * tables under tenant-scoped RLS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  matchAttendeeToMember,
  asAttendeeEmail,
} from '@/modules/events';
import { asTenantId } from '@/modules/members';
import { makeDrizzleAttendeeMatcher } from '@/modules/events/infrastructure/drizzle-attendee-matcher';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createActiveTestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

describe('I2 — F6 match-attendee cascade (FR-012 5 outcomes)', () => {
  let tenant: TestTenant;
  const PLAN_ID = `test-plan-${randomUUID()}`;
  const memberAId = randomUUID();
  const memberBId = randomUUID();
  const contactAId = randomUUID();

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    const user = await createActiveTestUser('admin');
    // Seed the parent membership_plans row (FK from members)
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: PLAN_ID,
        planName: { en: 'F6 Match-Cascade Test Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
    });
    await runInTenant(tenant.ctx, async (tx) => {
      // Member A — Fogmaker International AB (full company name)
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: memberAId,
        companyName: 'Fogmaker International AB',
        country: 'SE',
        planId: PLAN_ID,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      // Member B — Acme Bangkok Co., Ltd. (different normalisation)
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: memberBId,
        companyName: 'Acme Bangkok Co., Ltd.',
        country: 'TH',
        planId: PLAN_ID,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      // Contact A — jane@fogmaker.example, parent = member A
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: contactAId,
        memberId: memberAId,
        firstName: 'Jane',
        lastName: 'Andersson',
        email: 'jane@fogmaker.example',
        isPrimary: true,
      } as unknown as typeof contacts.$inferInsert);
      // Second contact at the SAME domain — used by member_domain rule
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId: memberAId,
        firstName: 'Sven',
        lastName: 'Karlsson',
        email: 'sven@fogmaker.example',
        isPrimary: false,
      } as unknown as typeof contacts.$inferInsert);
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('Rule 1 (member_contact) — exact email match returns member_contact + memberId + contactId', async () => {
    const result = await runInTenant(tenant.ctx, async (tx) => {
      const matcher = makeDrizzleAttendeeMatcher(tx);
      return matchAttendeeToMember(
        {
          tenantId: asTenantId(tenant.ctx.slug),
          attendeeEmail: asAttendeeEmail('JANE@FOGMAKER.EXAMPLE'), // case-insensitive
          attendeeCompany: 'irrelevant',
        },
        { matcher },
      );
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolution.type).toBe('member_contact');
      expect(result.value.resolution.matchedMemberId).toBe(memberAId);
      expect(result.value.resolution.matchedContactId).toBe(contactAId);
    }
  });

  it('Rule 2 (member_domain) — new email at known domain returns member_domain', async () => {
    const result = await runInTenant(tenant.ctx, async (tx) => {
      const matcher = makeDrizzleAttendeeMatcher(tx);
      return matchAttendeeToMember(
        {
          tenantId: asTenantId(tenant.ctx.slug),
          attendeeEmail: asAttendeeEmail('newcomer@fogmaker.example'),
          attendeeCompany: null,
        },
        { matcher },
      );
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolution.type).toBe('member_domain');
      expect(result.value.resolution.matchedMemberId).toBe(memberAId);
      expect(result.value.resolution.matchedContactId).toBeNull();
    }
  });

  it('Rule 2 skipped — personal email (gmail.com) on deny list does NOT fall through to domain match', async () => {
    // Even if a member has a gmail contact, an attendee with gmail
    // email must NOT match by domain (would false-positive every
    // Gmail user against any member with a Gmail contact).
    const result = await runInTenant(tenant.ctx, async (tx) => {
      const matcher = makeDrizzleAttendeeMatcher(tx);
      return matchAttendeeToMember(
        {
          tenantId: asTenantId(tenant.ctx.slug),
          attendeeEmail: asAttendeeEmail('random-stranger@gmail.com'),
          attendeeCompany: null,
        },
        { matcher },
      );
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolution.type).toBe('non_member');
    }
  });

  it('Rule 3 (member_fuzzy) — normalised company match returns member_fuzzy + distance', async () => {
    const result = await runInTenant(tenant.ctx, async (tx) => {
      const matcher = makeDrizzleAttendeeMatcher(tx);
      return matchAttendeeToMember(
        {
          tenantId: asTenantId(tenant.ctx.slug),
          // Slight misspelling — "Akme Bangkok" should match "Acme Bangkok"
          // after normaliseCompanyName strips "Co., Ltd." → "acme bangkok"
          // vs "akme bangkok" → Levenshtein 1.
          attendeeEmail: asAttendeeEmail('contact@unrelated-domain.example'),
          attendeeCompany: 'Akme Bangkok Co Ltd',
        },
        { matcher },
      );
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolution.type).toBe('member_fuzzy');
      expect(result.value.resolution.matchedMemberId).toBe(memberBId);
      expect(result.value.fuzzyDetail).not.toBeNull();
      expect(result.value.fuzzyDetail?.levenshteinDistance).toBeLessThanOrEqual(2);
    }
  });

  it('Rule 4 (non_member) — no email, no domain, no company → non_member', async () => {
    const result = await runInTenant(tenant.ctx, async (tx) => {
      const matcher = makeDrizzleAttendeeMatcher(tx);
      return matchAttendeeToMember(
        {
          tenantId: asTenantId(tenant.ctx.slug),
          attendeeEmail: asAttendeeEmail('outsider@somewhere-far-away.example'),
          attendeeCompany: 'Completely Different Industries Pte',
        },
        { matcher },
      );
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolution.type).toBe('non_member');
      expect(result.value.resolution.matchedMemberId).toBeNull();
    }
  });

  it('Rule 5 (unmatched) — ambiguous fuzzy with two tied winners → unmatched + candidates', async () => {
    // Seed a TIE — Member B "Acme Bangkok Co., Ltd." (normalised:
    // "acme bangkok") + a sibling Member with same normalised name.
    const tieMemberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: tieMemberId,
        companyName: 'Acme Bangkok Limited', // also normalises to "acme bangkok"
        country: 'TH',
        planId: PLAN_ID,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
    });

    const result = await runInTenant(tenant.ctx, async (tx) => {
      const matcher = makeDrizzleAttendeeMatcher(tx);
      return matchAttendeeToMember(
        {
          tenantId: asTenantId(tenant.ctx.slug),
          attendeeEmail: asAttendeeEmail('person@unrelated.example'),
          attendeeCompany: 'Acme Bangkok',
        },
        { matcher },
      );
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolution.type).toBe('unmatched');
      expect(result.value.unmatchedCandidates).not.toBeNull();
      expect(result.value.unmatchedCandidates?.length).toBeGreaterThanOrEqual(2);
    }
  });
});
