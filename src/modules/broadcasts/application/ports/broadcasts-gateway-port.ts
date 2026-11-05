/**
 * T028 — `BroadcastsGatewayPort` Application port (F7).
 *
 * Abstraction over the **Resend Broadcasts API** (separate Resend
 * product from F1+F4 transactional Resend). Hides SDK shape behind
 * narrowed envelopes per Constitution Principle III + OWASP A06
 * sanitiser-boundary discipline.
 *
 * Workflow per broadcast (FR-020; `build-audience-tick.ts`, the only dispatch
 * leg since spec 140 s4):
 *   1. `createAudience(name)` — fresh audience per broadcast
 *   2. `createContactImport(audienceId, emails)` — the whole audience in one
 *      call; `getContactImport(importId)` on a later tick confirms it
 *   3. `createBroadcast(input)` — registers the broadcast resource
 *   4. `sendBroadcast(broadcastId, idempotencyKey)` — fires the dispatch
 *
 * Reconciliation path (T161 R2-NEW-3 — 24h stuck-`sending` recovery):
 *   - `retrieveBroadcast(broadcastId)` returns a discriminated union
 *     (`{kind:'present',resource}|{kind:'not_found'}`) allowing the
 *     reconcile job to detect Resend-side resource missing →
 *     emits `broadcast_resend_resource_missing` audit
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

/**
 * Transport-class tag on `retryable` errors so OTel metrics can split
 * network outage from server-side bugs (review I6 — 2026-04-30).
 */
import type { BrandSettings } from '../../domain/brand/brand-settings';

/**
 * Spec 140 slice 3 (DT3) — `locked` is Resend's 409 `resource_locked` ("another
 * request is already updating this resource"; DOCUMENTED, never observed on the
 * sink, research.md step 0.3): nothing was refused, so it is retried, under its
 * own label so a stuck lock does not page as `api` or `unclassified`.
 */
export type GatewayRetryableSubKind = 'network' | 'timeout' | 'server_5xx' | 'api' | 'locked';

/**
 * Spec 140 s2a (DL8) — the budget of one gateway REQUEST, retries and their
 * backoff included: one `AbortSignal.timeout` spans every attempt. 10 s against
 * a measured round trip of ~0.5 s. It bounds every method except
 * `createContactImport`, which has {@link IMPORT_CALL_TIMEOUT_MS} (30 s); a
 * port call that loops (`listAudiences`) takes it per request; `listAudiences` also stops at its caller's `deadlineAt` (spec 140
 * DT5). Exported for the dispatch lease (slice 2b): in W_max only the one
 * import-POST term takes {@link IMPORT_CALL_TIMEOUT_MS} (every other call stays
 * at this C), and the pre-call lease check before `createContactImport` must
 * demand at least IMPORT_CALL_TIMEOUT_MS + M of lease left, not C + M (plan.md,
 * review rounds 3-4).
 */
export const RESEND_CALL_TIMEOUT_MS = 10_000;

/**
 * Spec 140 s3 review round 1 (R1-H) — the ONE deadline rule of the orphan
 * reclaim: a call starts only while one whole bounded call (`callBudgetMs`, the
 * gateway's per-call budget) still fits before `deadlineAt`. The use case's
 * delete chunks and the gateway's `listAudiences` pages both judge with it. The
 * use case passes `RESEND_CALL_TIMEOUT_MS` and its `ClockPort`; the gateway its
 * `callTimeoutMs` (default `RESEND_CALL_TIMEOUT_MS`) and `Date.now()`. In
 * production the two are the same value and the same clock (`systemClock` is
 * `new Date()`); only a test that builds the gateway with a shorter budget, or
 * injects a fixed clock, sees them differ.
 */
export function oneCallFitsBefore(deadlineAt: Date, nowMs: number, callBudgetMs: number): boolean {
  return deadlineAt.getTime() - nowMs >= callBudgetMs;
}

