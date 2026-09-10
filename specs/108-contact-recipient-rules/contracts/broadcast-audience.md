# Contract — Broadcast audience resolution (Tier B)

`resolveSegmentRecipients` remains the single source of truth for "who receives this
broadcast", used by submit (estimate), the recipient-count endpoints and dispatch. Any other
recipient query is a defect. (It used to name the split and batch crons too; those were deleted
on 2026-09-08 — see § 3 and § 4.)

## 1. Inputs / outputs

```ts
interface ResolveSegmentDeps {
  tenant: TenantContext;
  membersBridge: MembersBridgePort;          // + getContactsBySegment, countOptedOutContactsBySegment, filterMarketingOptedOut
  eventAttendees: EventAttendeesRepository;
  marketingUnsubscribes: MarketingUnsubscribesRepo;   // lookupBatch, chunked ≤5,000
  audienceMode: 'primary_only' | 'all_contacts';      // from FEATURE_CONTACT_MARKETING_RECIPIENTS
  audienceCeiling: number;                            // audienceCeiling(isF7ImportAudienceEnabled() && contactMarketingRecipients) — 50,000 needs BOTH flags (§ 3)
}
interface ResolveSegmentInput {
  segment: RecipientSegment;
  phase: 'submit' | 'dispatch';              // required — labels audience_resolved_total and
                                             // marketing_opt_out_filter_count, so a compose-time
                                             // count cannot keep the dispatch-side alarm alive
  requestingMemberId: string | null;         // replaces requestingMemberPrimaryEmail
  customRecipients: ReadonlyArray<EmailLower> | null;
}
interface ResolveSegmentOutput {
  recipients: ReadonlyArray<EmailLower>;     // deduplicated, suppression- and opt-out-filtered
  estimatedCount: number;                    // === recipients.length
  orphans: ReadonlyArray<{ memberId: string; reason: 'no_primary_email' | 'no_eligible_contact' | 'all_opted_out' }>;
                                             // eligible members with zero eligible contacts (FR-029), WITH the reason
                                             // (review 2026-09-07): `all_opted_out` is a preference drop, not a
                                             // missing contact — it is never audited as one. The sender is never
                                             // their own orphan.
  droppedByPreference: number;               // opt-out drops on any kind — on the all_contacts leg INCLUDING the
                                             // opted-out contacts F3 excluded in SQL (counted via
                                             // `countOptedOutContactsBySegment`) — plus suppression drops on the
                                             // custom list and the attendee segment (FR-022a)
}
```

## 2. Pipeline (all_contacts mode)

1. Member-based segment → `membersBridge.getContactsBySegment(tenant, kind, params)`:
   pages of 5,000 (T081 raised it from 1,000: latency-bound, see research R8) ordered by `(member_id, contact_id)`, looped to exhaustion (cursor = `{ kind: 'after_member' | 'after_contact', … }` — review 2026-09-07; the `after_contact` bound is `member_id >= m AND (member_id > m OR contact_id > c)`, an index bound — round 2 perf HIGH-1; a `tier` segment with no codes is REFUSED by all three F3 reads — page, opted-out count AND the primary-only read (round 2, C1) — and refused before that at the persisted-row boundary, `recipientSegmentFromPersisted`, so a malformed row is a terminal `failed_to_dispatch`, never a retry); **a page
   failure propagates as `resolve.server_error`** (never `[]`).
   Eligibility: member `status='active' AND erased_at IS NULL AND halted=false` (+ tier);
   contact `removed_at IS NULL AND marketing_opt_out_at IS NULL`.
2. Event-attendee and custom segments → existing sources. (**Corrected 2026-09-07, staff
   review 🟡-2**: `filterMarketingOptedOut` does NOT run here. It runs at step 5b below —
   AFTER suppression, and for EVERY segment kind, not only these two — so an address on
   both lists counts once, as suppressed. The totals are identical either way; the ORDER
   documented here was not the code's, and the code's own docblock explains why it must be
   after.)
