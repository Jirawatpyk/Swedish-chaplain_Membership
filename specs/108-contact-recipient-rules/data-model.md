# Data Model — 108 Contact Recipient Rules

Changes: three new nullable columns + one partial index on `contacts`; one nullable column on
`marketing_unsubscribes`; two deferred constraint triggers; three `audit_event_type` values;
one optional audience-build table (PR-C, only if the F7.1a batch persistence cannot be
reused — research R9 / V2). No column drops, no enum widening beyond audit events, no new
module. All timestamps ISO 8601 UTC (Gregorian). Design authority: `research.md` R1–R15.

## 1. Domain

### Contact (members/domain/contact.ts) — extended

```ts
type MarketingOptOut =
  | { readonly optedOutAt: null; readonly source: null; readonly byUserId: null }      // receives
  | { readonly optedOutAt: Date; readonly source: 'staff' | 'self'; readonly byUserId: UserId };

interface Contact {
  // existing fields unchanged (tenantId, contactId, memberId, names, email, phone, roleTitle,
  // preferredLanguage, dateOfBirth, linkedUserId, inviteBouncedAt, art14AttestedAt, timestamps)
  // + existing correlated primacy union { isPrimary: true; removedAt: null } | { isPrimary: false; removedAt: Date | null }
  readonly marketing: MarketingOptOut;
}
```

- The three columns are correlated exactly like `isPrimary`/`removedAt`: all null or all
  set (DB CHECK + `contactMarketing()` constructor that throws, mirroring `contactPrimacy()`).
- **Marketing state** (derived, never stored) = `unsubscribed` if the address is on the
  suppression list, else `off_by_staff` / `off_by_contact` if `optedOutAt` set, else `on`.
  Precedence: suppression > opt-out > on (FR-025).
- Money-email eligibility is `isPrimary && removedAt === null` only; the marketing state
  never touches it (FR-033).

### Primary-contact invariant (members/domain/policies/primary-contact-invariant.ts) — wired

Unchanged signature `assertPrimaryContactInvariant(contacts, memberStatus)`. Now called
inside the transaction by `removeContact`, `promotePrimary`, `addContact`,
`undeleteMember` on the post-mutation contact list (needs new
`ContactRepo.listByMemberInTx`). Archived members remain exempt; erased members are
excluded from the check by the caller (they never reach these use cases).

### Money-email recipient (invoicing/application/lib/resolve-money-recipient.ts) — new

```ts
type MoneyRecipient =
  | { kind: 'member'; email: string; locale: F4OutboxLocale | null }   // live primary contact
  | { kind: 'non_member'; email: string }                              // memberId === null (event buyer, admin-typed)
  | { kind: 'no_recipient' };                                          // member has no live primary → FR-003
```

Rule: `kind` is decided by `invoice.memberId` (null → snapshot email; else live read via the
widened `RecipientLocalePort`). The frozen `MemberIdentitySnapshot` is never consulted for a
member invoice's *delivery* address.

### Broadcast audience (broadcasts/domain) — extended

```ts
interface ContactRecipient {            // replaces MemberRecipient in the resolver pipeline
  readonly memberId: string;
  readonly contactId: string | null;    // null ⇒ orphan member (no eligible contact)
  readonly emailLower: EmailLower | null;
  readonly isPrimary: boolean;
}
type AudienceMode = 'primary_only' | 'all_contacts';   // flag value passed in, Domain stays pure
audienceCeiling(batchingEnabled: boolean): 5000 | 50000;
```

Eligibility (all_contacts): member `status = 'active' AND erased_at IS NULL AND
broadcasts_halted_until_admin_review = false` (+ tier) × contact `removed_at IS NULL AND
marketing_opt_out_at IS NULL`; then minus suppression list, minus every contact of the
requesting member, deduplicated by `emailLower`. Ceiling checked last.

## 2. Storage (Neon Postgres, hand-written SQL migrations)

### 2.1 `contacts` — migration 0294 (PR-D)

| Column | Type | Notes |
|---|---|---|
| `marketing_opt_out_at` | `timestamptz NULL` | NULL = receives marketing (FR-027, no backfill) |
| `marketing_opt_out_source` | `text NULL` | CHECK `IN ('staff','self')` |
| `marketing_opt_out_by_user_id` | `uuid NULL` | staff user or the contact's own linked user; no FK (users may be erased; audit carries the actor) |

- CHECK `contacts_marketing_opt_out_correlated`: `(marketing_opt_out_at IS NULL AND
  marketing_opt_out_source IS NULL AND marketing_opt_out_by_user_id IS NULL) OR
  (marketing_opt_out_at IS NOT NULL AND marketing_opt_out_source IS NOT NULL AND
  marketing_opt_out_by_user_id IS NOT NULL)`.
- Partial index `contacts_marketing_recipients_idx ON contacts (tenant_id, member_id,
  contact_id) WHERE removed_at IS NULL AND marketing_opt_out_at IS NULL` — the keyset
  pagination order of the audience query.
- RLS: existing `tenant_isolation_on_contacts` (ENABLE + FORCE) covers the new columns; no
  policy change. Erasure scrub: columns classified **KEPT** (not PII; irrelevant once
  `is_primary = false` and email is scrubbed) — update the SCRUBBED/KEPT partition test.

### 2.2 Primary-contact constraint triggers — migration 0293 (PR-B)

