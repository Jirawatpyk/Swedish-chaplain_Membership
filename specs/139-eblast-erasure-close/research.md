# Research: Resend Broadcasts provider facts (spec 139; inherited by spec 140)

Written 2026-10-30 from the current Resend docs and this repo's own measurements; every claim is labelled MEASURED, DOCUMENTED, UNKNOWN or ASSUMED. Spec 140 (the import-only dispatch leg with a lease) takes this as its provider premise and updates it in place.

**Line references** (`GW:`, `TICK:`, `RULE:`) were taken on the 139 branch and can drift; the `TICK:` ones are re-checked against `main` at `3e31cbdfa`. Search by the symbol named next to each.

**Provenance.** The brief itself was read-only research: the repo (worktree `f139`, branch `139-eblast-erasure-close-s1`, HEAD `64b34d8c8`), the Resend public docs (fetched 2026-10-30) and Context7 (`/resend/resend-node`, `/llmstxt/resend_llms-full_txt`). Two later additions touched the **production** Resend account (dev and prod share the key): the Q1 probe (2026-10-30; two broadcasts created, sent to `delivered@resend.dev` only, cancelled while queued, the probe segment deleted) and the read-only Resend MCP inspection in the Addendum. No other address received mail.

Labels used in every claim:
- **MEASURED (date, where)**: probed against the live Broadcasts account and recorded in the repo.
- **DOCUMENTED (url)**: stated on resend.com/docs as of 2026-10-30.
- **UNKNOWN**: neither.
- **ASSUMED**: what the repo's code relies on with neither measurement nor doc behind it.

Short paths: `GW` = `src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts`; `TICK` = `src/modules/broadcasts/application/use-cases/build-audience-tick.ts`; `RULE` = `.claude/rules/modules/broadcasts.md`; `S138` = `specs/138-f7-import-hold-abandon/spec.md`; `S139` = `specs/139-eblast-erasure-close/spec.md`; `P139` = `specs/139-eblast-erasure-close/plan.md`; `R108` = `specs/108-contact-recipient-rules/research.md`; `ROPA` = `docs/compliance/processing-records.md`.

---

## Summary

1. **The status vocabularies did not line up. Settled 2026-10-30.**
   - DOCUMENTED: `draft, scheduled, queued, sent, canceled`, with **one L** (manage-broadcasts).
   - MEASURED: `draft, scheduled, queued, sent, failed` (`RULE`), and `canceled` (one L) after a cancel on a queued broadcast (Q1, 2026-10-30).
   - Until PR #698 the repo's `normaliseStatus` mapped only `cancelled` (two L), so `canceled` read `unknown` and **three** arms could never fire: the erasure cascade's 403 + cancelled, the dispatch gate's 403 on a cancelled id, and the import leg's cancelled re-mint (`GW:1062-1066`). PR #698 maps both spellings to our `cancelled`.
   - Still open: `failed` is real but undocumented; `sending` is neither documented nor measured (Q2).
2. **Resend itself is the draft-vs-send mutex.**
   - `/send` works only on a `draft`: a second send gets 422, with or without a key (MEASURED 2026-10-29).
   - DELETE works only on `draft` or `scheduled`: `queued` and `sent` get 403 (MEASURED 2026-10-29).
   - The lease in spec 140 orders *our* side only. It cannot replace these provider rules, and it does not need to.
3. **Deleting an audience under a `queued` broadcast silently fails it.** The broadcast goes to `failed`, `sent_at` stays null and no mail goes out (MEASURED 2026-10-29). No webhook announces it. This is the one cross-tick hazard the lease must make impossible.
4. **`Idempotency-Key` protects nothing on the Broadcasts surface.**
   - It is DOCUMENTED only for Send Email, Batch and the Inbox sends.
   - It was MEASURED inert on `POST /broadcasts` (2026-09-09).
   - It changes nothing on `/send` (2026-10-29).
   - `POST /contacts/imports` takes no key (`GW:776-793`).
   - Safety rests on persisting ids before the next step, and on probing.
5. **No webhook marks broadcast or import completion.** The documented event list has no `broadcast.*` and no `import.*` events. Completion stays poll-based (`getContactImport`, `retrieveBroadcast`), so a lease cannot wait on a webhook.
6. **Import completion rule.**
   - DOCUMENTED import statuses: `queued | in_progress | completed | failed`.
   - MEASURED: `completed` with all-zero counts happens (1 in 5 probes, R9 V2(c)). So `total === resolvedCount` is load-bearing.
   - The repo also treats an undocumented `canceled` as terminal (`TICK:1548`), and gives up after 30 min (`IMPORT_STUCK_AFTER_MS`, `TICK:94`).
