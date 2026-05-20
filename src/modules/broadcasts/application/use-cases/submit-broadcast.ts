/**
 * T069 — `submit-broadcast.ts` Application use-case (F7).
 *
 * **100% branch coverage required** per Constitution Principle II
 * (security-critical: every FR-002 precondition a–k surfaces a typed
 * error code + audit emission).
 *
 * Pipeline (FR-002 preconditions in CHEAP → EXPENSIVE order; the letters
 * map to the FR-002 sub-clauses, not pipeline order):
 *   k. halt flag → broadcast_member_halted_pending_review
 *   d. rate limit → broadcast_rate_limit_exceeded
 *   a. plan check → broadcast_not_in_plan
 *   b. quota → broadcast_quota_blocked  (admin_proxy bypasses per Q12)
 *   j. reply-to → broadcast_member_missing_primary_contact_email
 *   c. subject length → broadcast_subject_too_long
 *   e. sanitiser → broadcast_body_unsafe_html (catches sanitiser-throw
 *      OR empty-after-strip) / sanitizer_unavailable → 500 (review I3)
 *   f. body size → broadcast_body_too_large
 *   h. custom validate → broadcast_custom_recipient_unknown / invalid format
 *   g+i. segment resolve → broadcast_empty_segment_blocked /
 *      broadcast_audience_too_large; orphans emit
 *      broadcast_member_missing_primary_contact_email (non-blocking)
 *
 * Atomic insert + transition + audit in `runInTenant + withTx`. Failure
 * rolls back the row insert AND the audit row (Constitution Principle I
 * clause 3).
 *
 * Each precondition rejection emits the corresponding audit event via a
 * standalone tx (`tx=null`) so the rejection trail is visible even when
 * no broadcast row is inserted.
 */
import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '@/lib/result';
import { broadcastsMetrics } from '@/lib/metrics';
import { asMemberId } from '@/modules/members';
import type { TenantContext } from '@/modules/tenants';
import {
  asBroadcastId,
  type Broadcast,
  type BroadcastActorRole,
} from '../../domain/broadcast';
import type { RecipientSegment } from '../../domain/recipient-segment';
import {
  unsafeBrandEmailLower,
  type EmailLower,
} from '../../domain/value-objects/email-lower';
import type { AuditPort, F7AuditEventType } from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { HtmlSanitizerPort } from '../ports/html-sanitizer-port';
import type { ImageAllowlistPort } from '../ports/image-allowlist-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { PlansBridgePort } from '../ports/plans-bridge-port';
import type { EmailValidatorPort } from '../ports/email-validator-port';
import type { EventAttendeesRepository } from '../ports/event-attendees-repository';
import type { MarketingUnsubscribesRepo } from '../ports/marketing-unsubscribes-repo';
import type { RateLimiterPort } from '../ports/rate-limiter-port';
import { sanitizeHtml } from './sanitize-html';
import { validateImageSourceAllowlist } from './validate-image-source-allowlist';
import { validateCustomRecipients } from './validate-custom-recipients';
import { resolveSegmentRecipients } from './resolve-segment-recipients';
import { computeQuotaCounter } from './compute-quota-counter';

const MAX_SUBJECT_LENGTH = 200;
const SUBMIT_RATE_LIMIT = 10;
const SUBMIT_RATE_WINDOW_SECONDS = 86_400;
const REVIEW_SLA_TARGET_HOURS = 48;

