# Members directory — portal-status badge, column overlap fix, needs-invite chip

**Date**: 2026-07-23
**Surface**: `/admin/members` (staff members directory)
**Schema changes**: none — no migration
**Feature flag**: none (read-only enrichment of an existing page)

## 1. Problem

Two independent complaints on the same screen.

**1a — columns overlap.** `TableCell` (`src/components/ui/table.tsx:108`) sets
`whitespace-nowrap` by default and carries no overflow guard. The members table
renders under `table-fixed` with an explicit `<colgroup>` pinning each column to
its `size` (`src/components/members/members-table.tsx:842`). Content wider than
its column therefore *overflows visibly into the neighbouring column* instead of
wrapping or clipping. Two cells are affected:

| Cell | Width | Content | Result |
| --- | --- | --- | --- |
| Plan (`members-table.tsx:554`) | 150px | `"Corporate Membership · 2026"` under `whitespace-nowrap` | bleeds into Contact |
| Status (`members-table.tsx:609`) | 130px | status control + pencil + `Lapsed`/`Suspended` badge in a horizontal `inline-flex` | bleeds into Engagement |

Company and Contact do *not* overlap because both already override to
`whitespace-normal` + `max-w`, which is the fix pattern this design adopts for
the other two.

**1b — no portal visibility.** Staff cannot tell from the directory which
members have a working portal login. The information exists on the member detail
page (`Portal linked` / pending-invitation / expired badges) but the directory
is silent, so answering "who still needs inviting?" means opening members one at
a time.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
| --- | --- | --- | --- |
| D1 | Portal state is derived from the **primary contact only** | Aggregate across all contacts (`2/3 linked`) | The Contact column already shows the primary contact's name; the badge sits next to that name and means "this person". Aggregating needs an extra per-member COUNT and reads ambiguously. TSCC treats the primary contact as the company's representative. |
| D2 | **Four** states: `active` / `invited` / `invite_expired` / `not_invited` | Two states (linked / not linked) | Two states cannot distinguish "never invited" (press Invite) from "invited, waiting" (leave alone) from "invitation died" (re-send) — three different actions. The detail page already splits these three, so a two-state table would contradict it. |
| D3 | Fix overlap by **wrapping to a second line**, column widths unchanged | (a) widen Plan/Status; (b) `text-ellipsis` + tooltip | (a) only moves the cliff — a longer plan name overflows again — and pushes the table past 1190px; (b) hides the plan name behind a hover and can clip the `Lapsed` badge, which is a *warning* signal that must never be truncated. |
| D4 | Do **not** change the shared `TableCell` primitive | Add `overflow-hidden` / `whitespace-normal` globally | Every table in the app (invoices, payments, broadcasts, users) inherits that primitive; a global change is a regression surface far larger than the bug being fixed. Fix at the three member cells instead. |
| D5 | Filter is a **single toggle chip** ("needs invite"), not a 5-option dropdown | `Select` with all/active/invited/expired/not-invited | Inviting members to the portal is work with an end state. Once everyone is invited, a dropdown sits in the filter bar forever returning zero rows, whereas the chip hides itself at count 0 and reappears when a new member or a new primary contact creates work. The count on the chip is also more useful than the filter itself — it answers the question without a click. |
| D6 | The chip counts `not_invited` + `invite_expired` **only** | Also count `invited` (i.e. "everyone without portal access") | `invited` is not actionable — the invitation was just sent and has up to 7 days to be accepted. Including it means the counter never reaches zero during a rollout and nudges staff to re-send invitations they sent yesterday. Members in `invited` remain visible via their table badge. |
| D7 | The chip's count is scoped to the **currently active filters** | Always count tenant-wide | The number is a promise about what clicking will show. If Plan=Gold is active and 3 of the 12 pending members are Gold, the chip must read 3. Side benefit: archived members are excluded automatically, because the default status filter already excludes them. |
| D8 | `now` is supplied by the app clock, not SQL `NOW()` | `NOW()` inside the predicate | The badge (derived in the app) and the filter/count (derived in SQL) must agree on expiry to the same instant, and tests must be able to pin time. |