3. Self-exclusion: drop every candidate whose `memberId === requestingMemberId`
   (member-based segments only; custom list and attendee rows unaffected). (**Corrected
   2026-09-08, T098**: this said "unchanged rule" and it is not one. Pre-108 the filter
   compared *addresses* and ran on every segment kind, custom list included
   (`resolve-segment-recipients.ts:125-129` at `91505b8f2^`); keying it on member id
   necessarily exempts the two sources that are not member-keyed. The change is live on
   merge, behind no flag — a sender on their own custom list now receives their own send.)
4. Dedupe by `emailLower`.
5. Suppression: `lookupBatch` in chunks of 5,000; removed entries count toward
   `droppedByPreference` for custom/attendee sources.
6. Empty → `broadcast_empty_segment_blocked`. Above `audienceCeiling` →
   `broadcast_audience_too_large { count, cap }` — **never truncated**.

`primary_only` mode keeps today's behaviour except the `status = 'active'` predicate, which
applies in both modes (FR-021).

## 3. Ceiling

`audienceCeiling(wideAudienceEnabled)` = 5,000 | 50,000. Read at one composition site; submit,
count and dispatch compare against the same number.

**Amended 2026-09-08 — TWICE in one day. Read the second block; the first is history.**

*(History, so the reasoning is not lost: T095 measured the serial per-contact push at ~2.08 req/s
— `min(10 req/s account limit, 1 / 0.481 s round trip)` — i.e. ~623 contacts in a 300 s function,
against a configured ceiling of 5,000. Everything in between was accepted at submit and never
delivered. The first answer clamped the enforced ceiling to `min(configured, 500)` in every flag
state; the second, hours later, made 500 a batch size and split above it. Both are gone. What
survives from them is the MEASUREMENT, which still bounds the legacy push.)*

**The current answer: one Contacts-Import call, and the batch path is deleted.**

```
configuredAudienceCeiling() = audienceCeiling(isF7ImportAudienceEnabled() && contactMarketingRecipients)
currentAudienceCeiling()    = isF7ImportAudienceEnabled()
                                ? configuredAudienceCeiling()
                                : min(configuredAudienceCeiling(), DELIVERABLE_RECIPIENTS_PER_TICK)
DELIVERABLE_RECIPIENTS_PER_TICK = 500
```

Every caller — both count routes, submit, `dispatch-scheduled` and the two compose pages — reads
`currentAudienceCeiling()`. There is no second reader with a different bound, because there is no
second dispatch path: `split-large-broadcasts`, `dispatch-batches`, the batch manifests and their
admin surfaces were deleted on 2026-09-08 (`ca51f59a1`, −13,380 lines). FR-042 is therefore
simpler than it has been since PR-C: **one function, one number.**

The two flags gate the wide ceiling for different reasons and BOTH are required:

| flag | answers |
|---|---|
| `FEATURE_CONTACT_MARKETING_RECIPIENTS` | WHOSE addresses — the ceiling was raised for the 1:N audience (review H-2), so it moves with it |
| `FEATURE_F7_IMPORT_AUDIENCE` | whether 50,000 can be DELIVERED at all — the serial push could not finish it in any number of ticks a member would wait through |

`DELIVERABLE_RECIPIENTS_PER_TICK` still clamps when the import is OFF, because that state is the
legacy serial loop and the measurement above is still its real bound. With the import ON there is
no per-tick capacity to clamp against: one multipart call carries the whole audience in ~412 ms
regardless of size, so **headcount stops being an engineering constraint and becomes a Resend plan
limit** (Free: 1,000 contacts / 3 audiences; Pro: 5,000). That was the point of the change.

DB CHECK `broadcasts_estimated_recipient_cap (0..50000)` unchanged.

## 4. Audience push (dispatch)