/**
 * Spec 140 slice 3 (DT3; review round 2, R2-D) — Resend's two sending-quota
 * error names. A 429 with one of them is permanent, and the gateway keeps the
 * name as the throw's `code` (an exact match against this list, so only these
 * two fixed tokens pass, never other provider text). One list for the
 * gateway's classifier, `isQuotaExceededCode` and the tick's audited codes.
 */
export const RESEND_QUOTA_EXCEEDED_CODES: ReadonlyArray<string> = [
  'daily_quota_exceeded',
  'monthly_quota_exceeded',
];

/**
 * Spec 140 s2a review round 2 (CR#3) — `createContactImport`'s budget: it
 * uploads the whole audience as one CSV (up to the 5,000 / 50,000 ceiling), so
 * 10 s is unsized for it. 30 s is the pre-s2a `importFetch` value and is
 * **ASSUMED**, not measured at size: the import POST measured 412 ms for a
 * small CSV (2026-09-08); slice 4's ceiling work measures it at 900 rows.
 */
export const IMPORT_CALL_TIMEOUT_MS = 30_000;

export type BroadcastsGatewayError =
  | {
      readonly kind: 'retryable';
      readonly subKind: GatewayRetryableSubKind;
      readonly reason: string;
    }
  | { readonly kind: 'idempotency_conflict'; readonly reason: string }
  | {
      readonly kind: 'resource_missing';
      // `'import'` included: `_classify-thrown.ts` names THIS type as the shape it
      // duck-types into, and its rationale says the union is widened "along the
      // whole chain rather than only where the value is produced". This
      // declaration was the one link the sweep missed — invisible to `tsc`
      // because `BroadcastsGatewayError` has no runtime consumer, which is exactly
      // what makes it the drift canary the next reader will trust.
      readonly resourceType: 'audience' | 'broadcast' | 'import';
      readonly resourceId: string;
    }
  | { readonly kind: 'permanent'; readonly code: string; readonly reason: string };

export interface CreateBroadcastInput {
  readonly audienceId: string;
  readonly subject: string;
  /**
   * Sanitised, member-authored inner HTML — the gateway adapter wraps
   * this in a chamber-branded shell + locale-aware footer carrying the
   * unsubscribe CTA before submitting to the upstream provider
   * (T147 — F7 US4 / FR-029). Callers MUST NOT pre-wrap; double-wrap
   * would corrupt the unsubscribe merge tag.
   */
  readonly htmlBody: string;
  readonly fromName: string;
  readonly fromEmail: string;
  readonly replyToEmail: string;
  readonly broadcastNameForResendDashboard: string;
  /**
   * Recipient locale used to render the footer strings (T147 — F7 US4).
   * Resolved by the dispatch use-case from the tenant default until F12
   * adds per-tenant + per-recipient locale columns. Required so the
   * footer's bilingual unsubscribe CTA matches the body language.
   */
  readonly locale: 'en' | 'th' | 'sv';
  /** Tenant display name for the chamber-branded header + footer. */
  readonly tenantDisplayName: string;
  /**
   * F119 T031 (FR-041a/c) — the tenant's LIVE brand chrome (logo URL,
   * primary colour, postal address), read by the dispatch use case at send
   * time and rendered by the adapter's wrapper. Omitted ⇒ the pre-F119
   * email (chamber-name header, "Sent by" footer, platform CTA colour).
   */
  readonly brand?: BrandSettings;
}

