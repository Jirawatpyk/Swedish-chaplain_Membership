/**
 * F8 Phase 4 Wave I4 — Cross-cutting `lookup-member-by-email` utility.
 *
 * Resolves an email address to `(tenantId, memberId)` for callers
 * that operate OUTSIDE a tenant scope:
 *
 *   - F1 Resend webhook (`/api/webhooks/resend/route.ts`) on a
 *     bounce event → calls `detectBounceThreshold` if the bounced
 *     email belongs to a member.
 *   - F3 verify-contact-email use-case post-success → calls
 *     `resetEmailUnverified` if the verified email belongs to a member.
 *
 * **Why cross-cutting (not a tenant-scoped repo)**: the F1 webhook
 * receives bounce events for ANY email address; we don't know which
 * tenant owns that email until we look it up. The webhook never
 * enters a tenant context until it knows which tenant to bind.
 *
 * **MTA+STD safety**: F3's `contacts_tenant_email_uniq` partial unique
 * index `(tenant_id, LOWER(email)) WHERE removed_at IS NULL` means at
 * most ONE active row matches per tenant. Under single-tenant
 * deployment, exactly one tenant exists, so the global LIMIT 1 is
 * deterministic. Post-F10 multi-tenant SaaS would need explicit
 * tenant resolution from webhook signature/metadata (out of scope).
 *
 * The lookup runs as the database role configured for the global
 * Drizzle client (no `runInTenant` binding) — RLS policies on the
 * contacts table allow the system role to read across tenants. This
 * is intentional for cross-cutting webhook ingest.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';

export interface MemberLookupResult {
  readonly tenantId: string;
  readonly memberId: string;
  readonly contactId: string;
  readonly isPrimary: boolean;
}

/**
 * Returns the FIRST active contact (any tenant, MTA+STD) matching the
 * given email address case-insensitively. Returns null when no contact
 * matches OR when the email belongs only to soft-deleted contacts.
 *
 * Caller MUST treat null as "this email is not associated with a
 * member" — don't trigger F8 hooks (no-op).
 */
export async function lookupMemberByEmail(
  email: string,
): Promise<MemberLookupResult | null> {
  if (typeof email !== 'string' || email.length === 0) return null;
  const rows = await db
    .select({
      tenantId: contacts.tenantId,
      memberId: contacts.memberId,
      contactId: contacts.contactId,
      isPrimary: contacts.isPrimary,
    })
    .from(contacts)
    .where(
      and(
        sql`LOWER(${contacts.email}) = LOWER(${email})`,
        sql`${contacts.removedAt} IS NULL`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Wave I4 / T102 companion — resolves a contactId to (tenantId, memberId).
 * Used by F3 verify-contact-email to bridge the email-change-token's
 * contactId to F8's memberId-based hooks. Returns null when the
 * contact is soft-deleted or doesn't exist.
 *
 * Like `lookupMemberByEmail`, runs cross-tenant for callers outside
 * a tenant scope. Under MTA+STD, contactId is globally unique (UUID).
 */
export async function lookupMemberByContactId(
  contactId: string,
): Promise<MemberLookupResult | null> {
  if (typeof contactId !== 'string' || contactId.length === 0) return null;
  const rows = await db
    .select({
      tenantId: contacts.tenantId,
      memberId: contacts.memberId,
      contactId: contacts.contactId,
      isPrimary: contacts.isPrimary,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.contactId, contactId),
        sql`${contacts.removedAt} IS NULL`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