> **SHIPPED 2026-09-08 (T086 / T087 / T106)** — this section was DEFERRED out of PR-C the
> day before and is now the live dispatch path, behind `FEATURE_F7_IMPORT_AUDIENCE`
> (default OFF). With the flag OFF the legacy per-tick serial push still runs, unchanged,
> and is the rollback position.
>
> **One departure from what this section originally specified: there is no
> `audience_building` status.** `cancelBroadcast` accepts only `submitted` / `approved`, so
> a broadcast parked in a new status could not be cancelled — the same defect the
> 2026-09-08 reliability review raised against the (now deleted) batch drift halt, where a
> runbook told staff to cancel something the code refuses to cancel. The row stays
> `approved` for the whole build and `audience_import_id IS NOT NULL` draws the same
> distinction, without an enum value, a transition-policy entry, every exhaustive switch,
> three locales of copy and an audit type. Recorded in migration `0298`.

- First dispatch tick resolves the audience, renders a CSV with a single `email` column
  (never `unsubscribed`), and submits ONE import: `POST /contacts/imports` (multipart:
  `file`, `column_map={"email":"email"}`, `on_conflict="upsert"`,
  **`segments=[{"id":"<audience id>"}]`** — an array of OBJECTS. This line said
  `segments=[<audience id>]` until T145 probed it (2026-09-08) and Resend answered
  **422** `validation_error`: *"The `segments` must be an array of objects with a UUID
  `id` field."* The same probe settled the open question underneath: with the object
  form the imported contacts DO land in the target audience (`GET /audiences/{id}/contacts`
  → 1 of 1). Two earlier probes had concluded the opposite, but both sent `audience_id`,
  which Resend **accepts and silently ignores** — see `research.md` § R9 V4)
  through two new port methods `createContactImport` / `getContactImport` on
  `BroadcastsGatewayPort`, implemented with a raw multipart `fetch` in the existing gateway
  adapter (SDK 4.8 has no `contacts.imports`). The returned id is stored in
  `broadcasts.audience_import_id` alongside `audience_import_submitted_at`; the row STAYS
  `approved` (see the note above — no `audience_building` status), so a member or admin can
  still cancel while the import is in flight.
- Each later tick polls `GET /contacts/imports/{id}`. Completion rule: `status = completed`
  AND `failed = 0` AND `created + updated + skipped = total` AND `total` equals the resolved
  count → stamp `audience_import_completed_at` and call `sendBroadcast`. Any `failed > 0`, a
  count mismatch, or no completion within 30 min → typed dispatch failure
  (`audience_import_failed` / `audience_import_stuck`) with audit + alert; never a partial send.
- Idempotency: `upsert` makes re-submitting the same CSV safe; a tick never submits a second
  import while `audience_import_id` is set.
- The 30-minute stuck rule is enforced in TWO places on purpose. `buildAudienceTick` turns
  such a row terminal, but only on a tick that reaches that broadcast; the
  `broadcasts_audience_import_stuck_count` gauge (T106, sampled by the gauges cron) counts them
  independently, so one the cron has stopped visiting is still visible. The gauge is also the
  only signal that distinguishes "this broadcast is unhappy" from "Resend's import pipeline has
  stopped answering". Alarm at ≥ 1 sustained 30 min.
- Rate limit (10 req/s per account, read from `ratelimit-policy` headers) is irrelevant here:
  2–3 calls per broadcast regardless of audience size. That is the whole point — the serial
  push needed one call per contact.
- **Measured, 2026-09-08** (research § R9 V2 + V4): `POST /contacts/imports` answers 201 in
  ~412 ms and completes in ~306 ms, size-independent; `on_conflict=upsert` PRESERVES a
  contact's `unsubscribed` flag when the CSV carries no such column, which is the only reason
  `upsert` is lawful here (GDPR Art. 21 / PDPA § 32); and Resend's suppression is account-wide,
  so an unsubscribe carries into each new ephemeral audience. **`status: completed` does NOT
  mean the rows landed** — one import in five identical probes returned `completed` with
  `failed: 0` and `total: 0` and attached nothing. The completion rule above is load-bearing,
  not defensive.

## 5. Recipient-count endpoints

