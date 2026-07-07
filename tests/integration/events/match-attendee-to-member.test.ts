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
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
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
        memberNumber: nextSeedMemberNumber(),
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
        memberNumber: nextSeedMemberNumber(),
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

  it('Rule 2 LIKE-wildcard escape (R6-B6) — domain containing `_` does NOT over-match similarly-shaped domains', async () => {
    // Seed a fresh member with a contact at a domain containing a
    // literal underscore. Without the round-6 B6 escape fix, the
    // generated SQL pattern `%@evil_domain.com` would treat `_` as a
    // wildcard and over-match `evilXdomain.com` / `evilYdomain.com`
    // etc., silently resolving as `member_domain` against the wrong
    // member. With the escape fix the underscore is treated literally
    // and `evilXdomain.com` falls through to `non_member`.
    const memberLikeProbeId = randomUUID();
    const contactLikeProbeId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: memberLikeProbeId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'LIKE-Escape Probe Co.',
        country: 'SE',
        planId: PLAN_ID,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: contactLikeProbeId,
        memberId: memberLikeProbeId,
        email: 'probe@evil_domain.example',
        firstName: 'Like',
        lastName: 'Probe',
        isPrimary: true,
      } as unknown as typeof contacts.$inferInsert);
    });
    // Attempt to match an attendee at `evilXdomain.example` — without
    // ESCAPE this would falsely resolve to the LIKE-probe member.
    const result = await runInTenant(tenant.ctx, async (tx) => {
      const matcher = makeDrizzleAttendeeMatcher(tx);
      return matchAttendeeToMember(
        {
          tenantId: asTenantId(tenant.ctx.slug),
          attendeeEmail: asAttendeeEmail('attendee@evilXdomain.example'),
          attendeeCompany: null,
        },
        { matcher },
      );
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Must NOT match the LIKE-probe member via wildcard expansion.
      expect(result.value.resolution.type).toBe('non_member');
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
        memberNumber: nextSeedMemberNumber(),
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

  // ──────────────────────────────────────────────────────────────────────
  // PR 1.1 (096-f6-match-engine) — match-engine remediation fixes M4/M5/M6.
  // Appended AFTER the ordered Rule-1…5 fixtures so the shared-tenant pool
  // they rely on is never perturbed (these seed only in their own it-block,
  // which vitest runs in file order after every fixture above). The match-
  // rate math (SC-002) and the 5 existing outcomes stay green.
  // ──────────────────────────────────────────────────────────────────────

  // M4 (FR-012) — fuzzy Levenshtein threshold raised 2 → 3. A member whose
  // normalised company name is EXACTLY edit-distance 3 from the attendee
  // company, and the unique nearest in the tenant pool, must resolve as
  // `member_fuzzy` rather than being demoted to `non_member`.
  //
  // Hand-verified distance (edit-by-edit — NOT intuited):
  //   normaliseCompanyName('Zephyr Robotics AB') = 'zephyr robotics'
  //   normaliseCompanyName('Zephyr Rabotix')     = 'zephyr rabotix'
  //   Common prefix 'zephyr r' (8 chars → 0 edits); the remaining
  //   'obotics' → 'abotix' is 3 edits:
  //     o→a (substitute), b·b, o·o, t·t, i·i, c→x (substitute), s (delete).
  //   ⇒ levenshtein('zephyr robotics','zephyr rabotix') = 3.
  // RED at threshold 2 (distance 3 filtered → non_member); GREEN at 3.
  it('M4 (FR-012) — distance-3 fuzzy match resolves member_fuzzy (demoted to non_member at threshold 2)', async () => {
    const zephyrMemberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: zephyrMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Zephyr Robotics AB', // → normalised 'zephyr robotics'
        country: 'SE',
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
          attendeeEmail: asAttendeeEmail('attendee@zephyr-signup.example'),
          attendeeCompany: 'Zephyr Rabotix', // → 'zephyr rabotix', distance 3
        },
        { matcher },
      );
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // A closer OR tied member would break these three — so the assertions
      // themselves prove the seeded member is the unique winner at ≤3.
      expect(result.value.resolution.type).toBe('member_fuzzy');
      expect(result.value.resolution.matchedMemberId).toBe(zephyrMemberId);
      expect(result.value.fuzzyDetail).not.toBeNull();
      expect(result.value.fuzzyDetail?.levenshteinDistance).toBe(3);
    }
  });

  // M5(a) — Rule 1 must exclude soft-removed contacts. A member whose ONLY
  // email-matching contact is soft-removed must NOT resolve `member_contact`
  // (the partial `contacts_tenant_email_uniq` index lets a removed contact
  // coexist with an active one on the same lower(email)). Company null → the
  // cascade falls through to non_member.
  it('M5(a) Rule 1 — soft-removed exact-email contact does NOT resolve member_contact', async () => {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Softremove Rule One Holdings',
        country: 'SE',
        planId: PLAN_ID,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Removed',
        lastName: 'Contact',
        email: 'only-contact@softremoved-rule1.example',
        isPrimary: false, // removed ⇒ not primary (Domain invariant)
        removedAt: new Date(),
      } as unknown as typeof contacts.$inferInsert);
    });

    const result = await runInTenant(tenant.ctx, async (tx) => {
      const matcher = makeDrizzleAttendeeMatcher(tx);
      return matchAttendeeToMember(
        {
          tenantId: asTenantId(tenant.ctx.slug),
          attendeeEmail: asAttendeeEmail('only-contact@softremoved-rule1.example'),
          attendeeCompany: null,
        },
        { matcher },
      );
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolution.type).not.toBe('member_contact');
      expect(result.value.resolution.type).toBe('non_member');
    }
  });

  // M5(b) — Rule 2 must exclude soft-removed contacts. A member whose ONLY
  // contact at a domain is soft-removed must NOT resolve `member_domain`.
  it('M5(b) Rule 2 — soft-removed domain contact does NOT resolve member_domain', async () => {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Ghost Domain Rule Two Ltd',
        country: 'SE',
        planId: PLAN_ID,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Ghost',
        lastName: 'Removed',
        email: 'original@ghost-co.example',
        isPrimary: false,
        removedAt: new Date(),
      } as unknown as typeof contacts.$inferInsert);
    });

    const result = await runInTenant(tenant.ctx, async (tx) => {
      const matcher = makeDrizzleAttendeeMatcher(tx);
      return matchAttendeeToMember(
        {
          tenantId: asTenantId(tenant.ctx.slug),
          attendeeEmail: asAttendeeEmail('new@ghost-co.example'),
          attendeeCompany: null,
        },
        { matcher },
      );
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolution.type).not.toBe('member_domain');
      expect(result.value.resolution.type).toBe('non_member');
    }
  });

  // M5(c) — match-rate preservation (false-negative fix). An ACTIVE contact
  // at a shared domain for member A must still resolve `member_domain` → A
  // even when a soft-removed contact for member B shares the same domain.
  // Before the fix, the soft-removed contact inflates the distinct-member
  // count to 2 and suppresses the domain match (→ non_member).
  it('M5(c) Rule 2 — active domain contact wins over a soft-removed peer (false-negative fix)', async () => {
    const sharedAId = randomUUID();
    const sharedBId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: sharedAId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Shared Domain Alpha Holdings',
        country: 'SE',
        planId: PLAN_ID,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: sharedBId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Shared Domain Bravo Holdings',
        country: 'SE',
        planId: PLAN_ID,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      // Active contact for A at the shared domain.
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId: sharedAId,
        firstName: 'Alice',
        lastName: 'Active',
        email: 'alice@shared-co.example',
        isPrimary: true,
      } as unknown as typeof contacts.$inferInsert);
      // Soft-removed contact for B at the SAME domain (must be ignored).
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId: sharedBId,
        firstName: 'Bob',
        lastName: 'Removed',
        email: 'bob@shared-co.example',
        isPrimary: false,
        removedAt: new Date(),
      } as unknown as typeof contacts.$inferInsert);
    });

    const result = await runInTenant(tenant.ctx, async (tx) => {
      const matcher = makeDrizzleAttendeeMatcher(tx);
      return matchAttendeeToMember(
        {
          tenantId: asTenantId(tenant.ctx.slug),
          attendeeEmail: asAttendeeEmail('newperson@shared-co.example'),
          attendeeCompany: null,
        },
        { matcher },
      );
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolution.type).toBe('member_domain');
      expect(result.value.resolution.matchedMemberId).toBe(sharedAId);
    }
  });

  // M6(a) — Rule 3 must exclude ARCHIVED members from the fuzzy candidate
  // pool. An archived member that would otherwise be the unique fuzzy winner
  // must NOT resolve `member_fuzzy` (→ non_member here). Runs BEFORE M6(b)
  // so this archived 'nimbus data' member is the only such member when it
  // executes ("unique in the tenant pool").
  it('M6(a) Rule 3 — archived member is excluded from the fuzzy candidate pool', async () => {
    const archivedMemberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: archivedMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Nimbus Data', // → normalised 'nimbus data'
        country: 'SE',
        planId: PLAN_ID,
        planYear: 2026,
        status: 'archived',
        archivedAt: new Date(),
      } as unknown as typeof members.$inferInsert);
    });

    const result = await runInTenant(tenant.ctx, async (tx) => {
      const matcher = makeDrizzleAttendeeMatcher(tx);
      return matchAttendeeToMember(
        {
          tenantId: asTenantId(tenant.ctx.slug),
          attendeeEmail: asAttendeeEmail('attendee@nimbus-signup-a.example'),
          attendeeCompany: 'Nimbus Data',
        },
        { matcher },
      );
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolution.type).not.toBe('member_fuzzy');
      expect(result.value.resolution.type).toBe('non_member');
    }
  });

  // M6(b) — match-rate preservation. An ACTIVE member and an ARCHIVED member
  // that both normalise to the SAME company name ('nimbus data') must NOT tie
  // into `unmatched`. Excluding the archived member leaves the active one as
  // the unique fuzzy winner. (M6(a)'s archived 'nimbus data' member is also
  // excluded, so it cannot re-introduce the tie.)
  it('M6(b) Rule 3 — active member wins fuzzy over an archived same-name peer (no false tie)', async () => {
    const activeMemberId = randomUUID();
    const archivedPeerId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: activeMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Nimbus Data Co', // → 'nimbus data'
        country: 'SE',
        planId: PLAN_ID,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: archivedPeerId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Nimbus Data Limited', // → 'nimbus data'
        country: 'SE',
        planId: PLAN_ID,
        planYear: 2026,
        status: 'archived',
        archivedAt: new Date(),
      } as unknown as typeof members.$inferInsert);
    });

    const result = await runInTenant(tenant.ctx, async (tx) => {
      const matcher = makeDrizzleAttendeeMatcher(tx);
      return matchAttendeeToMember(
        {
          tenantId: asTenantId(tenant.ctx.slug),
          attendeeEmail: asAttendeeEmail('attendee@nimbus-signup-b.example'),
          attendeeCompany: 'Nimbus Data',
        },
        { matcher },
      );
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolution.type).toBe('member_fuzzy');
      expect(result.value.resolution.matchedMemberId).toBe(activeMemberId);
    }
  });

  // Cross-tenant probe (Constitution Principle I, NON-NEGOTIABLE). The
  // matcher reads F3 members/contacts under RLS; a matcher bound to tenant
  // A's tx MUST NOT resolve a member that lives in tenant B even when the
  // attendee's email AND company exactly match B's seeded member. Passes RED
  // and GREEN — it guards isolation, not the fix.
  it('cross-tenant isolation — a tenant-B member is invisible to a tenant-A matcher', async () => {
    const other = await createTestTenant('test-chamber');
    try {
      const otherUser = await createActiveTestUser('admin');
      const otherPlanId = `test-plan-${randomUUID()}`;
      const otherMemberId = randomUUID();
      await runInTenant(other.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: other.ctx.slug,
          planId: otherPlanId,
          planName: { en: 'Cross-Tenant Probe Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: otherUser.userId,
        });
      });
      await runInTenant(other.ctx, async (tx) => {
        await tx.insert(members).values({
          tenantId: other.ctx.slug,
          memberId: otherMemberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Crosstenant Probe Match Co',
          country: 'SE',
          planId: otherPlanId,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(contacts).values({
          tenantId: other.ctx.slug,
          contactId: randomUUID(),
          memberId: otherMemberId,
          firstName: 'Cross',
          lastName: 'Tenant',
          email: 'probe@crosstenant-isolated.example',
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
      });

      // Run the matcher under tenant A's RLS context with attendee data that
      // exactly matches tenant B's member (email + company).
      const result = await runInTenant(tenant.ctx, async (tx) => {
        const matcher = makeDrizzleAttendeeMatcher(tx);
        return matchAttendeeToMember(
          {
            tenantId: asTenantId(tenant.ctx.slug),
            attendeeEmail: asAttendeeEmail('probe@crosstenant-isolated.example'),
            attendeeCompany: 'Crosstenant Probe Match Co',
          },
          { matcher },
        );
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // RLS + explicit tenantId filter hide tenant B — no leak via any rule.
        expect(result.value.resolution.type).toBe('non_member');
        expect(result.value.resolution.matchedMemberId).toBeNull();
      }
    } finally {
      await other.cleanup();
    }
  });
});
