# Members directory — portal-status badge, column overlap fix, needs-invite chip

**Date**: 2026-07-23 (revised same day after a 3-agent review — UX, architecture, testing)
**Surface**: `/admin/members` (staff members directory)
**Schema changes**: none — no migration, no new audit event type
**Feature flag**: none (read-only enrichment plus one bulk-action extension)

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
`whitespace-normal` + `max-w`, which is the fix pattern this design adopts.

**1b — no portal visibility.** Staff cannot tell from the directory which
members have a working portal login. The information exists on the member detail
page (`Portal linked` / pending / expired / bounced badges) but the directory is
silent, so answering "who still needs inviting?" means opening members one by
one.

## 2. Decisions

| # | Decision | Rejected alternative | Why |
| --- | --- | --- | --- |
| D1 | Portal state is derived from the **primary contact only** | Aggregate across all contacts (`2/3 linked`) | The Contact column already shows the primary contact's name; the badge sits beside that name and means "this person". Aggregating needs an extra per-member COUNT and reads ambiguously. |
| D2 | **Four** states: `active` / `invited` / `invite_expired` / `not_invited` | Two states (linked / not linked) | Two states cannot separate "never invited" (press Invite) from "invited, waiting" (leave alone) from "invitation died" (re-send). The detail page already splits these, so a two-state table would contradict it. |
| D3 | Fix overlap by **wrapping**, column widths unchanged | (a) widen Plan/Status; (b) ellipsis + tooltip | (a) only moves the cliff and pushes the table past 1190px; (b) hides the plan name behind a hover and can clip the `Lapsed` badge, which is a warning that must never be truncated. |
| D4 | Do **not** change the shared `TableCell` primitive | Global `overflow-hidden` / `whitespace-normal` | Every table in the app inherits that primitive; a global change is a far larger regression surface than the bug. |
| D5 | Filter is a **single toggle chip** ("needs invite"), not a 5-option dropdown | `Select` with all/active/invited/expired/not-invited | Portal onboarding is work with an end state. A dropdown sits in the filter bar forever returning zero rows; the chip hides itself at count 0 and returns when a new member creates work. The count is also more useful than the filter — it answers the question without a click. |
| D6 | The chip counts `not_invited` + `invite_expired` | Also count `invited` | `invited` is not actionable — the invitation was just sent and has up to 7 days to be accepted. Including it means the counter never reaches zero during a rollout and nudges staff into re-sending yesterday's invitations. |
| D7 | The chip's count is scoped to the **currently active filters** | Always count tenant-wide | The number is a promise about what clicking will show. It must move with Plan/Status/search. |
| D8 | **One** `now`, resolved at the page and threaded into every consumer | Each layer reads its own clock / SQL `NOW()` | Badge (app-derived) and filter/count (SQL-derived) must agree on expiry to the same instant, and tests must pin time. |
| D9 | Bulk "Send portal invite" is **extended to re-send** to `invite_expired` members | Narrow the chip to `not_invited` only | The chip must not promise work the bulk action refuses. `invitePortal` returns `already_linked` for an expired-but-pending contact, so today those 12 members would be silently skipped. `resendBouncedInvite` already handles exactly this case (Cluster 3, 2026-07-12: the bounce-flag requirement was removed so an expired-unaccepted invite can be re-sent), so the extension reuses a proven path rather than writing a new one. |

## 3. Design

### 3.1 Domain — `derivePortalState`

New pure function in `src/modules/members/domain/` (no framework imports).

```ts
export type PortalState = 'active' | 'invited' | 'invite_expired' | 'not_invited';

derivePortalState(input: {
  linkedUserId: string | null;
  /** The FRESHEST unconsumed invitation for that user, or null. See 3.2. */
  pendingInvitation: { expiresAt: Date } | null;
  now: Date;
}): PortalState
```

Rules, in order:

1. `linkedUserId === null` → `not_invited`
2. `pendingInvitation === null` → `active`
3. `pendingInvitation.expiresAt <= now` → `invite_expired`
4. otherwise → `invited`

The `<=` boundary matches the detail page's existing inline expiry test
(`[memberId]/page.tsx:270-276`). Because that page keeps its own copy for now, a
unit test pins the two to the same verdict (see §4) so they cannot drift.