7. **The Free plan binds first.**
   - The 1,000-contact cap is DOCUMENTED, and MEASURED on the billing page.
   - 3 segments, one of them `General`, so at most two in flight. MEASURED from the billing page 2026-09-08 (`R108:476`); the docs give no segment limit.
   - Whether the 1,000 cap counts team-level ("global") contacts is UNKNOWN (`R108:431`).
8. **SDK.**
   - Was ranged `^4.0.1`, installed 4.8.0; **exact-pinned at 6.35.0 by spec 141** (2026-10-30). In 6.35 `audiences` is an alias of `segments`, so `audiences.*` and `contacts.list` hit `/segments…`; MEASURED equivalent to `/audiences` on 2026-10-30 (`specs/141-resend-sdk-6/spec.md` § Premises).
   - 4.8.0 declares no `signal`, but its `post`/`get` spread `options` into the fetch init (`node_modules/resend/dist/index.js:597-616`). A `signal` would therefore reach `fetch`. That is read from the source and not measured.
   - 6.x declares `RequestOptions { headers?, signal? }`. Neither version has a built-in timeout.
9. **Classifier gaps against the documented error codes** (`GW:111-164`).
   - Every 409 becomes `idempotency_conflict`, but 409 `resource_locked` exists ("another request is already updating this resource").
   - Every 429 becomes retryable, but `daily_quota_exceeded` and `monthly_quota_exceeded` are 429s that do not clear in 31 s.
   - `validation_error` is DOCUMENTED at 400, 401 and 403 (errors page, accessed 2026-10-30), and MEASURED at 422 on a refused `/send` and at 403 on a refused DELETE (2026-10-29). The state table must key on HTTP status, never on `name`.
10. **Stale repo sources.**
    - `specs/010-email-broadcast/research.md` §1 and §9: wrong plan numbers, wrong SDK method names, "no bulk endpoint".
    - `ROPA:262` said "Resend default (90 days)" with no source; corrected by PR #702 to the documented 30 days for email data, with broadcast-log retention not documented separately and not measured.

---

## Endpoint × state table

"Gateway method" is in `GW`. "Repo reading" is how the code classifies the answer.

