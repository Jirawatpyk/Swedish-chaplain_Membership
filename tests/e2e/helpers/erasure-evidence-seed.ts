/**
 * COMP-1 US3-D (Task 5) — E2E seed for the DPO erasure-evidence log.
 *
 * Provisions ONE simulated (NOT real-PII) ERASED member in the `swecham`
 * tenant plus the full Art.17 evidence audit trail the
 * `/admin/compliance/erasure-log` page folds into a single card:
 *
 *   - the member row itself (`erased_at` set → it appears in the
 *     `listErasedMembers` keyset list);
 *   - a `member_erasure_requested` audit row carrying the US3-A Art.12
 *     attestation (`reason` / `identity_verified` / `verification_method` /
 *     `note`) → the "Request & attestation" section;
 *   - a `member_erased` completion row with cascade counts + `re_drive: true`
 *     → the "Completion" section renders complete (NOT half-run) AND the
 *     re-drive caveat note;
 *   - an `event_buyer_pii_redacted` row (`document_kind: 'invoice'`) → the
 *     "Tax-document redactions" badge;
 *   - a `subprocessor_erasure_propagated` row → the "Sub-processor (Resend)"
 *     section.
 *
 * Tenant binding: the page resolves the tenant via `env.tenant.slug`
 * (= `swecham`) on a NORMAL admin sign-in (no `X-Tenant` header), so the
 * evidence MUST be seeded into the real `swecham` tenant — a throwaway
 * tenant would never be read by the page.
 *
 * The card is keyed by a DETERMINISTIC, HIGH `member_number` (so the spec
 * can find it by `Member #<n>` without a directory search) that is well
 * clear of the allocator's contiguous low range. CRITICAL: the member row
 * MUST be deleted in `cleanup()` — a stray high `member_number` would break
 * the `migration-0209-post-apply` contiguity invariant (MAX == COUNT) on the
 * shared dev Neon. The audit rows are append-only (the trigger blocks
 * DELETE) and left as-is; they key on the dummy member's random uuid so they
 * are harmless, unreachable orphans (no other member shares that
 * `payload.member_id`).
 *
 * Never references a real member row (per the "no real members in seed
 * scripts" rule). The company name + ids are obviously synthetic.
 *
 * No-op-safe: throws loudly if `DATABASE_URL` is missing (writes go to the
 * LIVE tenant — a silent skip would make the spec false-pass on a card that
 * was never seeded).
 */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Deterministic dummy company so the card is recognisable + idempotent. */
const DUMMY_COMPANY = 'Erasure Evidence Co (E2E)';

export interface ErasureEvidenceSeed {
  readonly memberId: string;
  readonly memberNumber: number;
  readonly companyName: string;
  /** Tear down the seeded member row. Audit rows are append-only (left as-is). */
  readonly cleanup: () => Promise<void>;
}

/**
 * Delete any seeded erasure-evidence dummy member left in `swecham`. Matches
 * by the synthetic company name (the random member_id changes per run, but the
 * company name is stable) so an interrupted prior run is cleaned up too.
 */
async function deleteDummyMembers(sql: ReturnType<typeof postgres>): Promise<void> {
  // contacts first (FK), then the member rows. Both are deletable (no
  // append-only trigger). Audit rows are intentionally NOT deleted.
  await sql`
    DELETE FROM contacts
    WHERE tenant_id = ${TENANT_ID}
      AND member_id IN (
        SELECT member_id FROM members
        WHERE tenant_id = ${TENANT_ID} AND company_name = ${DUMMY_COMPANY}
      )
  `;
  await sql`
    DELETE FROM members
    WHERE tenant_id = ${TENANT_ID} AND company_name = ${DUMMY_COMPANY}
  `;
}