Rule 1 is safe against pruned users: `contacts.linked_user_id` carries a real FK
to `users` with **`ON DELETE SET NULL`** (`0009_members_contacts.sql:137-142`),
so the nightly prune-expired-invitations cron nulls the column rather than
leaving a dangling id. (The Drizzle schema declares the column without the
reference, so read the migration, not `schema-contacts.ts`, when reasoning about
this.)

### 3.2 Infrastructure — batch read

New port method on `MemberRepo` + Drizzle adapter:

```ts
findPendingInvitationsForPrimaryContacts(
  ctx: TenantContext,
  memberIds: readonly MemberId[],
): Promise<Result<ReadonlyArray<{ memberId: MemberId; expiresAt: Date }>, RepoError>>
```

Batch equivalent of `findPendingInvitationsForMember`
(`drizzle-member-repo.ts:1402-1450`), narrowed to primary contacts. **Port the
whole of that method's logic, not just its WHERE.** It carries two guards that
are load-bearing and easy to lose in a rewrite:

1. **Active-user anti-join.** `reissueInvitation` mints a new invitation row
   without invalidating the old one, so a user who redeemed one token keeps a
   stale unconsumed row forever. The existing method excludes any contact whose
   linked user has EVER consumed an invitation:
   `NOT EXISTS (SELECT 1 FROM invitations ci WHERE ci.user_id = <contact's user> AND ci.consumed_at IS NOT NULL)`.
   Without it, an active portal user is reported as `invited`/`invite_expired`
   and — once the stale row expires — sits in the needs-invite chip permanently.
   This is the regression Cluster 3 closed on 2026-07-12.
2. **Freshest-wins de-duplication.** One contact can hold several unconsumed
   invitations. The existing method uses `DISTINCT ON (contact_id)` with
   `ORDER BY contact_id, expires_at DESC`. The batch variant needs the
   member-keyed equivalent: `DISTINCT ON (c.member_id)` +
   `ORDER BY c.member_id, i.expires_at DESC`. Without it the map is
   last-write-wins over an unordered result and `invited` vs `invite_expired`
   becomes non-deterministic.

Two further constraints:

- **Tenant boundary comes from `contacts`.** `invitations` is cross-tenant by
  design and has no RLS; the join must be `contacts.tenant_id = <ctx tenant>`
  and `invitations.user_id = contacts.linked_user_id`. Never query `invitations`
  standalone.
- **Column allow-list.** `0017_invitations_revoke_tighten.sql:25-27` grants
  `chamber_app` `SELECT (user_id, consumed_at, expires_at)` only. Postgres
  checks column privileges for **any** reference, including in a `WHERE`, so the
  predicate must not name `id` or `created_at`. The design's predicate stays
  inside the allow-list.
- **No `LIMIT`.** The single-member method ends in `.limit(50)`, which is safe
  for one member's contacts but would silently truncate a 50-member page. Omit
  it; the result is bounded by the page size by construction.

Implement in `drizzle-member-repo.ts` itself — the deep import of the auth
schema (`:43`) and its security-contract comment (`:33-42`) already live there;
a second file would be a second unguarded deep import.

Index coverage: `invitations_user_id_idx` (`0000:81`) plus
`contacts_one_primary_per_member` — a partial unique index on
`(tenant_id, member_id) WHERE is_primary AND removed_at IS NULL`
(`0009:89`) that matches the predicate exactly.

### 3.3 Application — `loadMembersPortalStatus`

New use case in `src/modules/members/application/use-cases/`, mirroring
`loadMembersMembershipStatus` which the same page already uses.

```ts
loadMembersPortalStatus(deps, input: {
  members: readonly { memberId: string; linkedUserId: string | null }[];
  now: Date;                       // D8 — supplied by the caller, never read here
}): Promise<Result<ReadonlyMap<string, PortalState>, never>>
```

- Callers pass a **page-bounded** list (directory `PAGE_SIZE` = 50).
- Short-circuits with no DB round-trip when the list is empty **or** when every
  `linkedUserId` is null.
- A member absent from the returned map means "no primary contact" — never
  "load failed". Failure is represented by the caller's degrade path (§3.4),
  which yields `'unknown'`, not an empty map.