| Call (gateway method) | Resource state | Provider answer | Label | Repo reading |
|---|---|---|---|---|
| `POST /audiences` (`createAudience` :217, SDK `audiences.create`) | fewer than 3 segments in use | 200 `{id}` | MEASURED (implicitly, every live send) | id returned |
| same | the segment limit (3) is reached | a 4xx, code unrecorded | MEASURED only as "4xx, permanent" (`R108:493`, go-live § 6.6); exact code UNKNOWN | `permanent` → `failed_to_dispatch` |
| same | any | Audiences API "deprecated and will be removed", no date | DOCUMENTED (migrating-from-audiences-to-segments) | still used (`R108:645`) |
| `POST /contacts/imports` (`createContactImport` :794, raw fetch, 30 s timeout :971) | live segment, `segments=[{id}]` | 201 `{id}` in ~412 ms | MEASURED 2026-09-08 (`R108:453`) | id stored |
| same | `segments=[id]` (strings) | 422 validation_error | MEASURED 2026-09-08 | `permanent` |
| same | `audience_id=` field | 201, field **silently ignored**; contacts land in global contacts only | MEASURED 2026-09-08 | the trap is pinned by a unit test |
| same | deleted segment | 404 "Segment not found" | MEASURED 2026-10-29 (`S138:35`) | `permanent` (no resourceId; `TICK` treats it as permanent, no loop, `S138:70`) |
| same | the CSV pushes past the 1,000-contact cap | UNKNOWN, for the import (the serial push answered 4xx, `R108:483`) | UNKNOWN | `permanent` assumed |
| same | a retry after a lost response | creates a second job (no key accepted) | ASSUMED from the docs' lack of key support; `GW:776-793` | accepted residual |
| same | the file | ≤200 MB; `on_conflict` upsert (default) / skip | DOCUMENTED (create-contact-import) | upsert |
| `GET /contacts/imports/{id}` (`getContactImport` :866) | in flight | `queued` / `in_progress` | DOCUMENTED (list-contact-imports) | polled until 30 min (`TICK:1597`) |
| same | done | `completed` + counts `{total,created,updated,skipped,failed}`, `completed_at` | DOCUMENTED; MEASURED ~306 ms for 1 row | `completed_at` is not read |
| same | done, nothing attached | `completed`, all counts 0 | MEASURED 2026-09-08, 1 in 5 (`R108` V2(c)) | caught by `total === resolvedCount` |
| same | `failed` | DOCUMENTED | — | terminal `provider_failed` (`TICK:1548`) |
| same | `canceled` | **not a documented import status** | ASSUMED | terminal |
| same | the segment was deleted after completion | still `completed` | MEASURED 2026-10-29 (`S138:34`) | — |
| same | the segment was deleted **before** completion | UNKNOWN | UNKNOWN | — |
| same | job purged / retention | UNKNOWN (no doc) | UNKNOWN | 404 → `resource_missing` type `import` (`GW:942-962`) |
| `POST /broadcasts` (`createBroadcast` :312, SDK sends `audience_id`) | live segment | 200 `{id}`, status `draft` | MEASURED 2026-09-10 (`GW:1051`) | id; persisted before `/send` |
| same | deleted segment | 404 "Audience not found" | MEASURED 2026-10-29 | `permanent` + `not_found`, read as "audience missing" at its one call site (`S138:69-71`) |
| same | identical replay, same `Idempotency-Key` | **two** resources | MEASURED 2026-09-09 (memory `reference_resend_idempotency_key_is_inert`) | never relied on |
| same | the param name | docs now say `segment_id`; `audience_id` still works | DOCUMENTED (create-broadcast) / MEASURED working 2026-10-29 | SDK 4.8 field |
| same | `send: true` (create and send in one call) | DOCUMENTED | — | **not usable**: it removes persist-id-before-send |
| `GET /broadcasts/{id}` (`retrieveBroadcast` :477 retried; `retrieveBroadcastOnce` :521, 10 s) | draft | `draft` | MEASURED 2026-09-10 | `draft` |
| same | `/send` accepted | `queued` for ≥15 s, then `sent` by 45 s | MEASURED 2026-10-29 | `queued` / `sent` = handed |
| same | mid-delivery | `sending` | **UNKNOWN**: not documented, never observed | mapped (`GW:1057`) |
| same | scheduled | `scheduled` | MEASURED; DOCUMENTED | → `unknown`, refused (`GW:1075`) |
| same | the queued broadcast's audience was deleted | `failed`, `sent_at` null | MEASURED 2026-10-29; **not documented** | → `unknown`, refused |
| same | a queued broadcast was cancelled | `canceled` (one L) | DOCUMENTED (manage-broadcasts, cancel-broadcast); **MEASURED 2026-10-30 (Q1)** | `normaliseStatus` maps `canceled` → `cancelled` since PR #698 |
| same | deleted | 404 | MEASURED 2026-10-29 | `not_found`; the import leg re-probes after 3 s (`S138:65`) |
| same | can a 404 be stale (for example right after create)? | UNKNOWN | UNKNOWN | the two-not-found rule exists for this (D-038, D-040) |
| `POST /broadcasts/{id}/send` (`sendBroadcast` :361 via `sdk.post`, key sent) | draft | 200 `{id}` | MEASURED 2026-10-29 | — |
| same | anything but draft (queued / sent / any key / no key) | 422 validation_error "Only draft broadcasts can be sent or scheduled"; one email | MEASURED 2026-10-29 (`S138:39`); DOCUMENTED "must be in a draft state to be sent" (send-broadcast, via Context7 llms-full) | `permanent` → probed (`_probe-refused-send.ts`) |
| same | deleted | 404 | MEASURED (`S139:25`) | `resource_missing` → re-read (`S138:57`) |
| same | the key | not a documented key endpoint | DOCUMENTED (idempotency-keys) | the key is sent but inert |
| `DELETE /broadcasts/{id}` (`deleteBroadcast` :695 retried, 404/410 = ok; `deleteBroadcastOnce` :727, 10 s, typed) | draft | 200 | MEASURED 2026-09-10 and 2026-10-30 (P139 Verify S1) | `deleted` |
| same | scheduled | 200; a later GET → 404 | MEASURED 2026-10-29; DOCUMENTED (delete-broadcast; also "cancels the scheduled delivery") | — |
| same | queued, or sent | 403 validation_error "Only draft or scheduled broadcasts can be deleted"; the send completes | MEASURED 2026-10-29 | `forbidden` → probed under the lock (D-040) |
| same | sending | assumed 403 | **inferred** from the message (`S138:96`) | — |
| same | canceled | 403 "Only draft or scheduled broadcasts can be deleted" | MEASURED 2026-10-30 (Q1) | spec 139: 403 + probe `cancelled` → cancel the row |
| same | the docs | the manage page says "Only draft (including scheduled) Broadcasts can be deleted. Once a Broadcast has been sent or queued, it can't be deleted"; the API page agrees, and so does the measurement | DOCUMENTED (both pages, accessed 2026-10-30), consistent | — |
| same | a key restricted to sending | **401** `restricted_api_key` ("restricted to only send emails"); 403 `restricted_api_key` means "API key is not active", 403 `invalid_permission` an OAuth token missing scopes | DOCUMENTED (errors page, accessed 2026-10-30) | a 403 is still probed before it is believed: it is not proof of `queued` / `sent` |
| `POST /broadcasts/{id}/cancel` (no gateway method) | scheduled | → `draft` | DOCUMENTED; RoPA says MEASURED 2026-10-29 (`ROPA:255`, no probe file cited) | — |
| same | queued | → `canceled` (one L); DELETE then 403, re-send 422 | DOCUMENTED; **MEASURED 2026-10-30 (Q1)**. "Unsent recipients are stopped, sent mail stays" is DOCUMENTED only | the only documented way to stop a queued send |
| `DELETE /audiences/{id}` (`deleteAudience` :654, 404/410 = ok) | idle | 200 | MEASURED | — |
| same | its broadcast is `queued` | 200, **and the broadcast → `failed` within 5 s, no mail** | MEASURED 2026-10-29 | forbidden while any tick could send (D-037) |
| same | its broadcast is `sent` | UNKNOWN effect on the sent object | UNKNOWN | cleanup crons do this routinely |
| same | its contacts | "no Contacts are deleted"; they are only removed from the segment | DOCUMENTED (manage-segments); MEASURED for detach (`ROPA:1411`) | residual 8a |
| same | already gone | 404 | MEASURED (`S138:37`) | ok |
| `DELETE /audiences/{id}/contacts/{email}` (`removeContactFromAudience` :542) | present | `{deleted:true}`, but it only **detaches**; `GET /contacts/{email}` is still 200 | MEASURED 2026-09-09 (`ROPA:1411`) | `detached` |
| `DELETE /contacts/{id-or-email}` (`deleteContactGlobally` :591) | present | `{deleted:true}`; read-back 404 | MEASURED 2026-09-09; DOCUMENTED | **not called by erasure** (shared team, 8a) |
| `GET /audiences/{id}/contacts` (`getAudienceContactCount` :422) | deleted audience | 200 + empty list (no 404) | MEASURED 2026-09-10 | `complete` only when `has_more === false` |
| `GET /broadcasts/{id}/recipients` (list-broadcast-recipients, no gateway method) | — | exists | DOCUMENTED | the instrument for the snapshot probe |

