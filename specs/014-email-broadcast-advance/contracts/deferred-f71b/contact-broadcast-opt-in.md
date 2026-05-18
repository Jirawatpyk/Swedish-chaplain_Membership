# Contract: Per-Contact Broadcast Opt-In (US3)

**Spec FRs**: FR-016..022 · **Clarifications**: round-2 Q5 · **Use-cases**: `toggleContactBroadcastOptIn`, `extendUnsubscribeToOptInFlag`

This contract documents the F3 `contacts.receive_broadcasts` boolean column and the server actions that mutate it. The flag uniformly gates ALL contacts (primary + secondary) per Clarifications round-2 Q5. Created post-plan per audit finding H6.

---

## 1. Server actions

### 1.1 `toggleContactBroadcastOptIn({ contactId, receiveBroadcasts })` — member portal toggle

**Route**: `POST /api/member/contacts/:contactId/broadcast-opt-in`
**Auth**: member role + tenant ctx + **member-owner-of-contact** check (the authenticated member must own the member-record that the contact belongs to).
**Input** (zod):
```typescript
const Input = z.object({
  contactId: z.string().uuid(),
  receiveBroadcasts: z.boolean(),
});
```
**Output**: `Promise<Result<{ contactId: string; receiveBroadcasts: boolean; updatedAt: Date }, ContactError>>`.
**Pipeline**:
1. Load contact via `runInTenant(ctx, () => contactsRepo.findById(contactId))` — RLS enforces tenant isolation; cross-tenant lookups return null
2. Verify the contact belongs to a member-record owned by the authenticated member (cross-member-within-tenant guard — a member cannot toggle another member's contacts)
3. UPDATE `contacts.receive_broadcasts = $1`, `updated_at = now()`
4. Emit audit event `contact_broadcast_opt_in_toggled` carrying `{ actor_member_id, contact_id, member_id (parent), before_value, after_value }`
5. Return updated state
**Audit event**: `contact_broadcast_opt_in_toggled` (INFO, 5y retention; pattern matches FR-020).
**RBAC**: member role required; cross-member-within-tenant check enforced at use-case boundary (not just RLS — RLS sees the contact as visible because same tenant; the cross-member check is application-layer).
**Tenant invariant**: cross-tenant probe test (`tests/integration/broadcasts/contact-opt-in-cross-tenant-probe.test.ts`) asserts tenant B cannot toggle tenant A's contact even with a valid contactId (RLS hides the row → 404).
**Cross-member invariant**: contract test asserts member B cannot toggle member A's contact within the same tenant — returns `403 CONTACT_NOT_OWNED_BY_MEMBER` + emits a `cross_member_probe` audit signal.

### 1.2 `adminViewContactOptInState({ memberId })` — admin member-detail page

**Invocation**: Server component data fetcher on `/admin/members/:id/contacts`.
**Auth**: admin role + tenant ctx.
**Output**: array of `{ contactId, contactName, contactEmail, isPrimary, receiveBroadcasts, lastToggledAt? }` for visualisation per FR-021.
**No mutation** — admin reads only; admins cannot toggle on behalf of members (FR-020 says member-managed; admin role does not bypass member ownership of their own contact preferences — preserves Art. 7 consent withdrawability invariant).
**No audit event** — admin VIEWING the state is not a privileged read worth auditing (compare to PII access which IS audited per Principle I sub-clause 4 because PII detection summary contains regulated personal data; opt-in state is preference data, not regulated PII).

### 1.3 `extendUnsubscribeToOptInFlag({ contactEmail, broadcastId })` — invoked from F7 MVP unsubscribe route

**Invocation**: Inside the existing F7 MVP `processUnsubscribe` use-case, EXTENDED in F7.1 per FR-019.
**Auth**: Signed token (existing F7 MVP unsubscribe-token verification — no member auth required, recipient holds the signed link).
**Behavior**: After the F7 MVP path of (a) adding the email to `marketing_unsubscribes` AND (b) flipping the contact's `receive_broadcasts` to FALSE in the same transaction (defence in depth per FR-019). Both surfaces hold the invariant — a re-toggle of `receive_broadcasts=true` by member or admin does NOT auto-clear the `marketing_unsubscribes` entry (the recipient explicitly unsubscribed; only the recipient can un-unsubscribe via portal).
**Audit events**: existing F7 MVP `broadcast_unsubscribed` event (extended with `contact_opt_in_flag_flipped: true` payload field).
**Concurrency**: runs within the existing F7 MVP unsubscribe transaction; the dual-write (marketing_unsubscribes INSERT + contacts.receive_broadcasts UPDATE) is atomic per Principle VIII transactional boundary.

### 1.4 `resolveSegmentRecipientsWithOptIn({ segmentKind, ... })` — invoked during dispatch

**Invocation**: Inside the existing F7 MVP `resolveSegmentRecipients` use-case, EXTENDED in F7.1 per FR-017.
**Behavior**: For member-based segments (`all_members`, `tier:<code>`, US6 saved segments), the resolver now filters contacts by `receive_broadcasts=true` instead of "primary contact only". Resolver output remains a deduplicated email list. Members with ZERO contacts carrying `receive_broadcasts=true` are EXCLUDED from the resolved list AND emit a `member_no_broadcast_recipients` audit signal (FR-017 / data-model § 7 row #9) so the chamber can backfill outreach via other channels.
**Audit event**: extends existing F7 MVP `broadcast_segment_resolved` event with `contacts_included_count` (vs prior `primary_contacts_included_count`); also emits `member_no_broadcast_recipients` per excluded member (batched into one audit row per resolve carrying the array of excluded member ids).

---

## 2. Error taxonomy

| Code | When | HTTP status |
|------|------|-------------|
| `CONTACT_NOT_FOUND` | contactId invalid OR RLS hides (cross-tenant) | 404 |
| `CONTACT_NOT_OWNED_BY_MEMBER` | Member B attempts to toggle Member A's contact within same tenant | 403 + audit `cross_member_probe` |
| `RECEIVE_BROADCASTS_INVALID` | Boolean coercion failure (caller bug — should never reach prod due to zod) | 400 |
| `CROSS_TENANT_PROBE` | Tenant ctx mismatch (RLS surfaces this as null lookup → 404, but cross-tenant attempted UPDATE caught at use-case boundary) | 403 + audit `broadcast_cross_tenant_probe` |

---

## 3. UI surface

- **Member portal contact-management** — `/portal/contacts` — each contact row shows a "Receive chamber broadcasts" toggle (FR-020). Toggle uses `<input type="switch">` (or shadcn Switch with `role="switch"` + `aria-checked`). Toggle state surfaces last-changed timestamp inline (e.g., "Last updated: 2 days ago").
- **Admin member-detail contacts table** — `/admin/members/:id/contacts` — adds a "Receive broadcasts" column with icon badge (✅ ON / ⛔ OFF) per FR-021. Admin sees state at a glance but cannot toggle (consent-withdrawability invariant — only member can toggle their own contact preferences).
- **Compose recipient-count preview** (extends F7 MVP segment picker) — when segment selected, preview surfaces `{ included: N, excluded_no_opt_in: M }` so member sees how many contacts opted out of broadcasts. Helps explain "why is my segment count smaller than the tenant's member count?" UX question.

WCAG verification: toggle has `aria-label` localized to "Receive chamber broadcasts for {{contactName}}"; admin column has `<th scope="col">` header; admin badge has both icon + `aria-label` text (icon-only fails WCAG 1.1.1).

---

## 4. F7.1 ship-time migration backfill (cross-reference to migration 0135)

Migration `0135_f71_contacts_receive_broadcasts.sql` executes the F7.1 ship-time backfill in a single transaction:

```sql
BEGIN;

-- Add column with default FALSE (NOT NULL)
ALTER TABLE contacts ADD COLUMN receive_broadcasts BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: every existing PRIMARY contact gets receive_broadcasts=TRUE per Clarifications round-2 Q5
-- (preserves F7 MVP behavior — no broadcasts go missing on ship day)
UPDATE contacts SET receive_broadcasts = TRUE WHERE is_primary = TRUE;

-- Existing secondary contacts stay at FALSE (default) — preserves no-surprise invariant
-- (F7 MVP never sent to them; flipping them ON would be an unsolicited broadcast wave)

-- Integrity check: every pre-migration primary contact has receive_broadcasts=TRUE
DO $$
DECLARE
  unbackfilled_primary_count INT;
BEGIN
  SELECT COUNT(*) INTO unbackfilled_primary_count
    FROM contacts
    WHERE is_primary = TRUE AND receive_broadcasts = FALSE;
  IF unbackfilled_primary_count > 0 THEN
    RAISE EXCEPTION 'F7.1 migration 0135: % primary contacts failed to backfill', unbackfilled_primary_count;
  END IF;
END $$;

COMMIT;
```

The integrity check inside the transaction ensures the backfill is atomic — either every primary contact has `receive_broadcasts=TRUE` post-migration OR the migration aborts and rolls back. Post-deploy verification via `pnpm tsx scripts/verify-f71-contacts-backfill.ts` re-confirms the invariant from outside the migration as defence in depth.

---

## 5. Contract test outline (`tests/contract/broadcasts/toggle-contact-opt-in.test.ts`)

```typescript
describe('toggleContactBroadcastOptIn', () => {
  // Happy paths
  it('member toggles their own contact ON → updates column + emits audit', async () => { /* ... */ });
  it('member toggles their own contact OFF → updates column + emits audit', async () => { /* ... */ });
  it('idempotent: toggling to current state is a no-op + emits audit with no-change flag', async () => { /* ... */ });

  // Cross-member-within-tenant guards
  it('member B cannot toggle member A contact (same tenant) → 403 CONTACT_NOT_OWNED_BY_MEMBER', async () => { /* ... */ });
  it('cross-member-within-tenant attempt emits cross_member_probe audit', async () => { /* ... */ });

  // Cross-tenant guards (covered also in integration probe — duplicated here for contract-level coverage)
  it('tenant B cannot toggle tenant A contact → 404 CONTACT_NOT_FOUND (RLS)', async () => { /* ... */ });

  // Resolver-level integration sanity
  it('toggling primary contact OFF removes them from member-based segment resolution', async () => { /* ... */ });
  it('toggling secondary contact ON includes them in member-based segment resolution', async () => { /* ... */ });
  it('member with all contacts opted OFF emits member_no_broadcast_recipients audit on resolve', async () => { /* ... */ });

  // Unsubscribe cross-write (FR-019)
  it('one-click unsubscribe via email link flips receive_broadcasts=false AND adds to marketing_unsubscribes', async () => { /* ... */ });
  it('toggling receive_broadcasts=true after unsubscribe does NOT auto-clear marketing_unsubscribes', async () => { /* ... */ });
});
```

---

## 6. Privacy invariants

- **`receive_broadcasts` flag scope**: governs **marketing broadcasts only**. Transactional email (F1 sign-in, F1 password reset, F4 invoices, F5 payment receipts, F8 renewal reminders) is **unaffected** by the flag — the chamber's legal obligation to send those transactional messages overrides the marketing opt-out per PDPA §24 / GDPR Art. 6(1)(b) contractual necessity. UX copy in the member portal toggle MUST clarify this (e.g., "You will still receive invoices, receipts, and account notifications. This setting controls only chamber newsletters and announcements.")
- **GDPR Art. 21 right-to-object compliance**: member or contact can unilaterally toggle OFF via portal OR via email-link unsubscribe; chamber admin CANNOT toggle ON on behalf of contact (consent withdrawability invariant).
- **F7.1 ship-time backfill basis**: existing primary contacts backfilled to TRUE under GDPR Art. 6(1)(f) legitimate interest — chamber's existing relationship + prior chamber-broadcast-receiving practice is the lawful basis (member can opt OUT immediately post-ship). Documented in DPIA addendum per plan.md Principle I.
- **No audit on view, audit on mutate** — admin viewing the opt-in state (use-case 1.2) emits no audit event; mutations (use-cases 1.1, 1.3) DO emit. Rationale: opt-in state is preference data (not regulated PII like Thai national ID); the SOC2-style "access logging required" rule applies to regulated PII per Principle I sub-clause 4, not generic preference data.