### 3.4 Page wiring — `src/app/(staff)/admin/members/page.tsx`

`row.primaryContact` is a full `Contact`, so `linkedUserId` is already in hand
(read today at `page.tsx:368`). No extra query for the linked/not-linked half.

Placement matters — the page has **two** parallel rounds separated by early
returns:

| Read | Goes in | Why |
| --- | --- | --- |
| `countMembersNeedingPortalInvite` | the **first** `Promise.all` (`:256`, beside `directorySearchWithCount`) | It does not depend on the search result, and the two early returns at `:293` (search failed) and `:302` (zero rows) fire **before** the second round. The zero-rows branch is exactly where §3.6 requires the chip to still render. |
| `loadMembersPortalStatus` | the **second** `Promise.all` (`:320`) | Needs `memberIds` + `linkedUserId` from the result. |

The chip count must be passed to `<DirectoryFilters>` in **all three** return
branches (error, empty, normal).

Both new reads are **best-effort**, wrapped like
`loadMembersMembershipStatusSafe`, but their degraded values must not be
mistaken for real answers (see D5 — an absent chip means "no work left"):

- portal status read throws → every row gets `'unknown'`, which renders nothing
  but is distinct from `not_invited`.
- count read throws → `null` (not `0`) → the chip renders in a disabled
  "unavailable" state rather than vanishing or claiming zero.

`hasFilters` (`page.tsx:218-224`) **must include** `?portal=needs_invite`.
Without it, filtering to zero rows renders `MembersZeroState` — the "no members
yet, add your first member" onboarding screen — to a tenant with 131 members.
`?portal=` is parsed through an allow-list (like `parseDirectorySort`); an
unrecognised value is ignored and does **not** count as a filter.

A new branch precedes the existing empty-state fork: chip active + zero rows →
`MembersAllInvitedEmptyState`.

`MembersTableRow` gains `readonly portal_state: PortalState | 'unknown' | null`
(`null` = no primary contact).

### 3.5 Table rendering — `src/components/members/members-table.tsx`

> **AS-BUILT (revised during implementation, 2026-07-23):** this section
> originally specified a two-line STACK — name on top, badge row beneath. At the
> user's request the badges were changed to flow INLINE right after the contact
> name (`flex flex-wrap items-center`), wrapping to a new line only when the
> 175px column is too narrow, so the common "name + one short badge" case stays a
> single line and rows stay compact. The skeleton was correspondingly kept at one
> shimmer line (see the skeleton note below), which accepts a minor CLS on the
> minority of rows that wrap rather than reserving two lines for every row. The
> prose below is left as originally written for provenance.

**Contact cell** (`:572`) becomes name on top and a badge row beneath
(`flex flex-wrap items-center gap-1` — `Badge` is `shrink-0`, so without
`flex-wrap` the row overflows instead of wrapping).

| State | Presentation |
| --- | --- |
| `active` | `Badge variant="secondary"` + check icon |
| `invited` | `Badge variant="outline"` + `MailWarning`, `border-warning/40 text-warning` |
| `invite_expired` | `Badge variant="outline"` + `MailWarning`, `border-destructive/40 text-destructive` |
| `not_invited` | `Badge variant="outline"`, no icon, muted |
| `'unknown'` / `null` | nothing |

**Copy must be table-specific, not reused from the detail page.** `Badge` is
`h-5 … overflow-hidden whitespace-nowrap shrink-0` (`badge.tsx:8`), so a badge
never wraps and never shrinks — parent wrapping cannot save it. The Contact
column's usable width is 175px minus 2× `--table-cell-padding-x` ≈ **151px**,
while the detail page's Swedish string `"Inbjudan har gått ut"` alone measures
~150px. Reusing detail-page copy would therefore re-create the very overflow
this change fixes, in Swedish and Thai first.

Use short labels plus an `sr-only` full phrase — the pattern this same file
already uses for `membershipLapsed` / `membershipLapsedSr` (`:643-644`). New
keys under `admin.members.directory.portal.*`:

| key | EN | TH | SV |
| --- | --- | --- | --- |
| `linked` | Portal | พอร์ทัล | Portal |
| `invited` | Invited | เชิญแล้ว | Inbjuden |
| `expired` | Expired | หมดอายุ | Utgången |
| `notInvited` | Not invited | ยังไม่เชิญ | Ej inbjuden |