---

## Lifecycles

**Broadcast.** Documented transitions plus measured ones; the label sits on each step.

```
create ─► draft ──/send──► queued ──► sent                (MEASURED: queued ≥15 s, sent by 45 s)
           │  ▲              │  └──audience deleted──► failed   (MEASURED; undocumented)
           │  │              └──/cancel──► canceled           (DOCUMENTED; MEASURED 2026-10-30; re-send 422)
           │  └──/cancel── scheduled                           (DOCUMENTED; RoPA says measured)
           └──/send {scheduled_at}──► scheduled ──time──► queued?   (DOCUMENTED; the post-schedule step is UNKNOWN)
DELETE: draft | scheduled → gone (404 after)  ·  queued | sent → 403
```

`sending` appears in no doc and no probe. Our mapping of it (`GW:1057`) is ASSUMED.

**Audience / segment.** create → (contacts attached by import) → delete. Deleting a segment never deletes contacts (DOCUMENTED). Contacts are one record per team (DOCUMENTED, migrating page; MEASURED, `R108:645`). Audiences are deprecated in favour of Segments, with no date (DOCUMENTED).

**Contact import.** `queued → in_progress → completed | failed` (DOCUMENTED). Async. One row took ~306 ms (MEASURED). The time for a large file is UNKNOWN. `completed` is not proof that rows attached (MEASURED). A job survives the deletion of its segment as `completed` (MEASURED). How long a job is retained is UNKNOWN.

---

## Limits & plan