export async function seedErasureEvidenceMember(): Promise<ErasureEvidenceSeed> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      '[e2e seed erasure-evidence] DATABASE_URL missing — cannot seed; gate the spec with test.skip first.',
    );
  }
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  const memberId = randomUUID();
  // A linked-user id only used inside the audit payloads' summaries — the page
  // never reads it (FIX-1 drops the user_erased arm when the member has no
  // linked login), so we do NOT seed a `user_erased` row. The credential
  // section renders its "none" empty state, which keeps the M-2 no-leak
  // assertion (no raw actor uuid in the DOM) easy to verify.
  const now = new Date();
  const requestedAt = new Date(now.getTime() - 2 * MS_PER_DAY);
  const completedAt = new Date(now.getTime() - 1 * MS_PER_DAY);

  try {
    // Anchor on a real, FK-valid (plan_id, plan_year) already present in the
    // `swecham` members table — sidesteps the composite FK to membership_plans
    // without cloning a plan row.
    const anchorRows = await sql<Array<{ plan_id: string; plan_year: number }>>`
      SELECT plan_id, plan_year FROM members
      WHERE tenant_id = ${TENANT_ID}
      ORDER BY plan_year DESC
      LIMIT 1
    `;
    const anchor = anchorRows[0];
    if (!anchor) {
      throw new Error(
        `[e2e seed erasure-evidence] no existing member in tenant ${TENANT_ID} to anchor the dummy plan FK; cannot seed.`,
      );
    }

    // Idempotent teardown of any prior run's dummy member.
    await deleteDummyMembers(sql);

    // `members.member_number` is a per-tenant-UNIQUE positive INTEGER (the
    // `SCCM-NNNN` form is display-only). Use a high value clear of the
    // allocator's contiguous low range; deleted in cleanup so it never
    // breaks the 0209 contiguity invariant.
    const memberNumber = 980_000 + Math.floor(Math.random() * 9_000);

    await sql`
      INSERT INTO members (
        tenant_id, member_id, member_number, company_name, country,
        plan_id, plan_year, registration_fee_paid, registration_date,
        status, erased_at
      )
      VALUES (
        ${TENANT_ID}, ${memberId}::uuid, ${memberNumber}, ${DUMMY_COMPANY}, 'TH',
        ${anchor.plan_id}, ${anchor.plan_year}, true, '2020-01-01',
        'active', ${completedAt.toISOString()}::timestamptz
      )
    `;

    // --- Art.17 evidence audit rows (tenant-scoped, keyed by payload.member_id).
    // The reader's Arm A matches `tenant_id = 'swecham'` +
    // `payload->>'member_id' = <memberId>`. `timestamp` is the occurredAt the
    // fold reads. `actor_user_id` is a SYSTEM marker (never a raw uuid) so the
    // M-2 no-leak assertion holds even though the page never renders it.
    async function seedAudit(
      eventType: string,
      occurredAt: Date,
      payload: Record<string, unknown>,
    ): Promise<void> {
      await sql`
        INSERT INTO audit_log (
          event_type, actor_user_id, summary, request_id, tenant_id,
          payload, "timestamp"
        )
        VALUES (
          ${eventType}, 'system:e2e-erasure-evidence',
          ${`${eventType} ${memberId}`}, ${`e2e-us3d-${randomUUID()}`},
          ${TENANT_ID}, ${sql.json({ member_id: memberId, ...payload })},
          ${occurredAt.toISOString()}
        )
      `;
    }

    await seedAudit('member_erasure_requested', requestedAt, {
      reason: 'gdpr_art17',
      identity_verified: true,
      verification_method: 'passport',
      note: 'E2E seeded request — verified identity before erasure.',
    });
    await seedAudit('member_erased', completedAt, {
      reason: 'gdpr_art17',
      re_drive: true,
      sessions_revoked_total: 0,
      invitations_revoked_count: 0,
    });
    await seedAudit('event_buyer_pii_redacted', completedAt, {
      invoice_id: randomUUID(),
      document_kind: 'invoice',
      invoice_subject: 'membership',
    });
    await seedAudit('subprocessor_erasure_propagated', completedAt, {
      reason: 'gdpr_art17',
      resend_outcome: 'ok',
      resend_contacts_removed_count: 1,
      resend_contacts_failed_count: 0,
    });

    return {
      memberId,
      memberNumber,
      companyName: DUMMY_COMPANY,
      cleanup: async () => {
        const c = postgres(dbUrl, { ssl: 'require', max: 1 });
        try {
          await deleteDummyMembers(c);
        } finally {
          await c.end({ timeout: 5 });
        }
      },
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
