/**
 * Smoke test TC-005 completion: link F1 smoke user to an existing F3
 * contact so the /portal page resolves a member. In real F3 flow this
 * link happens inside the `invite-portal` use case (admin invites a
 * contact → F1 invite created → contact.linked_user_id set to F1 user).
 *
 * We bypass the UI flow here to complete the smoke test without
 * creating another F3 member company just for this link.
 */
import postgres from 'postgres';
process.loadEnvFile?.('.env.local');
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!;
const sql = postgres(url, { max: 1, ssl: 'require' });

async function main() {
  const email = 'smoketest-20260418@swecham.test';

  const users = await sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
  if (users.length === 0) {
    console.error('User not found:', email);
    process.exit(1);
  }
  const userId = (users[0] as { id: string }).id;
  console.log('Smoke user id:', userId);

  // Find any primary contact on an active member that is NOT yet linked.
  const candidates = await sql`
    SELECT c.tenant_id, c.contact_id, c.member_id, c.email AS contact_email, m.company_name
    FROM contacts c
    JOIN members m ON m.member_id = c.member_id AND m.tenant_id = c.tenant_id
    WHERE c.is_primary = true
      AND c.removed_at IS NULL
      AND c.linked_user_id IS NULL
      AND m.status = 'active'
    LIMIT 1
  `;
  if (candidates.length === 0) {
    console.error('No unlinked primary contact found — create one via /admin/members/new first');
    process.exit(1);
  }
  const c = candidates[0] as {
    tenant_id: string;
    contact_id: string;
    member_id: string;
    contact_email: string;
    company_name: string;
  };
  console.log('Linking to contact:');
  console.log('  tenant_id =', c.tenant_id);
  console.log('  company   =', c.company_name);
  console.log('  contact   =', c.contact_email);

  await sql`
    UPDATE contacts
    SET linked_user_id = ${userId},
        updated_at = NOW()
    WHERE tenant_id = ${c.tenant_id}
      AND contact_id = ${c.contact_id}
  `;
  console.log('\n✓ Linked contact', c.contact_id, '→ user', userId);
  console.log('  Refresh /portal now — it should show', c.company_name);

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
