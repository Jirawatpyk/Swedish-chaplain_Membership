# Contract — Broadcast audience resolution (Tier B)

`resolveSegmentRecipients` remains the single source of truth for "who receives this
broadcast", used by submit (estimate), the recipient-count endpoints, dispatch, split and
batch crons. Any other recipient query is a defect.

## 1. Inputs / outputs

```ts
interface ResolveSegmentDeps {
  tenant: TenantContext;
  membersBridge: MembersBridgePort;          // + getContactsBySegment, filterMarketingOptedOut
  eventAttendees: EventAttendeesRepository;
  marketingUnsubscribes: MarketingUnsubscribesRepo;   // lookupBatch, chunked ≤5,000
  audienceMode: 'primary_only' | 'all_contacts';      // from FEATURE_CONTACT_MARKETING_RECIPIENTS
  audienceCeiling: number;                            // audienceCeiling(isF71aUs1Enabled())
}
interface ResolveSegmentInput {
  segment: RecipientSegment;
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
   pages of 5,000 (T081 raised it from 1,000: latency-bound, see research R8) ordered by `(member_id, contact_id)`, looped to exhaustion (cursor = `{ kind: 'after_member' | 'after_contact', … }` — review 2026-09-07; a `tier` segment with no codes is REFUSED by F3, never read as everyone); **a page
   failure propagates as `resolve.server_error`** (never `[]`).
   Eligibility: member `status='active' AND erased_at IS NULL AND halted=false` (+ tier);
   contact `removed_at IS NULL AND marketing_opt_out_at IS NULL`.
2. Event-attendee and custom segments → existing sources, then
   `membersBridge.filterMarketingOptedOut(tenant, emails)` removes opted-out contacts and
   counts them in `droppedByPreference`.
3. Self-exclusion: drop every candidate whose `memberId === requestingMemberId`
   (member-based segments only; custom list unaffected — unchanged rule).
4. Dedupe by `emailLower`.
5. Suppression: `lookupBatch` in chunks of 5,000; removed entries count toward
   `droppedByPreference` for custom/attendee sources.
6. Empty → `broadcast_empty_segment_blocked`. Above `audienceCeiling` →
   `broadcast_audience_too_large { count, cap }` — **never truncated**.

`primary_only` mode keeps today's behaviour except the `status = 'active'` predicate, which
applies in both modes (FR-021).

## 3. Ceiling

`audienceCeiling(batchingEnabled)` = 5,000 (flag OFF) | 50,000 (flag ON). Read at one
composition site; submit, count and dispatch compare against the same number.
`split-large-broadcasts` threshold stays 10,000 (< ceiling when ON). DB CHECK
`broadcasts_estimated_recipient_cap (0..50000)` unchanged.

## 4. Audience push (dispatch)

- First dispatch tick resolves the audience, renders a CSV with a single `email` column
  (never `unsubscribed`), and submits ONE import: `POST /contacts/imports` (multipart:
  `file`, `column_map={"email":"email"}`, `on_conflict="upsert"`, `segments=[<audience id>]`)
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
| `GET /api/broadcasts/recipient-count` | `requireMemberContext` (portal compose) | `segment=all_members\|tier\|event_attendees_last_90d`, `tier=<code>[,<code>]` | `{ count, ceiling, exceeds: boolean, orphans: number, droppedByPreference: number }` |
| `GET /api/admin/broadcasts/recipient-count` | `requireApiPermission('broadcasts.write')` | same + `member_id=<uuid>` (proxied member) | same |

- Response body (review 2026-09-07): `{ count, ceiling, exceeds }` on every answer; `droppedByPreference`
  is present only when the resolver COMPLETED (a refusal — `exceeds: true` or an empty audience — never
  fabricates a 0); `orphans` is sent to STAFF only (`/api/admin/...`) — it is a fact about other members
  a member could otherwise probe tier by tier. A tier code over 64 characters is a 400 `invalid_query`,
  never a silently narrower audience. The staff route answers 503 `count_unavailable` (not 404, no probe
  audit) when the member lookup FAILS (`repo.unexpected`).
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

- Unit: `resolve-segment-recipients.test.ts` (17 existing cases re-targeted to the
  `ContactRecipient` shape + new: 1:N fan-out, opt-out exclusion, all-contacts self-exclusion,
  page-failure propagation, ceiling by flag, `primary_only` leg parity).
- Integration (live Neon): `audience-cap.test.ts` re-pinned; new `audience-1n-status.test.ts`
  (inactive/archived excluded, secondaries included, orphan detection),
  `audience-pagination-20k.test.ts` (20,000 contacts, no truncation, < 3 s),
  `audience-import-two-tick.test.ts` (submit once, poll, send only on completed + matching counts), `unsubscribe-contact-attribution.test.ts`.
- Contract: `get-broadcasts-recipient-count.contract.test.ts` (member + admin), submit body.
- E2E: compose shows the live count and the self-exclusion hint; count updates on segment change.
