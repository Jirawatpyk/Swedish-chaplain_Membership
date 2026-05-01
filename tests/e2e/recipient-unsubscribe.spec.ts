/**
 * T139 — E2E test: recipient unsubscribe page (F7 US4).
 *
 * Covers AS1–AS5:
 *   - AS1: valid signed token → bilingual confirmation page renders
 *   - AS2: tampered token → bilingual fallback "Link is invalid" page
 *   - AS3: replay of valid token → idempotent "Already unsubscribed"
 *   - AS5: cross-tenant isolation guarded at the use-case (covered by
 *     T138 integration; redundant E2E omitted)
 *
 * Skips when E2E_MEMBER credentials + DATABASE_URL are missing
 * (matches the rest of the F7 e2e suite). The token is signed inside
 * the test using the live `UNSUBSCRIBE_TOKEN_SECRET` so the production
 * route handler verifies it as if it had been emitted from a real
 * broadcast.
 *
 * Cleanup: deletes the inserted `marketing_unsubscribes` row after the
 * test so subsequent runs see the same starting state.
 */
import { expect, test } from './fixtures';
import postgres from 'postgres';
import { createHmac } from 'node:crypto';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const DATABASE_URL = process.env.DATABASE_URL;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const SECRET = process.env.UNSUBSCRIBE_TOKEN_SECRET;

test.describe('Recipient unsubscribe — public page (T139 — F7 US4)', () => {
  test.skip(
    !DATABASE_URL || !MEMBER_EMAIL || !SECRET,
    'Set DATABASE_URL + E2E_MEMBER_EMAIL + UNSUBSCRIBE_TOKEN_SECRET',
  );

  function base64url(buf: Buffer): string {
    return buf
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  function signToken(
    tenantId: string,
    broadcastId: string,
    emailLower: string,
    lang: 'en' | 'th' | 'sv',
  ): string {
    const payload = base64url(
      Buffer.from(
        JSON.stringify({
          v: 1,
          tid: tenantId,
          bid: broadcastId,
          eml: emailLower,
          lang,
          iat: Math.floor(Date.now() / 1000),
        }),
      ),
    );
    const mac = base64url(
      createHmac('sha256', SECRET!).update(payload).digest(),
    );
    return `v1.${payload}.${mac}`;
  }

  async function findRecipient(): Promise<{
    email: string;
    broadcastId: string;
  } | null> {
    const sql = postgres(DATABASE_URL!, { ssl: 'require', max: 1 });
    try {
      // Resolve member's primary contact email + an existing seeded
      // broadcast id. If none exist we synthesise a random uuid — the
      // route is best-effort about source_broadcast_id and the
      // unsubscribe still proceeds.
      const memberRow = await sql<
        Array<{ email: string }>
      >`
        SELECT pc.email AS email
        FROM users u
        JOIN contacts c
          ON c.linked_user_id = u.id AND c.tenant_id = ${TENANT_ID}
        JOIN members m
          ON m.member_id = c.member_id AND m.tenant_id = ${TENANT_ID}
        LEFT JOIN contacts pc
          ON pc.member_id = m.member_id
         AND pc.tenant_id = ${TENANT_ID}
         AND pc.is_primary = TRUE
         AND pc.removed_at IS NULL
        WHERE u.email = ${MEMBER_EMAIL!}
        LIMIT 1
      `;
      if (memberRow.length === 0 || !memberRow[0]?.email) return null;
      const email = memberRow[0].email.toLowerCase();
      const bRow = await sql<
        Array<{ broadcast_id: string }>
      >`
        SELECT broadcast_id::text AS broadcast_id
        FROM broadcasts
        WHERE tenant_id = ${TENANT_ID}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const broadcastId =
        bRow[0]?.broadcast_id ?? '00000000-0000-0000-0000-000000000000';
      return { email, broadcastId };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  async function cleanup(email: string): Promise<void> {
    const sql = postgres(DATABASE_URL!, { ssl: 'require', max: 1 });
    try {
      await sql`
        DELETE FROM marketing_unsubscribes
        WHERE tenant_id = ${TENANT_ID}
          AND email_lower = ${email}
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  test('AS1+AS3 valid token + replay: confirmation then already-unsubscribed', async ({
    page,
  }) => {
    const ctx = await findRecipient();
    test.skip(ctx === null, 'Cannot resolve seeded member primary email');
    if (!ctx) return;

    await cleanup(ctx.email);

    const token = signToken(TENANT_ID, ctx.broadcastId, ctx.email, 'en');

    // First click — Unsubscribed (success)
    await page.goto(`/unsubscribe/${token}`);
    await expect(
      page.getByRole('heading', { name: /unsubscribed/i }),
    ).toBeVisible();

    // Replay — Already unsubscribed (idempotent)
    await page.goto(`/unsubscribe/${token}`);
    await expect(
      page.getByRole('heading', { name: /already unsubscribed/i }),
    ).toBeVisible();

    await cleanup(ctx.email);
  });

  test('AS2 tampered token → invalid-link fallback page renders', async ({
    page,
  }) => {
    const ctx = await findRecipient();
    test.skip(ctx === null, 'Cannot resolve seeded member primary email');
    if (!ctx) return;

    const token = signToken(TENANT_ID, ctx.broadcastId, ctx.email, 'en');
    const [version, payload, mac] = token.split('.') as [
      string,
      string,
      string,
    ];
    const tampered = `${version}.${payload}.${mac.slice(0, -1)}A`;
    await page.goto(`/unsubscribe/${tampered}`);
    await expect(
      page.getByRole('heading', { name: /link is invalid/i }),
    ).toBeVisible();
  });

  test('AS4 lang query param resolves locale even without token claim', async ({
    page,
  }) => {
    const ctx = await findRecipient();
    test.skip(ctx === null, 'Cannot resolve seeded member primary email');
    if (!ctx) return;
    // Tampered token still hits the invalid path; we just want to
    // assert the page renders the requested locale.
    await page.goto('/unsubscribe/garbage?lang=th');
    // Thai heading text — keep loose to absorb minor copy edits.
    await expect(page.locator('main[lang="th"]')).toBeVisible();
  });
});
