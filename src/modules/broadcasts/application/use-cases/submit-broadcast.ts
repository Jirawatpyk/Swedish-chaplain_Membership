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
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { PlansBridgePort } from '../ports/plans-bridge-port';
import type { EmailValidatorPort } from '../ports/email-validator-port';
import type { EventAttendeesRepository } from '../ports/event-attendees-repository';
import type { MarketingUnsubscribesRepo } from '../ports/marketing-unsubscribes-repo';
import type { RateLimiterPort } from '../ports/rate-limiter-port';
import { sanitizeHtml } from './sanitize-html';
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

/** Helper: emit a precondition-rejection audit on a standalone tx. */
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
      { memberId: input.memberId },
    );
    if (!quota.ok) {
      await emitReject(deps, input, 'broadcast_quota_blocked', {
        memberId: input.memberId,
        reason: quota.error.kind,
      });
      return err({ kind: 'broadcast_quota_blocked', used: 0, reserved: 0, cap: 0 });
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
    await emitReject(deps, input, 'broadcast_subject_too_long', {
      memberId: input.memberId,
      length: 0,
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

  // Non-blocking: orphan members → emit per-orphan audit
  for (const orphanMemberId of resolved.value.orphans) {
    await emitReject(
      deps,
      { ...input, memberId: orphanMemberId },
      'broadcast_member_missing_primary_contact_email',
      {
        memberId: orphanMemberId,
        triggeredBySubmissionFromMember: input.memberId,
      },
    );
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