export interface RetrievedBroadcastResource {
  readonly id: string;
  /**
   * MEASURED 2026-09-10, and the measurement cost two review rounds to get right.
   *
   * `'draft'` is what a broadcast created by `POST /broadcasts` and never handed
   * to `/send` reports (probed with a draft + DELETE against the live account —
   * never `/send`). It was missing from this union, so `normaliseStatus` sent the
   * most ordinary state a broadcast can be in through its unknown-status default
   * — reported as `'queued'` AND logged at error on every retrieve.
   *
   * `'unknown'` is EXPLICIT because the alternative was a lie: that default used
   * to FABRICATE `'queued'`, so the union was closed at the type level and open at
   * runtime, and no caller could tell a real `queued` from "Resend said something
   * we have never seen". `'draft'` is the standing proof that the open set is not
   * hypothetical — it was in it.
   *
   * **Only the never-sent direction is measured.** `'draft'` proves a resource was
   * never sent; a non-draft status does NOT prove one was. So a caller deciding
   * anything consequential must test POSITIVELY for the states it means.
   * The dispatch tick reads `'queued' | 'sending' | 'sent'` (`isHandedStatus`)
   * to decide whether a re-entered tick may send an inherited id — rather than
   * assuming Resend answers 409, which it refuses to rely on because the idempotency
   * header is MEASURED inert on `POST /broadcasts`, and on `/send` Resend answers
   * any second send of a non-draft broadcast 422, whatever the key (MEASURED
   * 2026-10-29, `_probe-refused-send.ts`).
   *
   * `'cancelled'` and `'unknown'` are the counter-examples that cost a round: read
   * as "already sent" by a `!== 'draft'` test, they skipped the send while still
   * advancing the row to `sending`, after which the reconciler stamped `sent` and
   * consumed the member's annual E-Blast quota for mail that never went out.
   *
   * `failed` and `scheduled` are real Resend statuses too (MEASURED 2026-10-29:
   * deleting the audience of a `queued` broadcast turns it `failed` within 5 s,
   * `sent_at` null, no mail) and still arrive here as `'unknown'`, refused by
   * the dispatch tick's probe. Deliberately not mapped: the union is read by
   * the live `reconcile-stuck-sending` too, and the import leg's fence closed
   * the one path this code had to produce `failed`.
   */
  readonly status:
    | 'draft'
    | 'queued'
    | 'sending'
    | 'sent'
    | 'cancelled'
    | 'unknown';
  readonly sentAt: string | null;
}

/**
 * Discriminated union for `retrieveBroadcast` (review TYPES
 * recommendation). Replaces `T | null` so the caller cannot mistake
 * "404 not found" for "transient null" — explicit `kind` means a
 * future "soft delete" or "in-tombstone" Resend status can extend the
 * union without breaking call sites.
 */
export type RetrieveBroadcastOutcome =
  | { readonly kind: 'present'; readonly resource: RetrievedBroadcastResource }
  | { readonly kind: 'not_found' };

/**
 * Round 2 R2-25 — did the call REMOVE something, or was it already absent?
 *
 * `removeContactFromAudience` used to return `void` and resolve on a 404, so its
 * caller could not tell a detach from a no-op. The erasure adapter counted every
 * non-throwing call as a removal (its own comment said so: "includes a 404
 * (already absent)"), that number became `resend_contacts_removed_count` in an
 * append-only Art. 30 record, and the DPO's evidence card rendered it under the
 * label **"Contacts removed"**. A DSR answer produced by following the runbook
 * was therefore materially false under Art. 12(3) — it asserted removals that had
 * not happened.
 *
 * Both outcomes are successes; only one is a removal.
 */
export type RemoveContactOutcome =
  | { readonly kind: 'detached' }
  | { readonly kind: 'already_absent' };

/**
 * Spec 139 P1 — what ONE `DELETE /broadcasts/{id}` answered
 * (`deleteBroadcastOnce`). A union, not `void`, because the erasure cascade
 * acts on each arm differently:
 *
 *   - `deleted` (200) — the draft is gone, so the row can be cancelled;
 *   - `absent` (404, 410) — gone by this answer; the erasure cascade confirms
 *     it with one `retrieveBroadcastOnce` before it cancels (two not-founds,
 *     as the import leg requires before it re-mints);
 *   - `forbidden` (403) — MEASURED 2026-10-29: Resend's answer for a `queued`,
 *     `sent` or `cancelled` broadcast, but a restricted key answers 403 too, so
 *     the caller probes before it believes "already sent" (P5);
 *   - `retryable` — a 5xx, a 429, a transport failure or the 10 s timeout. A
 *     timeout is ambiguous (the DELETE may have landed), so nothing is decided;
 *   - `other` — any other status.
 */