export type SubmitBroadcastError =
  | { readonly kind: 'broadcast_member_halted_pending_review'; readonly memberId: string }
  | {
      readonly kind: 'broadcast_rate_limit_exceeded';
      readonly retryAfterSeconds: number;
    }
  | { readonly kind: 'broadcast_not_in_plan'; readonly memberId: string }
  | {
      readonly kind: 'broadcast_quota_blocked';
      readonly used: number;
      readonly reserved: number;
      readonly cap: number;
    }
  | {
      readonly kind: 'broadcast_member_missing_primary_contact_email';
      readonly memberId: string;
    }
  | {
      readonly kind: 'broadcast_subject_too_long';
      readonly length: number;
    }
  | { readonly kind: 'broadcast_subject_empty' }
  | { readonly kind: 'broadcast_body_too_large'; readonly bytes: number }
  | { readonly kind: 'broadcast_body_unsafe_html'; readonly reason: string }
  // PR-review fix 2026-05-20 UX-C1 — F7.1a US2 FR-011 + AS2 closure.
  // `validateImageSourceAllowlist` is invoked AFTER sanitizeHtml +
  // BEFORE persistence; non-allowlisted <img src> hosts surface here
  // with the full accumulated list so the compose UI can highlight
  // every offender at once (spec FR-011 UX requirement).
  | {
      readonly kind: 'broadcast_body_image_source_unsafe';
      readonly unsafeImageSources: ReadonlyArray<string>;
    }
  | {
      readonly kind: 'broadcast_custom_recipient_unknown';
      readonly unresolved: ReadonlyArray<string>;
    }
  | {
      readonly kind: 'broadcast_custom_recipient_invalid_format';
      readonly invalid: ReadonlyArray<string>;
    }
  | {
      readonly kind: 'broadcast_custom_recipient_empty';
    }
  | {
      readonly kind: 'broadcast_custom_recipient_too_many';
      readonly count: number;
    }
  | { readonly kind: 'broadcast_empty_segment_blocked' }
  | {
      readonly kind: 'broadcast_audience_too_large';
      readonly count: number;
      readonly cap: number;
    }
  | { readonly kind: 'submit.server_error'; readonly message: string };

export interface SubmitBroadcastDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly sanitizer: HtmlSanitizerPort;
  /**
   * PR-review fix 2026-05-20 UX-C1 — F7.1a US2 source-allowlist
   * validation runs after sanitiser, before persistence. Production
   * composition root (`makeSubmitBroadcastDeps`) always wires it.
   *
   * Kept optional (`?`) for back-compat with existing fixtures (10+
   * fixture sites in `tests/integration/broadcasts/halt-flag-
   * precondition.test.ts` + `tests/unit/broadcasts/application/proxy-
   * submit-broadcast.test.ts`). Round-4 R4-L2 originally proposed
   * tightening to required; reverted on 2026-05-21 because the
   * change cascades to those 10+ fixture sites for marginal safety
   * gain (the existing route handlers + `makeSubmitBroadcastDeps`
   * always wire the port; the type-level optionality only matters
   * inside test fixtures that override the use-case directly).
   * When omitted the validation step is SKIPPED (legacy F7 MVP
   * behaviour: <img> stripped entirely by sanitiser anyway).
   */
  readonly imageAllowlistPort?: ImageAllowlistPort;
  readonly membersBridge: MembersBridgePort;
  readonly plansBridge: PlansBridgePort;
  readonly emailValidator: EmailValidatorPort;
  readonly eventAttendees: EventAttendeesRepository;
  readonly marketingUnsubscribes: MarketingUnsubscribesRepo;
  readonly rateLimiter: RateLimiterPort;
  readonly audit: AuditPort;
  readonly clock: { now(): Date };
}

export interface SubmitBroadcastInput {
  readonly memberId: string;
  readonly submittedByUserId: string;
  readonly actorRole: Exclude<BroadcastActorRole, 'system'>;
  /** Optional pre-existing draft id (compose flow). When omitted, a fresh broadcast id is minted. */
  readonly draftId?: string;
  readonly tenantDisplayName: string;
  readonly subject: string;
  readonly bodySource: string;
  readonly bodyHtml: string;
  readonly segment: RecipientSegment;
  readonly scheduledFor: Date | null;
  readonly requestId: string | null;
}