| Item | Value | Label |
|---|---|---|
| Free marketing plan | 1,000 contacts, unlimited marketing emails, $0 | DOCUMENTED (account-quotas-and-limits, pricing); MEASURED billing page 2026-09-08 (`R108:476`) |
| Segments on Free | 3 (`General` holds one, so at most 2 broadcasts in flight) | MEASURED billing page 2026-09-08; the docs give no number |
| Does the cap count team-level contacts? | open | UNKNOWN (`R108:431`). If it does, reaping audiences frees no slots |
| Pro Marketing | from $40/mo for 5,000 contacts, up to $650 for 150k; segments unlimited per `R108:500` | DOCUMENTED (pricing) / MEASURED billing page |
| Rate limit | 10 req/s per team, every key; headers `ratelimit-*` and `retry-after` | DOCUMENTED (rate-limit); MEASURED `ratelimit-policy: 10;w=1` 2026-09-08 (`R108:321`) |
| Serial write throughput | ~2.08 req/s (RTT ~0.48 s from Bangkok) | MEASURED 2026-09-08 (`R108:351`) |
| Import file | ≤200 MB CSV | DOCUMENTED |
| Import processing time at 1k rows | — | UNKNOWN |
| Email data retention | 30 days, every plan | DOCUMENTED (account-quotas-and-limits) |
| Overage | hard limit at 5× the monthly quota | DOCUMENTED |

**What an upgrade changes.** It raises the contact cap and lifts the segment limit, so more than two E-Blasts could be in flight. It does not change rate limits or latency. It unlocks "turn off message content storage", which needs Pro or Scale for at least a month, 3,000+ emails and a $50/mo add-on (DOCUMENTED). For the import leg, the 2-in-flight segment limit is the bound a lease interacts with: a held lease keeps a segment occupied.

---

## Idempotency & retries

**What Resend guarantees**

- `Idempotency-Key` is DOCUMENTED for Emails (send, batch) and Inbox sends only.
  - The key is kept for 24 h.
  - The same key with a different body → 409 `invalid_idempotent_request`.
  - A concurrent request with the same key → 409 `concurrent_idempotent_requests`.
- None of that is documented for broadcasts, segments or imports.
- MEASURED: inert on `POST /broadcasts` (2026-09-09), and makes no difference on `/send` (2026-10-29).
- The real guarantee is state-based. `/send` succeeds once, only from `draft`, and every replay gets 422 (MEASURED).
- 409 `resource_locked` is DOCUMENTED as a general error ("another request is already updating this resource"). Never observed here.

**What our gateway does**

- `withRetry` (`GW:166-210`): 5 retries on `retryable` only, backoffs 1/2/4/8/16 s (`GW:42`), so up to ~31 s plus the call time.
  - `retryable` covers: status 0 (network), 5xx, every 429.
  - 409 → `idempotency_conflict`. 404 with a resource id → `resource_missing`. Everything else → `permanent` (`GW:111-164`).
- SDK 4.8.0 network failures come back as `{name:'application_error'}` with no `statusCode` (`node_modules/resend/dist/index.js:584-591`). `classifyResendError` defaults those to 500, so they are retryable. That is fine, but a timeout is indistinguishable from a 500.
- Endpoints that retry, with no key: `createAudience`, `createBroadcast`, `createContactImport`. A retry after Resend already did the work creates a duplicate:
  - an orphan audience, which the reclaim crons sweep;
  - an orphan draft;
  - a second import job, which converges because of upsert (`GW:776-793`).
- `sendBroadcast` retries are safe only because a replay gets 422, and 422 is then probed (`GW:389-396`).
- Bounded variants:
  - `deleteBroadcastOnce` / `retrieveBroadcastOnce` are raw `fetch` with `AbortSignal.timeout(10_000)`, no retry, and a typed outcome (`GW:727-749, 521-540, 978, 989-1010`). Built for the erasure lock (D-040, `docs/decisions.md` D-040).
  - The import calls go through `importFetch`, with a 30 s timeout and a retry on top (`GW:971, 1012-1045`).
  - Every SDK-based call has **no timeout** (P139 P1). A hung call is bounded only by the route's `maxDuration = 300`.

**Gaps to decide in spec 140**

- A 429 quota code is retried as if it were transient.
- A 409 `resource_locked` is read as an idempotency conflict.
- A lease must outlast the worst case: retries (~31 s) × the calls in one tick, plus any untimed SDK call. Better: bound every call, as the `*Once` variants do.

---

## Data retention / privacy (RoPA 8a / 8c / 8d)

**What the docs say**

- Email data is kept 30 days (account-quotas).
- Backups are point-in-time, kept 7 days. Data is encrypted at rest. SOC 2 Type II. A GDPR DPA is available (security.md).
- Message content storage can be switched off on paid plans only (sensitive-data KB).
- Deleting a segment leaves its contacts in place (manage-segments).
- Contacts are one record per team (migrating page).