## 3. Design

### 3.1 Domain — `derivePortalState`

New pure function in `src/modules/members/domain/` (no framework imports;
Constitution requires 100% line coverage on domain).

```ts
export type PortalState = 'active' | 'invited' | 'invite_expired' | 'not_invited';

derivePortalState(input: {
  linkedUserId: string | null;
  pendingInvitation: { expiresAt: Date } | null;  // unconsumed invitation, if any
  now: Date;
}): PortalState
```

Rules, in order:

1. `linkedUserId === null` → `not_invited`
2. `pendingInvitation === null` → `active` (a linked user with no unconsumed
   invitation has accepted it)
3. `pendingInvitation.expiresAt <= now` → `invite_expired`
4. otherwise → `invited`

The `<=` boundary matches the detail page's existing inline expiry test
(`[memberId]/page.tsx:270-276`, `expired = expiresAt <= now`) so the two surfaces
can never disagree about a borderline invitation. Migrating the detail page onto
this helper is a nice-to-have follow-up, not part of this change.

### 3.2 Infrastructure — batch read

New port method on `MemberRepo` + Drizzle adapter:

```ts
findPendingInvitationsForPrimaryContacts(
  ctx: TenantContext,
  memberIds: readonly MemberId[],
): Promise<Result<ReadonlyArray<{
  memberId: MemberId;
  expiresAt: Date;
}>, RepoError>>
```

Batch equivalent of the existing single-member
`findPendingInvitationsForMember` (`member-repo.ts:362`), narrowed to primary
contacts. Two constraints inherited from that method and its migration-0017
grants:

- **Tenant boundary comes from `contacts`.** The auth `invitations` table is
  cross-tenant by design; the join must be `contacts.tenant_id = <ctx tenant>`
  and `invitations.user_id = contacts.linked_user_id`. Never query `invitations`
  standalone.
- **Column allow-list.** `chamber_app` may read only `user_id`, `consumed_at`,
  `expires_at`. Touching `invitations.id` (the raw invite token) or `created_at`
  raises Postgres `42501`. The return shape deliberately projects neither.

"Pending" means `consumed_at IS NULL` — live *or* expired-unaccepted, same as
the existing method. Empty `memberIds` short-circuits with no round-trip.

Index coverage: `invitations_user_id_idx` exists (migration 0000) and `contacts`
is indexed on `(tenant_id, member_id)`, so the nested `EXISTS` does not seq-scan.

### 3.3 Application — `loadMembersPortalStatus`

New use case in `src/modules/members/application/use-cases/`, mirroring
`loadMembersMembershipStatus` (`src/modules/renewals/.../load-members-membership-status.ts`)
which the same page already uses for the Lapsed/Suspended badges.

```ts
loadMembersPortalStatus(deps, input: {
  members: readonly { memberId: string; linkedUserId: string | null }[];
}): Promise<Result<ReadonlyMap<string, PortalState>, never>>
```