plus `*Sr` variants carrying the full sentence. The table shows **no countdown**
("expires in 5 days" stays on the detail page) — which is also why §3.3's return
type carries no `expiresAt`.

`active` uses `variant="secondary"`, not `default`: `default` is the solid
primary token, which would make the most common and least actionable state the
loudest thing in a 50-row page, and it is the same token as the detail page's
**Primary contact** badge (`[memberId]/page.tsx:344`) sitting two cells away.

**Bounce-badge suppression.** The detail page hides "Invite bounced" when the
invitation has also expired, because both signal one root cause with one
recovery (`[memberId]/page.tsx:415-417`, logged as an a11y double-badge
finding). The table must copy that rule, and extend it: suppress the bounce
badge when `portal_state` is `invite_expired` **or** `active` (a bounce recorded
before a successful activation is meaningless). Without this, an expired +
bounced row shows two red `MailWarning` badges saying the same thing inside
151px.

**Plan cell** (`:554`): keep `{name} · {year}` on one line but swap
`whitespace-nowrap` for `whitespace-normal break-words`. Only long plan names
wrap; short ones keep today's density. Splitting the year onto its own line
unconditionally would add a second line to **every** row (every member has a
plan year) and grow the page by ~1,200px for no gain.

**Status cell** (`:609`): wrapper becomes `flex flex-col items-start gap-1` so
the Lapsed/Suspended badge drops below the status control. The badge stays a
*sibling* of the `InlineStatusCell` button — moving it inside would fire the
status toggle on click and pollute the accessible name (`:612-614`).

Portal badges are suppressed on `archived` rows, matching the existing Lapsed
rule (`:635`).

`break-words` covers the single-long-token case, which is why no
`overflow-hidden` is added: it would clip the inline-edit button's focus ring,
trading a layout bug for an a11y bug.

**Skeleton.** `members-table-skeleton.tsx` must gain the second-line block in
the Contact cell so the shimmer height matches the real rows; otherwise every
row jumps on hydration (`loading.tsx` and the `Suspense` fallback at `:383`
share it). CLS must stay 0 per ux-standards § 2.1.

> **AS-BUILT (2026-07-23):** superseded by the inline badge layout (see the §3.5
> AS-BUILT note). With the badge inline, the common row is a single line again, so
> the skeleton was kept at ONE shimmer line to track the majority of rows.
> Rows that wrap (a long plan name, a stacked Lapsed/Suspended status badge, or a
> multi-badge Contact cell) settle one line taller — a smaller aggregate CLS than
> reserving two lines for every row, but NOT the strict CLS-0 this paragraph
> originally required. Flagged for enterprise-ux sign-off at PR review.

**Live region.** Toggling the chip changes the table from 131 rows to 12 with no
announcement (the only live region today is `selectedCount`, `:786`). Add a
`role="status"` line — "Showing 12 of 131 members" — and reuse it for every
filter change, not just the chip.

### 3.6 Needs-invite chip — `src/components/members/directory-filters.tsx`

A toggle button in the existing `FilterBar`, after the risk `Select`, before
Clear.