**What the docs do not give**

- Retention of a sent broadcast object (HTML, name, from). UNKNOWN. This is the 8c / 8d residual and the retention-sweep's "Resend copies" item (`ROPA:255`).
- Retention of import jobs. UNKNOWN. Import CSVs hold member emails.
- The data region. `ROPA:60` says "EU regional cluster", but no fetched page confirms it. **UNKNOWN from the docs.** Check the DPA at resend.com/legal/dpa.

**Repo facts**

- 8a (`ROPA:1411`): contacts survive detach and audience delete (MEASURED). The global delete exists (`GW:591`) but is not called (shared team).
- 8c (`ROPA:1413`): mail that was already sent cannot be undone. Our evidence for it is an audit row.
- 8d (`ROPA:1414`): unsent pre-scrub drafts that no gate reaches.
- `ROPA:262` said send logs last "Resend default (90 days)"; PR #702 corrected it (30 days documented for email data; broadcast logs not documented separately, not measured).

**Deletion APIs available:** DELETE broadcast (draft or scheduled only), DELETE segment / audience, DELETE contact (by id or email, global), cancel broadcast. No API deletes a sent broadcast object. That needs an Art. 28(3)(e) instruction, as the RoPA says.

---

## Open questions → proposed measurements

Every probe uses only `delivered@resend.dev`, a throwaway segment and a self-identifying subject, and cleans up afterwards. **Dev and prod share `RESEND_BROADCASTS_API_KEY`**, so every probe runs on the production account: keep it to the sink address.