export type DeleteBroadcastOnceOutcome =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'retryable' }
  | { readonly kind: 'other' };

/**
 * Spec 139 review round 1 — what ONE `GET /broadcasts/{id}` answered
 * (`retrieveBroadcastOnce`). The erasure cascade probes under the row lock
 * after a DELETE 404 or 403, so the probe is bounded like the DELETE and never
 * throws:
 *
 *   - `present` — Resend has the resource; `status` is `normaliseStatus`'s
 *     reading (an unmeasured value is `'unknown'`, never invented), plus
 *     `'failed'`, which only THIS reader names (spec 140 s1, below);
 *   - `not_found` (404, 410);
 *   - `retryable` — a 5xx, a 429, a transport failure or the 10 s timeout;
 *   - `other` — any other status, or a 2xx body without a status string.
 *
 * Spec 140 s1 — `failed` is MEASURED (2026-10-29: deleting the audience of a
 * `queued` broadcast turns it `failed`, no mail). The erasure cascade's
 * terminal-draft pass is the only caller that needs it: after a 403 it records
 * such a copy as retained at Resend. It is added HERE, not to
 * `RetrievedBroadcastResource['status']`, because that union is read by the
 * dispatch tick and the live `reconcile-stuck-sending`, where `failed` must
 * keep reading `unknown` (refused, fail closed). The in-flight arm of the
 * cascade still treats `failed` as unexpected.
 */
export type RetrieveBroadcastOnceOutcome =
  | {
      readonly kind: 'present';
      readonly status: RetrievedBroadcastResource['status'] | 'failed';
      /**
       * Spec 140 s2c review round 2 (reliability nit) — the body's `sent_at`
       * when it is a string, else `null`. The adapter always sets it; review
       * round 3 (code-review #6) made it required, so a double must too.
       */
      readonly sentAt: string | null;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'retryable' }
  | { readonly kind: 'other' };

/**
 * What `getAudienceContactCount` answers. A plain record, not a discriminated
 * union — and it used to be one.
 *
 * Until 2026-09-10 this carried a `| { kind: 'not_found' }` tail "mirroring
 * `RetrieveBroadcastOutcome`", and the adapter mapped a 404 into it. But the
 * list endpoint does not 404: `GET /audiences/{id}/contacts` on an audience
 * that does not exist answers `200 {"object":"list","has_more":false,"data":[]}`
 * (MEASURED, read-only probe against the live account — pinned in
 * `resend-audience-contact-count.test.ts`). So the arm was real code with no
 * reachable input, every caller carried a branch for it, and one of those
 * branches (`build-audience-tick`) routed the impossible value to the
 * unverifiable path — a decision nothing could ever exercise. Removed rather
 * than documented: if Resend ever starts answering 404 here, the adapter's
 * `resource_missing` throw reaches the caller's catch, which is the
 * unverifiable arm anyway, and now says so on the log line.
 */
export interface AudienceContactCount {
  readonly count: number;
  /**
   * Round 4 F1 residual — is `count` the WHOLE audience, or one page of it?
   *
   * `GET /audiences/{id}/contacts` paginates and says so: the response
   * carries `has_more` alongside `data`. MEASURED against the live account
   * on 2026-09-09 — top-level keys are exactly `data,has_more,object`. The
   * SDK models neither: `ListContactsOptions` is `{ audienceId }` and
   * `ListContactsResponseSuccess` is `{ object, data }`, so the adapter
   * returned `data.length` and threw the truncation signal away.
   *
   * That mattered because a truncated count that happens to land at or below
   * the resolved count was indistinguishable from a VERIFIED-CLEAN audience.
   * The `>` comparison is safe either way (truncation can only undercount, so
   * no false refusals), but "we checked and it matched" was a claim the data
   * could not support.
   *
   * `false` means the caller may only conclude a LOWER BOUND.
   */
  readonly complete: boolean;
}