```sql
-- pre-check: fail the deploy if the invariant is already broken (counts only, no PII)
DO $$ DECLARE bad int; BEGIN
  SELECT count(*) INTO bad FROM members m
   WHERE m.status <> 'archived' AND m.erased_at IS NULL
     AND (SELECT count(*) FROM contacts c WHERE c.tenant_id = m.tenant_id AND c.member_id = m.member_id
            AND c.is_primary AND c.removed_at IS NULL) <> 1;
  IF bad > 0 THEN RAISE EXCEPTION 'primary-contact invariant violated for % member(s); fix before migrating', bad; END IF;
END $$;

CREATE OR REPLACE FUNCTION contacts_assert_one_primary() RETURNS trigger …  -- SECURITY DEFINER, counts live primaries for the affected member; RAISE on <> 1 unless member archived/erased
DROP TRIGGER IF EXISTS contacts_one_primary_ct ON contacts;
CREATE CONSTRAINT TRIGGER contacts_one_primary_ct AFTER INSERT OR UPDATE OR DELETE ON contacts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION contacts_assert_one_primary();
DROP TRIGGER IF EXISTS members_one_primary_ct ON members;
CREATE CONSTRAINT TRIGGER members_one_primary_ct AFTER UPDATE OF status, erased_at ON members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION contacts_assert_one_primary();
```

- Deferred to commit so demote-then-promote and scrub + `erased_at` (one tx, verified
  `erase-member.ts:358-530`) pass, while promote/remove races and a bad unarchive fail
  with a typed DB error (mapped to `repo.conflict{reason:'primary_contact_race'}` /
  `no_primary_contact`).
- Function must read through RLS correctly: SECURITY DEFINER owned by the migration role,
  filtering by the row's `tenant_id` explicitly (memory: null-tx / GUC gotchas).

### 2.3 `marketing_unsubscribes` — migration 0296 (PR-C)

| Column | Type | Notes |
|---|---|---|
| `contact_id` | `uuid NULL` | best-effort attribution alongside the existing nullable `member_id`; PK `(tenant_id, email_lower)` unchanged; rows still never deleted |

Index `marketing_unsubscribes_contact_lookup_idx (tenant_id, contact_id) WHERE contact_id IS NOT NULL`.

### 2.4 Audit enum — migrations 0292 (PR-A) and 0295 (PR-D)

`ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS …` for
`auto_email_skipped_no_recipient` (0292), `contact_marketing_opted_out`,
`contact_marketing_opted_in` (0295). Own file(s), no other DDL (autocommit pre-pass rule).
Retention: 5 years (default). Payloads carry ids and `source`, never an email address.

### 2.5 Audience build (PR-C, conditional) — migration 0297

Only if the F7.1a batch tables cannot host the resolved list (research V2/R9):

```sql
CREATE TABLE broadcast_audience_members (
  tenant_id text NOT NULL, broadcast_id uuid NOT NULL, email_lower text NOT NULL,
  pushed_at timestamptz NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, broadcast_id, email_lower));
-- RLS ENABLE + FORCE + tenant_isolation policy (clone 0139 block); index (tenant_id, broadcast_id) WHERE pushed_at IS NULL
```

Rows are deleted when the broadcast reaches `sent`/`failed` (they are a working set, not a
record; the audit log already holds counts). Erasure: `email_lower` rows for an erased
member are removed by the existing broadcasts erasure cascade.

## 3. State transitions

### Contact marketing state

```
on ──(staff off / self off)──▶ off_by_staff | off_by_contact ──(staff on / self on)──▶ on
any ──(unsubscribe link)──▶ unsubscribed   (terminal for this feature; suppression row)
unsubscribed ──(staff on)──▶ REFUSED 409 suppressed
```

Audit: `contact_marketing_opted_out` / `contact_marketing_opted_in` with `source`; the
existing `broadcast_unsubscribed` + `broadcast_suppression_applied` gain `contact_id`.

### Member primary contact

- Non-archived, non-erased: exactly one live primary at every commit (trigger + policy).
- Archive: rule suspended (unchanged). Unarchive: refused unless a live primary exists or
  is designated in the same tx (`no_primary_contact` 409 with designatable contact ids).
- Erase: zero primaries by design; excluded from every recipient path.

### Broadcast (PR-C addition)

`approved → dispatching(audience_building: pushed n/N) → sending → sent`; an
`audience_building` broadcast is resumed by the next `dispatch-scheduled` tick and
reconciled by `reconcile-stuck-sending` if no progress for 30 min.

## 4. Permissions

| Key | admin | manager | marketing | super_admin | sensitive |
|---|---|---|---|---|---|
| `contacts.read` (existing, now enforced) | ✓ | ✓ | ✓ | ✓ | — |
| `contacts.marketing` (new) | ✓ | ✗ | ✓ | ✓ | pii |

Surfaces: page `/admin/marketing/audience` → `contacts.read`; `POST
/api/admin/contacts/[contactId]/marketing` → `contacts.marketing`; `GET
/api/admin/broadcasts/recipient-count` → `broadcasts.write`; portal
`PATCH /api/portal/profile/marketing` → member session (own contact only).

## 5. Feature flag

`FEATURE_CONTACT_MARKETING_RECIPIENTS` — zod `booleanFromString.default(false)` in
`src/lib/env.ts`, read only in `broadcasts-deps.ts`, mapped to
`ResolveSegmentDeps.audienceMode`. Deleted (with the `primary_only` leg) in the follow-up
PR after one clean week of sends.