export interface SubmitBroadcastOutput {
  readonly broadcast: Broadcast;
  readonly broadcastId: string;
  readonly submittedAt: Date;
  readonly estimatedRecipientCount: number;
  readonly reservedQuotaSlot: true;
  readonly reviewSlaTargetHours: number;
}

/**
 * T172 (Phase 9) — map F7 audit event type to the bounded
 * `submit_precondition_blocked` enum used by the submit-funnel
 * counter. Returning `null` for non-precondition events skips the
 * metric emission (e.g. `broadcast_submitted` on the success path
 * is counted by `submitCount` instead).
 *
 * Round 5 simplification — switch replaced with a const lookup table.
 * `satisfies Partial<Record<…, …>>` lets TS verify every key is a
 * valid `F7AuditEventType` and the union of values still matches the
 * bounded precondition enum without the 11-line return-type literal.
 * Adding a new precondition is one line, not three.
 */
type SubmitPrecondition =
  | 'quota_exhausted'
  | 'empty_segment'
  | 'rate_limit_exceeded'
  | 'plan_no_eblast'
  | 'subject_too_long'
  | 'body_too_large'
  | 'body_unsafe_html'
  // PR-review fix 2026-05-21 R4-H4 — F7.1a US2 image-source rejection
  // surfaces on the submit-funnel SLO-F7-002 dashboard. Was missed by
  // Phase A wiring; on-call could not see image-allowlist probe spikes.
  | 'body_image_source_unsafe'
  | 'audience_too_large'
  | 'custom_recipient_unknown'
  | 'member_missing_primary_contact_email'
  | 'member_halted_pending_review';

const PRECONDITION_BY_EVENT = {
  broadcast_quota_blocked: 'quota_exhausted',
  broadcast_empty_segment_blocked: 'empty_segment',
  broadcast_rate_limit_exceeded: 'rate_limit_exceeded',
  broadcast_not_in_plan: 'plan_no_eblast',
  broadcast_subject_too_long: 'subject_too_long',
  broadcast_subject_empty: 'subject_too_long', // R6 W-R3 — both length-violations share the same precondition bucket
  broadcast_body_too_large: 'body_too_large',
  broadcast_body_unsafe_html: 'body_unsafe_html',
  // R4-H4 — image-source allowlist rejection (Phase A FR-011 wiring)
  broadcast_body_image_source_unsafe: 'body_image_source_unsafe',
  broadcast_audience_too_large: 'audience_too_large',
  broadcast_custom_recipient_unknown: 'custom_recipient_unknown',
  broadcast_member_missing_primary_contact_email:
    'member_missing_primary_contact_email',
  broadcast_member_halted_pending_review: 'member_halted_pending_review',
} as const satisfies Partial<Record<F7AuditEventType, SubmitPrecondition>>;

/** Helper: emit a precondition-rejection audit on a standalone tx. */
function preconditionFromEvent(
  eventType: F7AuditEventType,
): SubmitPrecondition | null {
  return (
    (PRECONDITION_BY_EVENT as Partial<Record<F7AuditEventType, SubmitPrecondition>>)[
      eventType
    ] ?? null
  );
}

async function emitReject(
  deps: SubmitBroadcastDeps,
  input: SubmitBroadcastInput,
  eventType: F7AuditEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.audit.emit(null, {
      tenantId: deps.tenant.slug,
      eventType,
      actorUserId: input.submittedByUserId,
      summary: `Submit rejected (${eventType}) for member ${input.memberId}`,
      payload,
      requestId: input.requestId,
    });
  } catch {
    // Best-effort audit. Failure does not 5xx the request — but this is
    // logged at adapter level for observability.
  }
  // T172 — emit submit-funnel drop-off metric. Bounded enum keeps
  // cardinality small. Wrapped in a no-throw safe-metric helper so a
  // single OTel pipeline glitch doesn't fail the use-case.
  const precondition = preconditionFromEvent(eventType);
  if (precondition !== null) {
    broadcastsMetrics.submitPreconditionBlocked(deps.tenant.slug, precondition);
  }
  broadcastsMetrics.auditEmitCount(deps.tenant.slug, eventType);
}