export interface BroadcastsGatewayPort {
  createAudience(name: string): Promise<{ readonly audienceId: string }>;

  createBroadcast(
    input: CreateBroadcastInput,
  ): Promise<{ readonly broadcastId: string }>;

  /**
   * Send a previously-created broadcast. The `idempotencyKey` MUST be
   * stable per (tenant, broadcast) per FR-020 — the same broadcast_id retried
   * MUST use the same key.
   *
   * That is OUR half of the contract, and it used to be justified here by "so
   * Resend short-circuits replays". Do not reason from that: the header was
   * MEASURED INERT on `POST /broadcasts` (2026-09-09 — two identical calls with
   * the same key created two resources). On `/send` it changes nothing either,
   * MEASURED 2026-10-29 (live account, sink address only): a second `/send` of
   * an accepted broadcast — same key, another key or none — answers `422
   * validation_error "Only draft broadcasts can be sent or scheduled"`, and the
   * provider delivers ONCE. So a repeat cannot double-send, and the repeat's
   * 422 (classified `permanent`) must be probed, not believed
   * (`_probe-refused-send.ts`); a `409` does not come back for it.
   *
   * Stable format: `broadcast-{tenantId}-{broadcastId}` per FR-020.
   */
  sendBroadcast(
    broadcastId: string,
    idempotencyKey: string,
  ): Promise<void>;

  /**
   * Retrieve a broadcast resource — used by the 24h stuck-`sending`
   * reconciliation job (T161). Returns a discriminated union: `present`
   * with the resource, or `not_found` when Resend reports 404 (emits
   * `broadcast_resend_resource_missing` downstream).
   */
  retrieveBroadcast(
    broadcastId: string,
  ): Promise<RetrieveBroadcastOutcome>;

  /**
   * Spec 139 review round 1 — ONE `GET /broadcasts/{id}`: no retry or backoff
   * and a hard {@link RESEND_CALL_TIMEOUT_MS} (10 s) timeout, like
   * {@link deleteBroadcastOnce}. The
   * erasure cascade calls it while it still holds the broadcast row's lock
   * (after a DELETE 404 or 403), so the row's whole decision is made under the
   * lock that did the DELETE; together the two calls hold it for at most
   * ≈ 20 s. Never throws: every failure is an arm of
   * {@link RetrieveBroadcastOnceOutcome}.
   */
  retrieveBroadcastOnce(broadcastId: string): Promise<RetrieveBroadcastOnceOutcome>;

  /**
   * Round-4 IMP-5 — count contacts present in a Resend audience. The
   * dispatch tick reads it before the send (`build-audience-tick.ts`): an
   * audience holding MORE contacts than were resolved is refused as
   * `audience_membership_drift`. (The legacy leg's replay-arm reading of it,
   * and its `broadcast_resend_audience_drift` audit, went with that leg in
   * spec 140 s4.)
   *
   * A DELETED audience is a verified-complete ZERO here, not an error — see
   * `AudienceContactCount`. Transport and 5xx failures throw a retryable
   * `GatewayThrowable`, like every other method on this port.
   */
  getAudienceContactCount(
    audienceId: string,
  ): Promise<AudienceContactCount>;