| # | Question | Probe | Settles |
|---|---|---|---|
| Q1 | The exact status string after cancelling a queued send (`canceled` or `cancelled`), and whether a DELETE on it answers 403 | create → `/send` → `POST /broadcasts/{id}/cancel` within ~2 s (queued lasts ≥15 s) → GET → DELETE → GET | The `normaliseStatus` cell. Whether the spec 138 re-mint arm and the spec 139 "403 + cancelled" arm can fire. Whether cancel-queued can serve as lease recovery ("stop a send whose owner died"). |
|  | **ANSWERED 2026-10-30 (MEASURED, sink only, 2 runs):** cancel on a queued broadcast → 200, then GET = `"canceled"` (one L) at +0/2/15/45 s; DELETE → 403 "Only draft or scheduled broadcasts can be deleted"; GET after → 200; re-send → 422. Our `normaliseStatus` must map `canceled` (fixed in PR #698). |  |  |
| Q2 | Does `sending` exist? | poll GET every 250 ms from `/send` to `sent` | Whether the `sending` arm is real or dead |
| Q3 | Can a 404 be stale (GET or DELETE)? | create → immediate GET/DELETE ×N; `/send` → GET at 0/100/500 ms | Whether the two-not-found rule (3 s re-probe) is needed or enough |
| Q4 | When does a broadcast go `failed` besides an audience delete? | send to a segment emptied just before `/send`; send with an unverified `from` domain | Which recovery `failed` needs (refuse vs re-mint); whether the lease can mint safely after `failed` |
| Q5 | Does an import into a segment deleted mid-flight complete, and where do its contacts land? | submit a 1-row import, delete the segment immediately, poll the import, `GET /contacts/{email}` | The tick-1/tick-2 teardown order under the lease, and 8a exposure |
| Q6 | When is the recipient set snapshotted? | Segment with 2 sink contacts (`delivered+a@` / `+b@` **only if** Resend's test-email doc confirms plus-labels on `resend.dev`; this was not verified here. Otherwise use one contact and detach it while queued); `/send`; detach while queued; `GET /broadcasts/{id}/recipients` | Whether a contact change (unsubscribe, erasure detach) after `/send` can still stop delivery; DE2/8c wording |
| Q7 | Does a DELETE racing `/send` on one draft ever answer 409 `resource_locked`, and who wins? | fire both in parallel ×20 | The classifier's 409 arm, and the erasure-vs-dispatch interleave the lease must order |
| Q8 | Does the 1,000 cap count team-level contacts? | paginate `GET /contacts` to the end, compare with the usage page | Free-plan capacity planning; whether reaping frees slots (`R108:431`) |
| Q9 | Import time at moderate size | **Not at 1,000 rows on this account.** The shared prod key plus the 1,000-contact Free cap means that would fill the live quota and break the next real E-Blast. At most ~50 rows (plus-labelled sink addresses only if label support is verified), with Q8's paginated count before and after as proof of cleanup. The 1k-row timing and the over-cap error code need a separate Resend account or a paid tier | The import poll cadence and the lease TTL (extrapolated, labelled so) |
| Q10 | The effect of deleting a segment after `sent` on the broadcast object | send, wait for `sent`, delete the segment, GET the broadcast | Whether `cleanup-audiences` can change a sent row's provider status (`reconcile-stuck-sending`) |
| Q11 | Does an SDK 4.8 `sdk.post(..., {signal})` abort? | an `AbortSignal.timeout(1)` on a GET through `sdk.get` | Whether every call can be bounded without raw fetch or the 6.x upgrade |

Q1, Q3, Q5 and Q7 bear directly on spec 140's design. Q8 and Q9 bear on capacity.

---

## Implications for spec 140

- **The lease needs a fencing token**, as D-037 noted (`docs/decisions.md:190`).
  - A lease can expire while a Resend call is in flight. That call can be an untimed SDK call, or a retry ladder of up to 31 s.
  - Every side effect after a call must re-assert the token in its CAS. The `audience_import_id` fence is a partial version of this today.
- **Resend's draft-only `/send` and DELETE are the provider-side mutex.** The lease must guarantee only one thing: no audience delete and no fresh mint while another holder may have sent. That is the measured `failed` trap.
- **Persist before acting stays mandatory.**
  - Persist the segment id before the import, the import id before polling, and the broadcast id before `/send`.
  - Nothing on this surface is idempotent by key.
  - Do not use `create {send:true}`.
- **Status mapping is one decision point.** Put the provider vocabulary in the state table:
  - `draft, scheduled, queued, sent, canceled, failed` (Q1 answered: `canceled`; keep the two-L `cancelled` alias only while code still names it), and `sending` until Q2 is answered;
  - import: `queued, in_progress, completed, failed`.
  - Unknown values fail closed, as today. `canceled` is live (Q1), so every `cancelled` cell in the table is reachable. The import leg's cancelled re-mint arm already exists and is live since PR #698 (`TICK` `inheritedDead`); what was deferred from 139 to 140 is the decision whether it may run when an operator cancelled the broadcast in the Resend dashboard.
  - **Import status `canceled` is ASSUMED** — not in the documented import vocabulary, yet `TICK:1548` matches it (and calls the vocabulary UNVERIFIED although `queued | in_progress | completed | failed` is DOCUMENTED). Spec 140's import table settles it: cite the doc or measure, then drop or keep the arm.
- **Classify by HTTP status first, then by code.**
  - Split 409 `resource_locked` from the idempotency 409s.
  - Split the 429 quota codes (not retryable) from `rate_limit_exceeded`.
  - Never trust a bare 403: an inactive key (403 `restricted_api_key`) or a scope-less OAuth token (403 `invalid_permission`) also answers 403; a send-only key answers 401.
- **Bound every call.** Use `AbortSignal.timeout` everywhere, as the `*Once` variants do (or verify Q11), so the lease TTL can be computed. The SDK upgrade is the natural time for this: the 6.x source declares `signal`, and the current SDK/docs use `segmentId`, and for leaving the deprecated Audiences API.
- **Completion is poll-only.** No broadcast or import webhooks exist, so the lease holder or the next holder must poll. The 30-min import ceiling (`IMPORT_STUCK_AFTER_MS`, `TICK:94`) and the 2-in-flight segment limit set the queueing behaviour.
- **Recovery for a dead holder.**
  - The next holder probes the broadcast first: `queued` or `sent` means catch up, `draft` means reuse, 404 means re-probe and then re-mint.
  - Only then does it touch the audience.
  - Cancel-queued (Q1) is the only documented way to stop a send already handed over. Decide whether the lease uses it.
- **Erasure (D-040) holds a row lock for up to ~23 s across two Resend calls** (10 s DELETE + 3 s `REPROBE_PAUSE_MS` + 10 s GET). The lease must be ordered against that lock, not around it.
- **The legacy leg's retirement is planned for spec 140** (decision D-042, not yet made). Until then the flip precondition "no legacy row in flight" (D-038, go-live § 6.10) still needs a drain check in 140.

---

## Sources

Resend docs, all accessed 2026-10-30:
- https://resend.com/docs/api-reference/broadcasts/delete-broadcast
- https://resend.com/docs/api-reference/broadcasts/send-broadcast
- https://resend.com/docs/api-reference/broadcasts/get-broadcast
- https://resend.com/docs/api-reference/broadcasts/cancel-broadcast
- https://resend.com/docs/api-reference/broadcasts/create-broadcast.md
- https://resend.com/docs/dashboard/broadcasts/manage-broadcasts.md (status list)
- https://resend.com/docs/dashboard/broadcasts/introduction
- https://resend.com/docs/api-reference/contacts/create-contact-import
- https://resend.com/docs/api-reference/contacts/get-contact-import
- https://resend.com/docs/api-reference/contacts/list-contact-imports.md (import statuses)
- https://resend.com/docs/api-reference/contacts/delete-contact.md
- https://resend.com/docs/api-reference/segments/delete-segment.md
- https://resend.com/docs/dashboard/contacts/manage-segments.md
- https://resend.com/docs/dashboard/contacts/migrating-from-audiences-to-segments.md
- https://resend.com/docs/api-reference/rate-limit
- https://resend.com/docs/dashboard/emails/idempotency-keys
- https://resend.com/docs/api-reference/errors.md
- https://resend.com/docs/knowledge-base/account-quotas-and-limits
- https://resend.com/docs/knowledge-base/what-is-resend-pricing.md
- https://resend.com/docs/dashboard/webhooks/event-types
- https://resend.com/docs/security.md
- https://resend.com/docs/knowledge-base/how-do-i-ensure-sensitive-data-isnt-stored-on-resend.md
- https://resend.com/docs/llms.txt (index)

Other sources:
- Context7 `/resend/resend-node` (`RequestOptions`, `fetchRequest`) and `/llmstxt/resend_llms-full_txt`.
- npm `resend` 6.35.0, modified 2026-10-27.

Repo files:
- `.claude/rules/modules/broadcasts.md:21-27`
- `src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts` (lines cited above)
- `src/modules/broadcasts/application/use-cases/build-audience-tick.ts:94, 1515-1600`
- `specs/138-f7-import-hold-abandon/spec.md:22-42, 98-117`
- `specs/139-eblast-erasure-close/spec.md:18-28, 44-53`; `plan.md:31-49, 195-224, 294`
- `docs/decisions.md` D-037, D-038, D-040
- `docs/compliance/processing-records.md:60, 255, 262-263, 1411-1414`
- `specs/108-contact-recipient-rules/research.md:288-534` (R9, T095, V2, V4, Free-plan addendum), `:645-680` (R16)
- `specs/010-email-broadcast/research.md:9-46, 332-360`. **Stale**:
  - "Free tier 3,000 recipients/month + 100 audiences, MVP on Pro" is wrong on every number;
  - the SDK method names (`audiences.contacts.create`, `broadcasts.send({id})`) are out of date;
  - "no bulk endpoint" is out of date: the import API exists;
  - "Resend does not auto-delete audiences" was never verified.
- `node_modules/resend/dist/index.js:555-616` (SDK 4.8.0 `fetchRequest` / `post` / `get`)

Memory notes:
- `reference_resend_delete_queued_broadcast_and_audience.md`
- `reference_resend_idempotency_key_is_inert.md`

---

## Addendum — Resend MCP read-only inspection (2026-10-30)

The Resend MCP is connected to the same account as `RESEND_BROADCASTS_API_KEY`: it lists this session's own probes. Read-only calls only; nothing was written.

- **Status spelling confirmed:** `get-broadcast` on the Q1 probe shows `Status: canceled`.
- **Segments:** only `General` exists now. Every probe audience was deleted, so the Free-plan segment slots are free.
- **Broadcasts outlive their segment.** All 10 remaining broadcasts point at segment ids that no longer exist. They keep their status (`sent`, `failed`, `canceled`) and their full HTML and plain text, which `get-broadcast` returns. This answers part of Q10: deleting a segment after `sent` leaves the broadcast object and its content in place. It is direct evidence for RoPA 8c (a sent copy) and for the canceled part of 8d: that content stays readable at Resend, and DELETE answers 403 on `sent` and `canceled` (MEASURED 2026-10-29 / 2026-10-30), so removal is manual (dashboard, unverified) or an Art. 28(3)(a)/(e) and PDPA s.33 instruction. A **draft** (the rest of 8d) is deletable through the API (200, MEASURED). DELETE on `failed` is **UNKNOWN** (not probed; the docs' "only draft (including scheduled)" rule suggests 403).
- **DELETE does remove the rest.** Broadcasts deleted with 200 (S1, the S2 drafts) are absent from `list-broadcasts`.
- **Contacts outlive audience deletion (8a confirmed again).** 22 team-level contacts remain: the sink plus the maintainer's own `+` test addresses from 2026-09-08. Partial answer to Q8: these 22 count towards the 1,000 cap unless removed globally.
