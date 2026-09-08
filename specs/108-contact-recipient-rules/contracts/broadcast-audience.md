# Contract — Broadcast audience resolution (Tier B)

`resolveSegmentRecipients` remains the single source of truth for "who receives this
broadcast", used by submit (estimate), the recipient-count endpoints, dispatch, split and
batch crons. Any other recipient query is a defect.

## 1. Inputs / outputs

```ts
interface ResolveSegmentDeps {
  tenant: TenantContext;
  membersBridge: MembersBridgePort;          // + getContactsBySegment, countOptedOutContactsBySegment, filterMarketingOptedOut
  eventAttendees: EventAttendeesRepository;
  marketingUnsubscribes: MarketingUnsubscribesRepo;   // lookupBatch, chunked ≤5,000
  audienceMode: 'primary_only' | 'all_contacts';      // from FEATURE_CONTACT_MARKETING_RECIPIENTS
  audienceCeiling: number;                            // audienceCeiling(isF71aUs1Enabled() && contactMarketingRecipients) — review H-2: 50,000 needs BOTH flags
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

`audienceCeiling(batchingEnabled)` = 5,000 | 50,000, where the argument is
`isF71aUs1Enabled() && FEATURE_CONTACT_MARKETING_RECIPIENTS` (review H-2: the wide ceiling
belongs to the wide audience; with the 1:N flag OFF the ceiling is 5,000 whatever the batching
flag says — prod has batching ON). Read at one composition site; submit, count and dispatch
compare against the same number.

**Amended 2026-09-08 (T095): that is the CONFIGURED ceiling, and it is no longer what is
enforced.** The composition root exposes both and clamps:

```
configuredAudienceCeiling()  = audienceCeiling(isF71aUs1Enabled() && contactMarketingRecipients)
currentAudienceCeiling()     = min(configuredAudienceCeiling(), DELIVERABLE_RECIPIENTS_PER_TICK)
DELIVERABLE_RECIPIENTS_PER_TICK = 500
```

The six single-tick callers read `currentAudienceCeiling()` — both count routes, submit,
`dispatch-scheduled` and the two compose pages — so what compose shows is what the send obeys and
FR-042 is unchanged. **The two batch cron routes deliberately read `configuredAudienceCeiling()`
instead**: `split-large-broadcasts` selects rows with
`estimated_recipient_count > SPLIT_THRESHOLD_RECIPIENTS` and `dispatch-batches` dispatches
manifests of an audience that was split *because* it exceeds one tick, so a per-tick clamp would
refuse every row they can pick up — silently, since that refusal is not counted by
`dispatchResolveFailedTotal`. The clamp exists because the configured ceiling
exceeded what a dispatch tick can push: the serial per-contact loop runs at a measured
~2.08 req/s (`min(10 req/s account limit, 1 / 0.481 s round trip)`), i.e. ~623 in a 300 s budget,
and Resend's Free plan independently caps usable contacts near 987. `configuredAudienceCeiling()`
stays separately exported and separately pinned so the H-2 flag-expression guard survives the
clamp. **Consequence: nothing can reach `SPLIT_THRESHOLD_RECIPIENTS`, so the split path is
unreachable** — no capability is lost, because `dispatch-batches` runs the same serial push under
the same `maxDuration = 300`.
`split-large-broadcasts` threshold stays 10,000 (< ceiling when ON). DB CHECK
`broadcasts_estimated_recipient_cap (0..50000)` unchanged.

~~**Push-capacity gate (added 2026-09-08, T098 — the contract was silent on it).** … The band is
unreachable while `FEATURE_CONTACT_MARKETING_RECIPIENTS` is OFF (ceiling 5,000) … The req/s figure
is UNMEASURED.~~ **Superseded the same day by the clamp above.** Two things that paragraph got
wrong within hours of being written: the rate is measured now (~2.08 req/s achievable against a
10 req/s account limit), and the band it described starts near **623** — *below* the 5,000 ceiling
that was already enforced, so it was never gated on the flag. What remains true is the mechanism:
`split-large-broadcasts` skips `resolvedCount <= SPLIT_THRESHOLD_RECIPIENTS`, so everything at or
below 10,000 falls to `dispatch-scheduled`'s serial push inside `maxDuration = 300`. The clamp is
what makes "under the ceiling" sufficient for delivery again. History:
`quickstart.md` § Cutover 3b, `reviews/pr-c.md` row 33, `reviews/cutover.md` § 5 / § 5a.

## 4. Audience push (dispatch)

> **DEFERRED out of PR-C (2026-09-07)** — everything in this section (the Contacts Import
> API, `createContactImport` / `getContactImport`, `broadcasts.audience_import_id`,
> `audience_building`, the 30-minute stuck rule) ships in the follow-up PR with T110
> (tasks T086 / T087 / T106; spec AMENDMENT under User Story 5). What PR-C ships at
> dispatch is the bounded per-tick push of the resolved audience: a tick that cannot build
> it rejects, counts `broadcasts_dispatch_resolve_failed_total`, and the next tick retries
> (FR-044); nothing partial is ever pushed.

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
  `broadcasts.audience_import_id`; the broadcast enters `audience_building`.
- Each later tick polls `GET /contacts/imports/{id}`. Completion rule: `status = completed`
  AND `failed = 0` AND `created + updated + skipped = total` AND `total` equals the resolved
  count → stamp `audience_import_completed_at` and call `sendBroadcast`. Any `failed > 0`, a
  count mismatch, or no completion within 30 min → typed dispatch failure
  (`audience_import_failed` / `audience_import_stuck`) with audit + alert; never a partial send.
- Idempotency: `upsert` makes re-submitting the same CSV safe; a tick never submits a second
  import while `audience_import_id` is set.
- `reconcile-stuck-sending` treats `audience_building` past 30 min as stuck (existing runbook
  extended). Rate limit (10 req/s per team by default; V5 confirms the team's value) is
  irrelevant at 2–3 calls per broadcast.

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