  /**
   * Detach a contact from ONE audience. A 404 (contact or audience already
   * absent) resolves as `already_absent`; a 5xx / network error throws a retryable
   * GatewayThrowable so the caller can classify it as a propagation failure.
   *
   * ⚠️ This does NOT satisfy GDPR Art. 17, and its provider response says
   * otherwise. Measured 2026-09-09 (108 Phase 9 review U1): after a successful
   * call answering `{"deleted": true}`, the audience-scoped read 404s while an
   * audience-less `GET /contacts/{email}` still returns the contact at 200. It
   * detaches.
   *
   * **This is nevertheless the call the erasure cascade makes, on purpose.**
   * Round 3 finding 3-10: this line used to point at a global contact delete,
   * which contradicted the only erasure caller (`subprocessor-erasure-adapter.ts`)
   * and pointed a compliance reader at a call the codebase deliberately does not
   * make; spec 140 s4 removed that port method altogether. The Resend account is ONE
   * account shared by every tenant, so a global delete during tenant A's
   * erasure would destroy tenant B's contact record — including the
   * Resend-side `unsubscribed` flag that `on_conflict=upsert` exists to
   * preserve, resurrecting B's objecting member as SUBSCRIBED on the next
   * import. That trades an Art. 17 residual for an Art. 21 regression on
   * someone who never asked for anything.
   *
   * The residual is tracked as 8a in `docs/compliance/processing-records.md`.
   * Read that before changing this, not this docblock alone.
   *
   * Spec 140 slice 3 (DT4): a blank `audienceId` throws a permanent
   * `empty_identifier`, and one that is not UUID-shaped a permanent
   * `invalid_identifier`, before any request.
   *
   * Spec 140 slice 4: the wire is the segment-scoped
   * `DELETE /contacts/{email}/segments/{id}`. `detached` means Resend answered
   * `200 deleted:true`, which it does only for a membership that existed;
   * `already_absent` means it answered 404, which it does for a random segment,
   * the wrong case and a non-member (MEASURED 5 Nov 2026, research.md slice 4
   * step 0 items 1 and 4). A 200 without `deleted: true` throws a permanent
   * `detach_unconfirmed`, so it is never counted as a removal.
   */
  removeContactFromAudience(
    audienceId: string,
    email: string,
  ): Promise<RemoveContactOutcome>;

  /**
   * T086 (108 US5) — hand an entire audience to the provider in ONE call.
   *
   * The per-contact loop it replaced (deleted in spec 140 s4) was serial and
   * bounded by latency (~2.08 req/s measured), so roughly 623 contacts was all
   * a 300 s function could drain. This is size-independent: one multipart request,
   * ~412 ms whether it carries one address or fifty thousand, because the
   * provider processes it asynchronously and answers with a job id.
   *
   * The caller MUST NOT treat the returned id as delivery. Nothing has been
   * added yet — `getContactImport` is how completion is learned, and its
   * completion rule is the only safe send signal.
   *
   * Throws the same classified `GatewayThrowable` as every other method here.
   * A 4xx is `permanent` and must not be retried: the archetypal one is the
   * account contact cap, where each retry consumes the resource whose
   * exhaustion caused the failure.
   */
  createContactImport(
    audienceId: string,
    emails: readonly string[],
  ): Promise<{ readonly importId: string }>;

  /**
   * T086 — poll one import job.
   *
   * Returns the provider's `status` and `counts` VERBATIM; the completion
   * decision belongs to the Application layer, which requires ALL of:
   * `status === 'completed'`, `failed === 0`,
   * `created + updated + skipped === total`, and `total` equal to the count it
   * resolved. That rule is load-bearing, not defensive — one import in five
   * identical probes returned `completed` with `failed: 0` and `total: 0` and
   * attached nothing (research R9 V2 (c)). A caller that reads only `status`
   * will eventually send a broadcast to an empty audience.
   *
   * Absent counts (a job still `pending` has none) are returned as zeros, so
   * arithmetic on them compares rather than yielding NaN.
   */
  getContactImport(importId: string): Promise<{
    readonly status: string;
    readonly counts: {
      readonly total: number;
      readonly created: number;
      readonly updated: number;
      readonly skipped: number;
      readonly failed: number;
    };
  }>;

  /**
   * PR-2 #5 — delete an ephemeral per-broadcast Resend audience after the
   * broadcast reaches a terminal status (sent / cancelled / failed).
   * Best-effort: 404 (already gone) resolves (idempotent); 5xx / network
   * errors throw a retryable `GatewayThrowable` so the cleanup cron can
   * retry next tick without blocking normal broadcast flow.
   */
  deleteAudience(audienceId: string): Promise<void>;

