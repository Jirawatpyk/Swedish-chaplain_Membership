/**
 * COMP-1 Member Erasure — shared anonymisation sentinels.
 *
 * Single source of truth so the members scrub, the contacts scrub, and the
 * tests agree on the exact tombstone values (a drift between them would make a
 * PII-oracle test pass while real data stays identifiable). Domain-pure: no
 * framework imports.
 */

/** Replaces NOT NULL free-text identity columns (company_name, first/last name). */
export const ERASED_SENTINEL = '[erased]' as const;

/** Domain of the per-contact non-routable sentinel email (RFC 6761 reserved). */
export const ERASED_EMAIL_DOMAIN = 'erased.invalid' as const;

/**
 * Local-part prefix of the per-contact sentinel email. The full sentinel is
 * `erased+<contact_id>@erased.invalid` — the `+contact_id` tag keeps two erased
 * contacts from colliding on the `contacts_tenant_email_uniq` partial index.
 * Single source so the contacts scrub `sql` template and any oracle agree.
 */
export const ERASED_EMAIL_LOCAL_PREFIX = 'erased+' as const;
