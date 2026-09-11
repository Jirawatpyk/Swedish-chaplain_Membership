/**
 * F114 — e2e seed helper for the change-request specs (T044 / T058 / T066).
 *
 *   - `ensureApprovalSetting(true|false)` flips the e2e tenant's
 *     `tenant_member_settings.member_change_approval_enabled` (the tenant half
 *     of the gate; the platform flag is the dev server's env — a spec skips
 *     when `GET /api/portal/change-requests/gate` answers 404);
 *   - `wipeChangeRequestsForUser(email)` deletes every change request the
 *     persona submitted (fields cascade) plus its outbox rows, so each run
 *     starts from "no pending request";
 *   - `resolvePortalMember(email)` returns the persona's member + contact ids.
 *
 * Owner-role SQL through `openSeedClient` (fail-closed host guard). Never a
 * real member — only the seeded e2e personas.
 */
import { openSeedClient } from './open-seed-client';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const LABEL = 'e2e seed change-requests';

export interface PortalMemberRef {
  readonly userId: string;
  readonly memberId: string;
  readonly contactId: string;
  readonly isPrimary: boolean;
  readonly companyName: string;
}

export async function resolvePortalMember(userEmail: string): Promise<PortalMemberRef | null> {
  const client = openSeedClient(LABEL);
  if (!client) return null;
  const { sql, end } = client;
  try {
    const rows = await sql<Array<PortalMemberRef>>`
      SELECT u.id AS "userId", m.member_id AS "memberId", c.contact_id AS "contactId",
             c.is_primary AS "isPrimary", m.company_name AS "companyName"
      FROM users u
      JOIN contacts c ON c.linked_user_id = u.id AND c.removed_at IS NULL
      JOIN members m ON m.tenant_id = c.tenant_id AND m.member_id = c.member_id
      WHERE lower(u.email) = ${userEmail.toLowerCase()} AND c.tenant_id = ${TENANT_ID}
      LIMIT 1
    `;
    return rows[0] ?? null;
  } finally {
    await end();
  }
}

/** Returns the PREVIOUS value so a spec can restore it in afterAll. */
export async function ensureApprovalSetting(enabled: boolean): Promise<boolean | null> {
  const client = openSeedClient(LABEL);
  if (!client) return null;
  const { sql, end } = client;
  try {
    const before = await sql<Array<{ enabled: boolean }>>`
      SELECT member_change_approval_enabled AS enabled FROM tenant_member_settings WHERE tenant_id = ${TENANT_ID}
    `;
    await sql`
      INSERT INTO tenant_member_settings (tenant_id, member_change_approval_enabled)
      VALUES (${TENANT_ID}, ${enabled})
      ON CONFLICT (tenant_id) DO UPDATE SET member_change_approval_enabled = EXCLUDED.member_change_approval_enabled, updated_at = now()
    `;
    return before[0]?.enabled ?? false;
  } finally {
    await end();
  }
}

export async function wipeChangeRequestsForUser(userEmail: string): Promise<void> {
  const client = openSeedClient(LABEL);
  if (!client) return;
  const { sql, end } = client;
  try {
    const users = await sql<Array<{ id: string }>>`SELECT id FROM users WHERE lower(email) = ${userEmail.toLowerCase()} LIMIT 1`;
    const user = users[0];
    if (!user) return;
    // replaced-pointer rows first (the self-FK), then the rest; fields cascade.
    await sql`
      DELETE FROM member_change_requests
      WHERE tenant_id = ${TENANT_ID} AND submitted_by_user_id = ${user.id}::uuid AND replaced_by_request_id IS NOT NULL
    `;
    await sql`
      DELETE FROM member_change_requests
      WHERE tenant_id = ${TENANT_ID} AND submitted_by_user_id = ${user.id}::uuid
    `;
    await sql`
      DELETE FROM notifications_outbox
      WHERE tenant_id = ${TENANT_ID}
        AND notification_type IN ('member_change_request_submitted_staff', 'member_change_request_decided_member')
        AND context_data ->> 'submitterUserId' = ${user.id}
    `;
  } finally {
    await end();
  }
}

/** The persona's own LIVE contact phone (to assert "record unchanged"). */
export async function readContactPhone(contactId: string): Promise<string | null> {
  const client = openSeedClient(LABEL);
  if (!client) return null;
  const { sql, end } = client;
  try {
    const rows = await sql<Array<{ phone: string | null }>>`SELECT phone FROM contacts WHERE contact_id = ${contactId}::uuid`;
    return rows[0]?.phone ?? null;
  } finally {
    await end();
  }
}