  /**
   * Delete a broadcast RESOURCE this tick minted and cannot keep.
   *
   * Exists because the dispatch legs had three arms where
   * `createBroadcast` has returned an id that will never be persisted — a
   * sibling tick attached its own id first (CAS loss), the row vanished, or the
   * persist itself faulted — and until 2026-09-10 each of them wrote "we leak
   * the resource we just minted, because the gateway has no `deleteBroadcast`".
   * That was a PORT GAP, not a provider limit: this branch measured `'draft'`
   * by creating a broadcast and DELETING it against the live account, and a
   * resource on any of those arms is a draft by definition (minted, never sent).
   *
   * Same idempotency contract as `deleteAudience`: 404 / 410 (already gone)
   * resolve; 5xx / network throw a retryable `GatewayThrowable`. Best-effort at
   * every call site — a failed reclaim is logged at critical and the tick's
   * outcome is unchanged, because the outcome was decided before the reclaim.
   *
   * MEASURED 2026-10-29 (live account): `DELETE /broadcasts/{id}` on a
   * `scheduled` broadcast → 200 (then GET → 404); on a `queued` one (~1 s after
   * `/send`) → **403 `validation_error` "Only draft or scheduled broadcasts can
   * be deleted"**, and the send still completes (queued ~15 s+, sent by 45 s).
   * The adapter classifies that 403 `permanent`. A `sent` one answers the same
   * 403 (MEASURED 2026-10-29). `sending` is INFERRED from that message, not
   * caught — Resend moved queued → sent without showing it.
   *
   * **Never call this on an id read from the row** — with the exceptions below
   * (two here; a third, which goes through {@link deleteBroadcastOnce}, is the
   * erasure cascade's terminal-draft pass, spec 140 s1). A
   * persisted id is the resource a send may already have gone out on, so on
   * any live path only an id this tick minted and failed to persist is safe to
   * remove. The first exception is the import leg's restart
   * (`buildAudienceTick`'s `restartAudienceBuild`: a HOLD, or the
   * audience-missing self-heal), and only after `retrieveBroadcast` answered
   * `draft`, `cancelled` or `not_found` IN THE SAME TICK — a resource never
   * handed to `/send` — and only after the restart WON its claim on the row
   * (`releaseAudienceImport`), which the sender's fenced attach excludes. A
   * sibling that passed its fence and sent first makes this delete fail (the
   * measured 403): the restart stops with the id still on the row and the
   * next tick's probe finds it handed. A delete that lands first makes the
   * sibling's send 404; it re-reads the row, finds the import gone, and answers
   * a concurrent skip — no mail, never a double send. The second exception is
   * the F7 retention sweep (`sweepExpiredBroadcasts`, 0310): it calls this on
   * the persisted `resend_broadcast_id` (and any per-batch
   * `provider_broadcast_id`) of an E-Blast that is terminal AND past its
   * `retention_years` — the send finished years ago, and removing the Resend
   * copy (HTML body, a name naming the member and tenant) before the row is the
   * point. A `sent` broadcast's DELETE answers 403 `validation_error` (MEASURED
   * 2026-10-29), which the adapter classifies `permanent`; the sweep treats it
   * as "retained at the processor": our row is deleted anyway and the Resend
   * copy stays under Resend's own retention, a disclosed RoPA residual
   * (maintainer decision, 2026-09-25). A `retryable` failure keeps the row and
   * its key. Resend's retention of that copy is still unmeasured
   * (`docs/runbooks/cron-jobs.md` § F7 retention-sweep, "Resend copies").
   */
  deleteBroadcast(broadcastId: string): Promise<void>;