- **Toggle semantics**: `aria-pressed`, pressed state signalled by a variant
  change (not colour alone), accessible name carries the count ("Needs portal
  invite, 12 members").
- **Toggles via `pushUrl`** (`:92-113`), never by setting the param directly —
  `pushUrl` strips `cursor`/`page` and uses `scroll: false`. Setting `?portal=`
  by hand from page 3 would land on page 3 of a one-page result: an empty table
  with no explanation.
- **Visibility**: rendered when `count > 0` **or** the filter is active **or**
  the count is unavailable (degraded). If it vanished the moment the last member
  was invited while the filter was on, the table would silently expand back to
  everyone.
- **Focus**: turning the filter off at count 0 unmounts the chip that was just
  clicked, dropping focus to `<body>` — the failure class recorded in
  `reference_dialog_focus_lost_after_unmount`, which axe never catches. Keep the
  chip mounted for the remainder of that render (a "was visible this page"
  flag), or move focus to the search input before navigating.
- **`hasAnyFilter`** (`:123-127`) must include `portal`; otherwise the Clear
  button never renders when the chip is the only active filter, and the
  `clearAll()` fix below is unreachable.
- **`clearAll()`** (`:131`) must add `portal: null`.
- **Count arrives as a prop** from the server page — no client fetch, no
  flicker.
- **Empty state** `MembersAllInvitedEmptyState` (new, in `empty-states.tsx`):
  `role="status"`, an `<h2>`, a `MailCheck` icon to match its three siblings,
  and a CTA that clears **only** `portal` — not `router.replace(pathname)` like
  `MembersFilteredEmptyState`, which would also throw away the user's Plan
  filter.

### 3.7 Filter + count SQL

`DirectoryFilter` (`member-repo.ts:20-35`) and `DirectoryOffsetFilter`
(`:44-62`) are **two independent declarations** — the second does not extend the
first. The page uses only the offset path (`directorySearchWithCount`,
`page.tsx:257`). Adding the field to just one type leaves the chip a silent
no-op with no TypeScript error, because the field is optional and a cast spans
the boundary in `directory-search.ts`. **Add it to both:**

```ts
readonly portalNeedsInvite?: { readonly now: Date };
```

Modelled as an object rather than a `boolean` + separate `now?: Date` so the
compiler enforces D8's invariant instead of a prose note.

**Shared WHERE builder.** `buildDirectoryConds` (`drizzle-member-repo.ts:198`)
covers only the scalar filters; `isNull(members.erasedAt)`, the status OR-set
and `directoryQFilter(q)` are assembled inline and deliberately duplicated in
both callers (`:885-893`, `:966-974`). `countMembersNeedingPortalInvite` would
be a **third** hand-assembly of the same clause — and omitting
`isNull(erasedAt)` alone would make the chip count GDPR-erased tombstones,
breaking D7 in the most alarming possible way. Extract
`buildDirectoryWhere(filter)` (erased + status + q + scalar conds) and route all
three callers through it; drop the now-obsolete "byte-identical" comment.

The predicate (raw `sql` template — fully qualified on both sides, which is what
avoids the name-resolution trap documented at `:250-257`; do **not** rebuild it
with the query builder unless every table is `alias()`-ed):

```sql
EXISTS (
  SELECT 1 FROM contacts c
   WHERE c.tenant_id = members.tenant_id
     AND c.member_id = members.member_id
     AND c.is_primary = true
     AND c.removed_at IS NULL
     AND (
           c.linked_user_id IS NULL                        -- not_invited
        OR (                                               -- invite_expired
              EXISTS (SELECT 1 FROM invitations i
                       WHERE i.user_id = c.linked_user_id
                         AND i.consumed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM invitations i2     -- …none still live
                           WHERE i2.user_id = c.linked_user_id
                             AND i2.consumed_at IS NULL
                             AND i2.expires_at > $now)
          AND NOT EXISTS (SELECT 1 FROM invitations ci     -- …and never redeemed
                           WHERE ci.user_id = c.linked_user_id
                             AND ci.consumed_at IS NOT NULL)
        )
     )
)
AND members.status <> 'archived'
```

Five properties this must preserve:

1. **`is_primary = true AND removed_at IS NULL`** — without it the filter
   matches on a *secondary* contact's state and returns rows whose visible badge
   says something else.
2. **Freshest-wins, not any-expired.** A member re-invited yesterday holds a
   live invitation *and* an old expired one. A bare `EXISTS (… expires_at <= now)`
   would badge them `invited` while listing them as needing an invite. The
   `NOT EXISTS (… expires_at > now)` clause is what makes the SQL agree with
   §3.2's `DISTINCT ON … ORDER BY expires_at DESC`.
3. **Never-redeemed anti-join** — the SQL twin of §3.2's guard 1.
4. **Members with no primary contact match nothing** — they cannot be invited.
5. **Archived excluded explicitly.** D7's "archived is excluded automatically"
   holds only while the status filter defaults; a user can select
   `?status=archived` directly (`page.tsx:196-203`), and the bulk action skips
   archived members unconditionally, so the chip would be counting work that is
   impossible to do.

`$now` is bound from the page's `now` (D8).

`countMembersNeedingPortalInvite(ctx, filter)` is `COUNT(*)` over
`buildDirectoryWhere(filter)` + this predicate, with `limit`/`offset`/`cursor`
ignored.

### 3.8 Bulk action extension (D9)

`bulkSendPortalInvite` (`bulk-send-portal-invite.ts`) currently maps
`invitePortal`'s `already_linked` straight to `skipped`. Every `invite_expired`
member the chip surfaces lands there — the user selects 12 rows, presses Send,
and is told "12 skipped" with no route forward except opening each member.

Change: on `already_linked`, fall through to `resendBouncedInvite` for that
member's primary contact.

- `resendBouncedInvite` already covers this case without a bounce flag (its
  Cluster 3 LAPSED trigger) and mints a fresh token via the owner-role
  `ReissueInvitationPort`.
- If the linked user is **not** pending (i.e. genuinely active), the port
  returns `not_pending` → map back to `skipped: 'already_linked'`, preserving
  today's behaviour exactly.
- New outcome bucket `resent` (with `counts.resent`), kept separate from
  `invited` because no user is created — the API response gains a field and
  removes none, so existing consumers keep working.
- The route (`src/app/api/members/bulk/route.ts:201`) must pass the extra deps
  `resendBouncedInvite` needs (`reissueInvitation`, `userEmails`, `audit`,
  `clock`) from `buildMembersDeps`.
- **No new audit event type**: `resendBouncedInvite` emits the existing
  `member_portal_invite_queued`, so no DB enum migration.
- Bulk-result copy must name the three outcomes ("12 invited · 3 re-sent · 1
  skipped").

Per-member owner-role transactions are unchanged in shape — the loop already
runs one `createUser` tx per member; a re-send is the same cost.

### 3.9 Module barrel (Principle III)

`page.tsx` imports through `@/modules/members` and `members-table.tsx` lives in
`src/components/`, both outside the module. `PortalState`, `derivePortalState`
(if the client needs it), `loadMembersPortalStatus` and the count use case must
be exported from `src/modules/members/index.ts`, or ESLint
`no-restricted-imports` fails the build — a class of error `pnpm typecheck` does
not catch.

## 4. Testing

| Level | Coverage |
| --- | --- |
| Unit (domain) | `derivePortalState`: four states + the `expiresAt === now` boundary (the case that kills a `<` vs `<=` mutant). The blanket `src/modules/members/domain/**` threshold in `vitest.config.ts:190-195` pins 100% on **lines, branches, functions and statements** — not lines alone. |
| Unit (application) | The two short-circuits of `loadMembersPortalStatus` (empty list; all-null `linkedUserId`) with a spy repo asserting **zero** repo calls, plus the degrade wrappers: a throwing count read yields `null`, never `0`. Keeps the new file off the global branch budget and covers §3.4's degrade contract. |
| Unit (drift guard) | `derivePortalState` and the detail page's inline `expiresAt <= now` agree on a shared table of instants — the only thing preventing drift while the detail page keeps its own copy (§3.1). |
| Integration (live Neon) | Batch read: **re-issue shape** (a redeemed user holding a stale unconsumed row → must be `active`, not `invited`), **multi-invitation shape** (live + expired for one contact → `invited`), secondary-contact isolation, member with no primary contact, a full 50-member page (guards the dropped `LIMIT`), and **cross-tenant isolation** (Review-Gate blocker). Seed shapes already exist at `tests/integration/members/find-pending-invitations.test.ts:229-262`. |
| Integration (live Neon) | **Grant enforcement**: `runInTenant(ctx, tx => tx.select({ id: invitations.id }).from(invitations))` must reject with `42501`. Asserting the adapter's happy path proves nothing — the harness seeds through the owner-role `db` singleton, which can read `id` freely; only `runInTenant` sets `ROLE chamber_app`. |
| Integration (live Neon) | **Count/filter agreement** under a compound fixture: needs-invite members that are (a) archived, (b) erased, (c) excluded by `q`, (d) excluded by `planId` — assert `countMembersNeedingPortalInvite === searchDirectoryWithCount({…, portalNeedsInvite}).total`. This is the test that catches the third-WHERE drift; "rows returned == total" alone is near-tautological because both come from one `whereClause` (`:966`). |
| Integration (live Neon) | Bulk extension: an `invite_expired` member is **re-sent** (lands in `resent`); an `active` member still lands in `skipped: already_linked`. |
| Component | Behavioural only: each state renders its label; bounce badge suppressed when expired/active; chip exposes `aria-pressed` and an accessible name containing the count; a `null` count renders the unavailable state, not a zero. No assertions on class names, `variant` values, or icon component names — this repo has been burned by tests coupled to source literals. |
| E2E | **Overflow regression, with its own fixture.** The directory E2E specs are explicitly written to tolerate an empty table (`tests/e2e/members-directory-search.spec.ts:11-13`) and there is no members seed helper, so "assert every `<td>`" would iterate nothing and pass. Seed a throwaway tenant with a 40+ char plan name, a long contact name, and a lapsed member, then assert **content bleed** on the Plan and Status cells: `content.getBoundingClientRect().right <= td.getBoundingClientRect().right + 1`, plus that the wrap actually happened. Do not use per-`<td>` `scrollWidth <= clientWidth`: `<td>` is `overflow: visible` (so the value is browser-dependent), chromium has already produced a spurious 210-vs-209 in this repo (`tests/e2e/invoices/event-fee-as-paid.spec.ts:470-484`), and untouched nowrap columns would fail it. Comparing adjacent `<td>` boxes is useless — under `table-fixed` the boxes never overlap, only their painted content does. |
| E2E | Chip round-trip: chip active → count reaches 0 → chip stays mounted → the all-invited empty state renders → Clear strips `portal` from the URL. This lives in E2E, not jsdom, because the bug it guards is URL/server-page behaviour. |
| E2E (`@i18n`) | The overflow assertion re-run under `sv` and `th`, where the badge labels and column headers are longest. |
| i18n | New `admin.members.directory.portal.*` keys present in en/th/sv (`pnpm check:i18n`). |

Run the two new integration files **by explicit path** — `tests/integration/members/`
is 82 files and dies around ~42 with "Worker exited".

## 5. Out of scope

- **Sorting by portal state** — needs `ORDER BY` plus cursor-encoding changes.
- **Portal state for non-primary contacts** — D1.
- **A full portal-state dropdown filter** — D5.
- **Changing the shared `TableCell` primitive** — D4.
- **Migrating the detail page onto `derivePortalState`** — follow-up; the drift
  guard test covers the gap meanwhile.
- **Registering the chip as a command-palette action** — a reasonable follow-up
  once the chip's copy settles.

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Filter matches on a secondary contact and contradicts the badge | `is_primary` clause (§3.7 property 1) + secondary-isolation integration test |
| Stale unconsumed invitation makes an active user look like they need inviting | Never-redeemed anti-join in **both** the batch read and the SQL predicate (§3.2 guard 1, §3.7 property 3) + re-issue-shape integration test |
| A re-invited member shows `invited` but also appears in the chip | Freshest-wins in both places (§3.2 guard 2, §3.7 property 2) |
| Chip counts work the bulk action refuses | D9 bulk extension + `resent` bucket + integration test |
| Chip silently counts erased or archived members | Shared `buildDirectoryWhere` + explicit `status <> 'archived'` + compound-fixture count test |
| A failed read reads as "no work left" | Degrade to `'unknown'` / `null`, never `not_invited` / `0` (§3.4) |
| `42501` from a non-granted `invitations` column | Predicate stays inside the 0017 grant; grant-enforcement test runs under `runInTenant` |
| Cross-tenant leak via the un-RLS'd `invitations` table | Boundary enforced through `contacts`; cross-tenant integration test is a Review-Gate blocker |
| **Cross-tenant state inference** — one user linked as a contact in tenants A and B; an invitation issued by B makes A's directory show `invited` and count them | Inherited from the existing single-member method, but this design promotes it from a badge to a *counter*. Accepted and documented; the cross-tenant test must cover this exact shape (one user, two tenants, one issuing tenant), not merely "other tenants' members don't appear". |
| Nested `EXISTS` slows the directory | `invitations_user_id_idx` + `contacts_one_primary_per_member` cover both levels. Note the count query runs on **every** directory load (it decides whether the chip renders), so it is a permanent hot-path addition, not a pay-per-click one — capture an `EXPLAIN` and a p95 measurement at implementation time. |