| Route | Guard | Query | 200 body |
|---|---|---|---|
| `GET /api/broadcasts/recipient-count` | `requireMemberContext` (portal compose) | `segment=all_members\|tier\|event_attendees_last_90d`, `tier=<code>[,<code>]` | `{ count, ceiling, exceeds: boolean, droppedByPreference: number }` |
| `GET /api/admin/broadcasts/recipient-count` | `requireApiPermission('broadcasts.write')` | same + `member_id=<uuid>` (proxied member) | same `+ orphans: number` |

- Response body (review 2026-09-07, round 2 C8): `count`, `ceiling`, `exceeds` and `droppedByPreference`
  on EVERY answer — the resolver runs its whole pipeline before it refuses, so an empty or over-ceiling
  audience carries the same MEASURED number the ok answer does (a tier where everyone objected reads
  `count 0, droppedByPreference N`; round 1's "absent means not computed" was false — it was computed);
  `orphans` is sent to STAFF only (`/api/admin/...`) — it is a fact about other members a member could
  otherwise probe tier by tier. A tier code over 64 characters is a 400 `invalid_query`, never a
  silently narrower audience. The staff route answers 503 `count_unavailable` (not 404, no probe audit)
  when the member lookup FAILS (`repo.unexpected`). `broadcasts_recipient_count_ms` carries an
  `outcome` label (`ok` | `unavailable`).
- Custom lists are counted client-side after validation (the existing flow) and reported
  with `droppedByPreference` from `POST /api/broadcasts/submit`'s response.
- Rate limit 30 / min per `(tenant, user)`, atomic `check` before the resolve. Errors: 429
  with `Retry-After`; 503 `count_unavailable` when resolution fails (client shows "count
  unavailable", never a stale number).
- Never returns addresses or member ids.
- Admin route: a `member_id` that does not belong to the caller's tenant (or does not exist) →
  404 with the non-disclosure body and a `member_cross_tenant_probe` audit row, exactly like the
  member routes (Constitution I.4).

## 6. Submit / dispatch changes

- `POST /api/broadcasts/submit` (and the admin proxy-submit) 200 body gains `recipientPreferenceExcluded: number` — camelCase like its siblings (`estimatedRecipientCount`); the route answers 200, not 201. Both compose forms render it in the success toast as a count (`…toast.preferenceExcluded`), never as addresses.
- `estimated_recipient_count` is written from `estimatedCount` (unchanged) and now equals
  the dispatched count for the same tenant state (SC-004).
- Orphan audit `broadcast_member_missing_primary_contact_email` is emitted only for members
  with **zero eligible contacts** (FR-029); cap 50 + truncation row unchanged.

## 7. Unsubscribe

`POST /api/broadcasts/unsubscribe` (existing) resolves `contactId` via
`lookupContactEmailInTenant` and writes `marketing_unsubscribes.contact_id`; audit payloads
gain `contact_id`. Suppression remains email-keyed and authoritative.

## 8. Tests

> **PARTLY DEFERRED (2026-09-07, staff review 🟡-2 — § 4 carried this banner and § 8 did
> not).** Every artefact below that belongs to the Contacts-Import build —
> `audience-import-two-tick.test.ts`, `build-audience-tick.test.ts`,
> `resend-contact-import.test.ts` — ships with T086/T087/T106 in the follow-up PR, not in
> PR-C. Do not hunt for them here.

- Unit: `resolve-segment-recipients.test.ts` (17 existing cases re-targeted to the
  `ContactRecipient` shape + new: 1:N fan-out, opt-out exclusion, all-contacts self-exclusion,
  page-failure propagation, ceiling by flag, `primary_only` leg parity).
- Integration (live Neon): `audience-cap.test.ts` re-pinned; new `audience-1n-status.test.ts`
  (inactive/archived excluded, secondaries included, orphan detection),
  `audience-pagination-20k.test.ts` (20,000 contacts, no truncation, < 3 s),
  `audience-import-two-tick.test.ts` (submit once, poll, send only on completed + matching counts), `unsubscribe-contact-attribution.test.ts`.
- Contract: `get-broadcasts-recipient-count.contract.test.ts` (member + admin), submit body.
- E2E: compose shows the live count and the self-exclusion hint; count updates on segment change.