  /**
   * Spec 139 P1 — ONE `DELETE /broadcasts/{id}`: no retry or backoff and a
   * hard {@link RESEND_CALL_TIMEOUT_MS} (10 s) timeout. The erasure cascade
   * calls it while it holds the broadcast row's lock, so a slow Resend must not
   * hold that lock — and every dispatch tick that reaches the row — for the
   * backoff `deleteBroadcast` can spend (up to 10 s since spec 140 s2a; 31 s
   * before). Never throws: every failure is an arm of
   * {@link DeleteBroadcastOnceOutcome}.
   *
   * The second caller is the dispatch legs' standing refusal (spec 139 P2 for
   * an erased member, spec 140 s1 ED4 for a halted or ended membership), which
   * deletes a draft the probe said was never handed to `/send` before it
   * refuses the row (`deleteDraftBeforeRefusal`). The third is the erasure
   * cascade's terminal-draft pass (spec 140 s1): it calls this on the id a
   * TERMINAL row of the erased member still holds (outside the in-progress
   * set, not `sent`), with no row lock — no dispatch tick works a terminal row
   * — and probes a 403 once with {@link retrieveBroadcastOnce}. All three are
   * exceptions to `deleteBroadcast`'s "never on an id read from the row" rule
   * for the same reason: Resend arbitrates — DELETE answers 200 only on a
   * draft or scheduled broadcast, and `/send` works only on a draft — so a
   * DELETE that lands first makes any later `/send` 404, and a send that
   * landed first makes the DELETE 403.
   *
   * The fourth exception (spec 140 s2c) is an id read from the ORPHAN TABLE
   * (`broadcast_orphaned_resend_ids`, migration 0325), by the
   * `cleanup-audiences` drain and the erasure cascade's orphan pass
   * (`_settle-orphan-at-resend.ts`). Either reads an id only while NO
   * non-terminal `broadcasts` row of the tenant holds it (type-matched,
   * `BroadcastOrphansRepo`), and Resend arbitrates as above: a copy a tick has
   * handed to `/send` answers 403 and the one GET reads it handed. (The import
   * leg's `failTerminally` choke point, also spec 140 s2c, is the second
   * caller's path: `deleteDraftBeforeStandingRefusal` on the row's re-read id.)
   */
  deleteBroadcastOnce(broadcastId: string): Promise<DeleteBroadcastOnceOutcome>;

  /**
   * PR-2 orphan-reclaim — list all Resend audiences for the configured
   * Broadcasts API key. Used by the orphan-reclaim cron to find audiences
   * that exist in Resend but have no matching `broadcasts` DB row
   * (i.e. were leaked by a failed cleanup or a crash mid-dispatch).
   *
   * Returns `ResendAudienceSummary` rows — only the fields needed to
   * correlate with DB records. `createdAt` is a parsed `Date` (UTC) from
   * Resend's `created_at` field; the gateway adapter owns the parse so
   * callers work with a proper Date, not raw strings.
   *
   * Spec 140 slice 3 (DT5) — a per-invocation budget: a page starts only while
   * one bounded call ({@link RESEND_CALL_TIMEOUT_MS} on the default gateway)
   * still fits before `deadlineAt`. `truncated` says the list is cut (the
   * deadline, the page bound or a broken cursor), so a caller deletes less,
   * never more, and can say so.
   */
  listAudiences(input: ListAudiencesInput): Promise<ListAudiencesResult>;
}

/** Spec 140 slice 3 (DT5) — `listAudiences`' input. */
export interface ListAudiencesInput {
  readonly deadlineAt: Date;
}

/** Spec 140 slice 3 (DT5) — `listAudiences`' answer. */
export interface ListAudiencesResult {
  readonly audiences: ReadonlyArray<ResendAudienceSummary>;
  readonly truncated: boolean;
}

/**
 * Summary of a single Resend audience as returned by the `listAudiences`
 * port method. `createdAt` is a parsed `Date` (UTC) — the gateway adapter
 * maps `created_at: string` → `createdAt: Date` at the infrastructure
 * boundary so Application use-cases never parse raw ISO strings.
 */
export type ResendAudienceSummary = {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
};
