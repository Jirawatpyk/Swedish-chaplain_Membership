/**
 * F3 Contacts — Drizzle schema.
 *
 * Child entity of Member (no independent lifecycle). See data-model.md § 1.2.
 *
 * Notable indexes:
 *   - `contacts_tenant_email_uniq` — per-tenant case-insensitive unique email
 *     on non-removed contacts (supports FR-021 per-tenant uniqueness; same
 *     email can appear across tenants — spec edge case "consultant holds
 *     portal access across multiple tenants").
 *   - `contacts_one_primary_per_member` — FR-003 invariant enforced at the DB
 *     layer via a partial unique index on `is_primary = TRUE AND removed_at IS NULL`.
 *
 * The composite FK back to `members(tenant_id, member_id)` is declared at the
 * migration layer (drizzle-kit cannot emit composite FKs from column-level
 * `references()` calls).
 *
 * RLS policies + pg_trgm indexes are hand-extended in the migration.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  date,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// --- contacts -----------------------------------------------------------------

export const contacts = pgTable(
  'contacts',
  {
    // Tenancy (denormalized from parent member for RLS)
    tenantId: text('tenant_id').notNull(),

    // Identity — UUID v4
    contactId: uuid('contact_id').notNull(),

    // Parent member (composite FK enforced at migration layer)
    memberId: uuid('member_id').notNull(),

    // Human
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    roleTitle: text('role_title'),
    preferredLanguage: char('preferred_language', { length: 2 })
      .notNull()
      .default('en'),

    // Primary contact invariant — enforced by partial unique index below +
    // Domain policy `primary-contact-invariant.ts` (double guard).
    isPrimary: boolean('is_primary').notNull().default(false),

    // Collected ONLY for Thai Alumni (Application-layer rule, not a DB constraint).
    // Excluded from default API responses; opt-in via admin-only query param.
    dateOfBirth: date('date_of_birth'),

    // Optional F1 user binding — set on invitation acceptance. Column is a
    // bare `uuid` here; the FK to `users(id)` is declared at the migration
    // layer to keep the Members module barrel decoupled from Auth schema
    // types (plan E2 — branded UserId opacity).
    linkedUserId: uuid('linked_user_id'),

    // Soft-delete — removed contacts retained for audit. `is_primary` MUST be
    // FALSE when `removed_at IS NOT NULL` (Domain invariant).
    removedAt: timestamp('removed_at', { withTimezone: true }),

    // F3 spec § Edge Cases — set when the F1 invitation email to this contact
    // bounces (Resend `email.bounced`). Marks the pending invitation as failed
    // (the invitations table has no failure state of its own), anchors the
    // directory "invite bounced" warning badge, and is cleared on re-send.
    // NULL = no bounce recorded.
    inviteBouncedAt: timestamp('invite_bounced_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'contacts_pkey',
      columns: [table.tenantId, table.contactId],
    }),
    // Per-tenant listing per member (active contacts only)
    index('contacts_tenant_member_idx')
      .on(table.tenantId, table.memberId)
      .where(sql`removed_at IS NULL`),
    // Per-tenant case-insensitive email uniqueness on active contacts (FR-021)
    uniqueIndex('contacts_tenant_email_uniq')
      .on(table.tenantId, sql`lower(${table.email})`)
      .where(sql`removed_at IS NULL`),
    // FR-003 primary-contact invariant — exactly one primary per member
    uniqueIndex('contacts_one_primary_per_member')
      .on(table.tenantId, table.memberId)
      .where(sql`is_primary = TRUE AND removed_at IS NULL`),
    // Note: pg_trgm GIN index on (first_name || ' ' || last_name) is added
    // via raw SQL in the migration.
  ],
);

// --- Inferred row types -------------------------------------------------------

export type ContactRow = typeof contacts.$inferSelect;
export type ContactInsert = typeof contacts.$inferInsert;