export async function submitBroadcast(
  deps: SubmitBroadcastDeps,
  input: SubmitBroadcastInput,
): Promise<Result<SubmitBroadcastOutput, SubmitBroadcastError>> {
  // ---- Precondition (k): halt flag ---------------------------------
  const haltedMembers = await deps.membersBridge.getMembersHaltedInTenant(
    deps.tenant,
  );
  if (haltedMembers.some((h) => h.memberId === input.memberId)) {
    await emitReject(deps, input, 'broadcast_member_halted_pending_review', {
      memberId: input.memberId,
    });
    return err({
      kind: 'broadcast_member_halted_pending_review',
      memberId: input.memberId,
    });
  }

  // ---- Precondition (d, FR-002d): rate limit -----------------------
  const rateKey = `broadcasts:submit:${deps.tenant.slug}:${input.memberId}`;
  const rateCheck = await deps.rateLimiter.checkLimit(
    rateKey,
    SUBMIT_RATE_LIMIT,
    SUBMIT_RATE_WINDOW_SECONDS,
  );
  if (!rateCheck.ok) {
    await emitReject(deps, input, 'broadcast_rate_limit_exceeded', {
      memberId: input.memberId,
      retryAfterSeconds: rateCheck.error.retryAfterSeconds,
    });
    return err({
      kind: 'broadcast_rate_limit_exceeded',
      retryAfterSeconds: rateCheck.error.retryAfterSeconds,
    });
  }

  // ---- Precondition (a): plan / entitlement ------------------------
  const planLookup = await deps.plansBridge.getPlanForMember(
    deps.tenant,
    input.memberId,
  );
  if (!planLookup.ok) {
    await emitReject(deps, input, 'broadcast_not_in_plan', {
      memberId: input.memberId,
      reason: planLookup.error.kind,
    });
    return err({
      kind: 'broadcast_not_in_plan',
      memberId: input.memberId,
    });
  }

  // ---- Precondition (b): quota -------------------------------------
  // admin_proxy bypasses quota per Q12 (admin emergency correction path)
  if (input.actorRole !== 'admin_proxy') {
    const quota = await computeQuotaCounter(
      {
        tenant: deps.tenant,
        plansBridge: deps.plansBridge,
        broadcastsRepo: deps.broadcastsRepo,
        clock: deps.clock,
      },
      { memberId: asMemberId(input.memberId) },
    );
    if (!quota.ok) {
      // Round-4 MED-D — counter internal error (DB blip) is NOT
      // "quota full". Returning fake `quota_blocked` collapses the
      // distinction and wrongly maps to 422 (user fault). Surface as
      // 500 server_error so ops dashboards can split rate-limited
      // submissions from infra-induced rejections.
      return err({
        kind: 'submit.server_error',
        message: `quota_counter_error: ${quota.error.kind}`,
      });
    }
    if (quota.value.counter.remaining === 0) {
      await emitReject(deps, input, 'broadcast_quota_blocked', {
        memberId: input.memberId,
        ...quota.value.counter,
      });
      return err({
        kind: 'broadcast_quota_blocked',
        used: quota.value.counter.used,
        reserved: quota.value.counter.reserved,
        cap: quota.value.counter.cap,
      });
    }
  }

  // ---- Precondition (j): reply-to derivation -----------------------
  const replyTo = await deps.membersBridge.getMemberPrimaryContact(
    deps.tenant,
    input.memberId,
  );
  if (replyTo === null) {
    await emitReject(
      deps,
      input,
      'broadcast_member_missing_primary_contact_email',
      { memberId: input.memberId },
    );
    return err({
      kind: 'broadcast_member_missing_primary_contact_email',
      memberId: input.memberId,
    });
  }

  // ---- Precondition (c): subject length ----------------------------
  const trimmedSubject = input.subject.trim();
  if (trimmedSubject.length === 0) {
    // R6 staff-review W-R3 fix — audit event type now matches the
    // Result kind. Previously emitted `broadcast_subject_too_long`
    // with `length:0` while the Result returned
    // `broadcast_subject_empty`, so audit-log queries and on-wire
    // error codes diverged for the same rejection. Adding
    // `broadcast_subject_empty` to F7_AUDIT_EVENT_TYPES and emitting
    // it here aligns the two surfaces (count bumped 42→43).
    await emitReject(deps, input, 'broadcast_subject_empty', {
      memberId: input.memberId,
      length: 0,
      reason: 'empty_after_trim',
    });
    return err({ kind: 'broadcast_subject_empty' });
  }
  if (trimmedSubject.length > MAX_SUBJECT_LENGTH) {
    await emitReject(deps, input, 'broadcast_subject_too_long', {
      memberId: input.memberId,
      length: trimmedSubject.length,
    });
    return err({
      kind: 'broadcast_subject_too_long',
      length: trimmedSubject.length,
    });
  }

  // ---- Precondition (e + d): sanitiser + size cap ------------------
  const sanitised = sanitizeHtml(
    { sanitizer: deps.sanitizer },
    { rawHtml: input.bodyHtml },
  );
  if (!sanitised.ok) {
    if (sanitised.error.kind === 'sanitizer_unavailable') {
      // Infra fault, NOT user-content fault. Surface as 500 internal_error.
      // sanitize-html.ts already logged the underlying reason at error level.
      return err({
        kind: 'submit.server_error',
        message: `sanitizer_unavailable: ${sanitised.error.reason}`,
      });
    }
    const eventType: F7AuditEventType =
      sanitised.error.kind === 'broadcast_body_too_large'
        ? 'broadcast_body_too_large'
        : 'broadcast_body_unsafe_html';
    await emitReject(deps, input, eventType, {
      memberId: input.memberId,
      ...(sanitised.error.kind === 'broadcast_body_too_large'
        ? { bytes: sanitised.error.bytes }
        : { reason: sanitised.error.reason }),
    });
    return err(sanitised.error);
  }

  // ---- Precondition (e2): image-source allowlist (F7.1a US2) -------
  // PR-review fix 2026-05-20 UX-C1 — runs on the SANITISED body so
  // any <img src=non-http(s)> already had its src stripped by the
  // DOMPurify hook. Surviving <img src> hosts must match the tenant's
  // allowlist (FR-011). Rejection accumulates ALL unsafe srcs so the
  // editor can highlight every offender at once (FR-011 UX).
  // emit-site logs `broadcast_body_image_source_unsafe` via
  // safeAuditEmit (fail-soft).
  if (deps.imageAllowlistPort) {
    const imageCheck = await validateImageSourceAllowlist(
      {
        allowlistPort: deps.imageAllowlistPort,
        audit: deps.audit,
      },
      {
        bodyHtml: sanitised.value.sanitisedHtml,
        tenantId: deps.tenant.slug as never,
        actorUserId: input.submittedByUserId,
        requestId: input.requestId ?? 'submit-broadcast',
      },
    );
    if (!imageCheck.ok) {
      // No emitReject() here — validateImageSourceAllowlist already
      // emitted `broadcast_body_image_source_unsafe` via its own
      // safeAuditEmit (fail-soft). emitReject would double-audit.
      //
      // PR-review fix 2026-05-21 R4-H4 — wire submit-funnel counter so
      // image-source rejections appear on the SLO-F7-002 dashboard.
      // Direct call (not via emitReject which would double-audit).
      broadcastsMetrics.submitPreconditionBlocked(
        deps.tenant.slug,
        'body_image_source_unsafe',
      );
      return err({
        kind: 'broadcast_body_image_source_unsafe',
        unsafeImageSources: imageCheck.error.unsafeImageSources,
      });
    }
  }

  // ---- Precondition (h): custom-list validation --------------------
  let customRecipients: ReadonlyArray<EmailLower> | null = null;
  if (input.segment.kind === 'custom') {
    const validated = await validateCustomRecipients(
      {
        tenant: deps.tenant,
        emailValidator: deps.emailValidator,
        membersBridge: deps.membersBridge,
        eventAttendees: deps.eventAttendees,
      },
      { raw: input.segment.emails },
    );
    if (!validated.ok) {
      // Round-4 MED-B — server_error from the lookup loop maps to
      // submit-level server_error so the route returns 500 instead of
      // a misleading 422.
      if (validated.error.kind === 'validate_custom.server_error') {
        return err({
          kind: 'submit.server_error',
          message: `validate_custom_recipients_failed: ${validated.error.message}`,
        });
      }
      await emitReject(deps, input, 'broadcast_custom_recipient_unknown', {
        memberId: input.memberId,
        ...validated.error,
      });
      return err(validated.error);
    }
    customRecipients = validated.value.normalised;
  }

  // ---- Preconditions (f, g, i): segment resolve --------------------
  const resolved = await resolveSegmentRecipients(
    {
      tenant: deps.tenant,
      membersBridge: deps.membersBridge,
      eventAttendees: deps.eventAttendees,
      marketingUnsubscribes: deps.marketingUnsubscribes,
    },
    {
      segment: input.segment,
      requestingMemberPrimaryEmail: unsafeBrandEmailLower(replyTo as string),
      customRecipients,
    },
  );
  if (!resolved.ok) {
    const eventType: F7AuditEventType =
      resolved.error.kind === 'broadcast_audience_too_large'
        ? 'broadcast_audience_too_large'
        : 'broadcast_empty_segment_blocked';
    await emitReject(deps, input, eventType, {
      memberId: input.memberId,
      segmentKind: input.segment.kind,
      ...(resolved.error.kind === 'broadcast_audience_too_large'
        ? { count: resolved.error.count, cap: resolved.error.cap }
        : {}),
    });
    return err(resolved.error);
  }

  // Non-blocking: orphan members → emit per-orphan audit (round-4 HIGH-B
  // — cap at 50 to prevent submit-budget breach when orphan list grows;
  // truncation summary preserves audit trail when exceeded). Parallelize
  // via Promise.all so 50 INSERTs land in <100ms instead of sequential
  // 50× DB roundtrip cost.
  const ORPHAN_AUDIT_CAP = 50;
  const orphans = resolved.value.orphans;
  const reportedOrphans = orphans.slice(0, ORPHAN_AUDIT_CAP);
  await Promise.all(
    reportedOrphans.map((orphanMemberId) =>
      emitReject(
        deps,
        { ...input, memberId: orphanMemberId },
        'broadcast_member_missing_primary_contact_email',
        {
          memberId: orphanMemberId,
          triggeredBySubmissionFromMember: input.memberId,
        },
      ),
    ),
  );
  if (orphans.length > ORPHAN_AUDIT_CAP) {
    await emitReject(deps, input, 'member_missing_primary_contact', {
      truncated: true,
      totalOrphans: orphans.length,
      reported: ORPHAN_AUDIT_CAP,
      triggeredBySubmissionFromMember: input.memberId,
    });
  }

  // ---- Atomic persist: insert(draft) → transition(submitted) → audit ----
  const now = deps.clock.now();
  const broadcastId = asBroadcastId(input.draftId ?? randomUUID());
  const fromName = input.tenantDisplayName;

  try {
    return await deps.broadcastsRepo.withTx(async (tx) => {
      let broadcast: Broadcast;
      const existing =
        input.draftId === undefined
          ? null
          : await deps.broadcastsRepo.findByIdInTx(
              tx,
              deps.tenant.slug,
              broadcastId,
            );

      if (existing === null) {
        // Create row directly (no separate draft step)
        broadcast = await deps.broadcastsRepo.insertDraft(tx, {
          tenantId: deps.tenant.slug,
          broadcastId,
          requestedByMemberId: input.memberId,
          requestedByMemberPlanIdSnapshot: planLookup.value.planId,
          submittedByUserId: input.submittedByUserId,
          actorRole: input.actorRole,
          subject: trimmedSubject,
          bodyHtml: sanitised.value.sanitisedHtml,
          bodySource: input.bodySource,
          fromName,
          replyToEmail: replyTo as string,
          segmentType: input.segment.kind === 'tier'
            ? 'tier'
            : input.segment.kind,
          segmentParams:
            input.segment.kind === 'tier'
              ? { tierCodes: input.segment.tierCodes }
              : null,
          customRecipientEmails: customRecipients
            ? customRecipients.map((e) => e as string)
            : null,
          estimatedRecipientCount: resolved.value.estimatedCount,
          scheduledFor: input.scheduledFor,
        });
      } else if (existing.status !== 'draft') {
        return err({
          kind: 'submit.server_error',
          message: `cannot submit broadcast ${broadcastId} in status ${existing.status}`,
        });
      } else {
        // Update existing draft with sanitised content + estimated count
        broadcast = await deps.broadcastsRepo.updateDraft(
          tx,
          deps.tenant.slug,
          broadcastId,
          {
            subject: trimmedSubject,
            bodyHtml: sanitised.value.sanitisedHtml,
            bodySource: input.bodySource,
            fromName,
            replyToEmail: replyTo as string,
            segmentType:
              input.segment.kind === 'tier' ? 'tier' : input.segment.kind,
            segmentParams:
              input.segment.kind === 'tier'
                ? { tierCodes: input.segment.tierCodes }
                : null,
            customRecipientEmails: customRecipients
              ? customRecipients.map((e) => e as string)
              : null,
            estimatedRecipientCount: resolved.value.estimatedCount,
            scheduledFor: input.scheduledFor,
          },
        );
      }

      // Apply transition draft → submitted with submittedAt timestamp
      broadcast = await deps.broadcastsRepo.applyTransition(
        tx,
        deps.tenant.slug,
        broadcastId,
        'submitted',
        {
          submittedAt: now,
          estimatedRecipientCount: resolved.value.estimatedCount,
        },
        'draft', // R4 Types-#5 — race-guard
      );

      // Atomic audit emit (same tx)
      await deps.audit.emit(tx, {
        tenantId: deps.tenant.slug,
        eventType: 'broadcast_submitted',
        actorUserId: input.submittedByUserId,
        summary: `Member ${input.memberId} submitted broadcast ${broadcastId}`,
        payload: {
          broadcastId,
          memberId: input.memberId,
          actorRole: input.actorRole,
          segmentType: input.segment.kind,
          estimatedRecipientCount: resolved.value.estimatedCount,
          submittedAt: now.toISOString(),
        },
        requestId: input.requestId,
      });

      // T172 — emit-site wiring (Phase 9). Counter + audit-volume per
      // SC-010 / SLO-F7-002 dashboards. Duration histogram emitted by
      // the route handler around this use-case (wallclock includes the
      // sanitiser + segment-resolve dominant components).
      broadcastsMetrics.submitCount(
        deps.tenant.slug,
        input.actorRole === 'admin_proxy' ? 'admin_proxy' : 'member_self_service',
      );
      broadcastsMetrics.auditEmitCount(deps.tenant.slug, 'broadcast_submitted');

      return ok({
        broadcast,
        broadcastId: broadcastId as string,
        submittedAt: now,
        estimatedRecipientCount: resolved.value.estimatedCount,
        reservedQuotaSlot: true as const,
        reviewSlaTargetHours: REVIEW_SLA_TARGET_HOURS,
      });
    });
  } catch (e) {
    return err({
      kind: 'submit.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }
}