- Callers pass a **page-bounded** list (the directory's `PAGE_SIZE` = 50).
- Short-circuits with no DB round-trip when the list is empty **or** when every
  `linkedUserId` is null (everyone is `not_invited`).
- `now` from `deps.clock.now()` — one instant for the whole page.
- Returns `Result<…, never>`: no domain error exists, only an infrastructure
  throw, which the caller degrades on (see 3.4).

### 3.4 Page wiring — `src/app/(staff)/admin/members/page.tsx`

`row.primaryContact` is a full `Contact`, so `linkedUserId` is already in hand
(the page reads it today at `page.tsx:368` for the bounce badge). No extra query
for the linked/not-linked half of the state.

Add `loadMembersPortalStatus` and the chip count to the **existing**
`Promise.all` alongside `resolveMemberNumberPrefix` and
`loadMembersMembershipStatusSafe` (`page.tsx:320`) so both new reads run in
parallel with the current ones and add no serial latency.

Both new reads are **best-effort**, wrapped like
`loadMembersMembershipStatusSafe`: a throw logs and degrades to "no portal
badges / no chip", never a crashed directory.

`MembersTableRow` gains:

```ts
readonly portal_state: PortalState | null;  // null = member has no primary contact
```

### 3.5 Table rendering — `src/components/members/members-table.tsx`

**Contact cell** (`:572`) becomes two lines: name on top, a badge row beneath
holding the portal badge and the existing invite-bounce badge.

| State | Presentation |
| --- | --- |
| `active` | Badge, default variant, check icon — copy reused from `admin.members.detail.portal.linked` |
| `invited` | Badge, outline + amber, `MailWarning` icon — copy from `pendingInvitations.*` |
| `invite_expired` | Badge, outline + destructive, `MailWarning` icon — copy from `pendingInvitations.expired` |
| `not_invited` | Muted caption text, **not** a badge |
| `null` | nothing (cell already renders "no primary contact") |

`not_invited` is deliberately not a badge: rendering nothing at all is
indistinguishable from a failed load, but a full badge would compete visually
with the three states that carry an action. Every state pairs an icon and a text
label with its colour (WCAG 1.4.1 — no colour-only encoding), consistent with
how the existing Lapsed/Suspended badges are built.

**Plan cell** (`:554`): drop `whitespace-nowrap`; plan name on line one with
`whitespace-normal break-words`, plan year on line two as
`text-caption text-muted-foreground`. The `·` separator is removed.

**Status cell** (`:609`): the wrapper becomes `flex flex-col items-start gap-1`
so the Lapsed/Suspended badge drops below the status control instead of beside
it. The badge stays a *sibling* of the `InlineStatusCell` button — moving it
inside would fire the status toggle on click and pollute the button's
accessible name (an already-documented constraint at `:612-614`).

`break-words` covers the single-long-token case (a company or plan name with no
spaces), which is why no `overflow-hidden` is needed — and `overflow-hidden`
would clip the inline-edit button's focus ring, trading a layout bug for an a11y
bug.

Column widths are unchanged (total 1085px). Rows grow taller where content wraps;
`TableRow`'s `h-[var(--table-row-height)]` acts as a minimum, not a cap.

### 3.6 Needs-invite chip — `src/components/members/directory-filters.tsx`

A toggle button in the existing `FilterBar`, after the risk `Select` and before
the Clear button.

```
[ ⚠ Needs portal invite · 12 ]      ← not pressed
[ ⚠ Needs portal invite · 12 ]      ← pressed (variant change, aria-pressed=true)
```

Behaviour:

- **Toggle semantics**: `aria-pressed={active}`, click toggles
  `?portal=needs_invite` on/off. Pressed state is signalled by a variant change,
  not colour alone.
- **Accessible name includes the count** ("Needs portal invite, 12 members") so
  the number is not screen-reader-only decoration.
- **Visibility**: rendered when `count > 0` **or** when the filter is currently
  active. The second clause matters: if the chip vanished the moment the last
  member was invited while the filter was on, the table would silently expand
  back to everyone with nothing explaining why.
- **Zero-with-filter-active** renders a dedicated empty state ("everyone has been
  invited") with a button to clear the filter — not the generic filtered-empty
  state, which would read as "no results, try different filters". It joins the
  existing states in `src/components/members/empty-states.tsx`.
- **`clearAll()`** (`directory-filters.tsx:131`) must add `portal: null`;
  otherwise Clear leaves an invisible active filter.
- **Count is passed in as a prop** from the server page — no client fetch, no
  loading flicker, no CLS.

### 3.7 Filter + count SQL

Both the filter and the count use one predicate, added to
`buildDirectoryConds` (`drizzle-member-repo.ts:198`) — the single helper that
*both* `searchDirectory` (cursor) and `searchDirectoryWithCount` (offset+count)
call, so the two paths cannot drift. It is a `WHERE` predicate only: no join in
`FROM`, no change to the select list, `COUNT`, `ORDER BY`, or cursor encoding.

`DirectoryFilter` / `DirectoryFilterWithCount` gain:

```ts
readonly portalNeedsInvite?: boolean;
readonly now?: Date;   // required when portalNeedsInvite is set
```

Predicate (shape follows the existing `directoryQFilter` EXISTS at
`drizzle-member-repo.ts:239`):

```sql
EXISTS (
  SELECT 1 FROM contacts c
   WHERE c.tenant_id = members.tenant_id
     AND c.member_id = members.member_id
     AND c.is_primary = true
     AND c.removed_at IS NULL
     AND (
           c.linked_user_id IS NULL                       -- not_invited
        OR EXISTS (                                       -- invite_expired
             SELECT 1 FROM invitations i
              WHERE i.user_id = c.linked_user_id
                AND i.consumed_at IS NULL
                AND i.expires_at <= $now
           )
     )
)
```

Three properties this predicate must preserve:

1. **`is_primary = true AND removed_at IS NULL` is mandatory.** Without it the
   filter would match on a *secondary* contact's portal state and return rows
   whose visible badge says something else — the filter and the badge would
   contradict each other on screen.
2. **Members with no primary contact match nothing.** They cannot be invited (no
   email), so listing them under "needs invite" would be a dead end. The table
   already labels them "no primary contact".
3. **`$now` is bound from the app clock** (D8), not `NOW()`.

The chip count is `COUNT(*)` over the same `WHERE` (directory conditions +
this predicate), exposed as `countMembersNeedingPortalInvite(ctx, filter)` —
a repo method plus a thin use case called from the page's existing
`Promise.all`. It takes the *same* `DirectoryFilter` the search took, with
`portalNeedsInvite` forced on, which is what makes D7 hold by construction.

## 4. Testing

| Level | Coverage |
| --- | --- |
| Unit (domain) | `derivePortalState`: all four states + the `expiresAt === now` boundary. 100% line (Constitution). |
| Integration (live Neon) | `findPendingInvitationsForPrimaryContacts`: mixed states in one page; empty input performs no query; a secondary contact's invitation must **not** leak into the primary's state; **cross-tenant isolation** (Principle I — a Review-Gate blocker); a `SELECT` that touches a non-granted `invitations` column must fail loudly rather than silently (guards against `42501` reaching production). |
| Integration (live Neon) | **Filter/badge agreement**: with `?portal=needs_invite`, every returned row's derived `portal_state` is `not_invited` or `invite_expired`, and the row count equals the `total` reported by the count path — proving the cursor and count `WHERE` clauses have not drifted. |
| Component | Table renders each of the four states plus `null`; portal badge and bounce badge coexist; chip toggles `aria-pressed` and stays mounted at count 0 while active. |
| E2E | **Overflow regression**: for every `<td>` on the directory, assert `scrollWidth <= clientWidth` — the only level that can catch this class of bug, since jsdom has no layout. Plus an axe scan of the directory. |
| i18n | New keys present in `en`/`th`/`sv` (`pnpm check:i18n` gate). Copy is reused from the detail page's existing `portal.*` / `pendingInvitations.*` namespaces where possible. |

## 5. Out of scope

- **Sorting by portal state** — needs `ORDER BY` plus cursor-encoding changes,
  which is a different problem from a `WHERE` predicate. The chip covers the
  actual need.
- **Portal state for non-primary contacts** — D1.
- **A full portal-state dropdown filter** — D5. If the chip proves too coarse in
  daily use, it can be widened later without redoing the SQL.
- **Changing the shared `TableCell` primitive** — D4.
- **Migrating the detail page onto `derivePortalState`** — optional follow-up.

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Filter matches on a secondary contact and contradicts the badge | `is_primary` clause (3.7) + the filter/badge agreement integration test |
| `42501` from a non-granted `invitations` column reaching production | Adapter projects only `user_id`/`consumed_at`/`expires_at`; integration test asserts it |
| Cross-tenant leak via the cross-tenant `invitations` table | Tenant boundary enforced through `contacts`, never a standalone `invitations` query; cross-tenant integration test is a Review-Gate blocker |
| A new nested `EXISTS` slows the directory | `invitations_user_id_idx` (migration 0000) and `contacts (tenant_id, member_id)` cover both levels; the predicate applies only when the chip is active |
| Two extra reads slow page load | Both join the existing `Promise.all` and run in parallel; both are best-effort and degrade to "no badge / no chip" |
