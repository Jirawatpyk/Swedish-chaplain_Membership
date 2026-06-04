/**
 * Task 6b (054-event-fee-invoices) — create-event-invoice-draft use case (F4).
 *
 * Creates a DRAFT event-fee invoice for a member OR non-member attendee,
 * keyed to an F6 `event_registrations` row. Mirrors `create-invoice-draft`
 * (the membership path) but with the event-fee specifics:
 *
 *  - **Model B (VAT-inclusive, do NOT split at draft):** the single
 *    `event_fee` line stores the VAT-INCLUSIVE total (the all-in ticket
 *    price the attendee paid), `quantity='1.0000'`. The invoice
 *    `subtotal`/`vat`/`total` stay NULL at draft — identical to the
 *    membership draft. The VAT split happens at ISSUE (a later task), not
 *    here. `ticketPriceThb` from the F6 lookup is integer whole THB → × 100
 *    for satang. Rationale (design §3c): storing the ex-VAT subtotal and
 *    re-deriving VAT at issue yields ~6.5% off-by-1-satang total
 *    mismatches; storing the inclusive amount and splitting at issue is
 *    exact.
 *
 *  - **Buyer snapshot:**
 *      * MATCHED member (`reg.matchedMemberId !== null`) — the buyer is the
 *        F3 member; the snapshot is pinned at ISSUE (FR-038, like
 *        membership), so this draft carries `memberId` + a null snapshot.
 *        The §86/4 company tax-id gate runs here on the live member data so
 *        it can't be bypassed by going straight to issue.
 *      * NON-MEMBER attendee — there is NO member record to re-read at
 *        issue, so the manually-entered buyer identity is captured into the
 *        `member_identity_snapshot` AT DRAFT and persisted via
 *        `insertDraft({ memberIdentitySnapshot })`.
 *
 * Tenant isolation (Principle I): all reads run on the `tx` opened by
 * `invoiceRepo.withTx` (→ `runInTenant` → `SET LOCAL app.current_tenant`),
 * so RLS scopes the F6 registration + event + F3 member reads to the
 * caller's tenant. A cross-tenant registration is RLS-hidden → the lookup
 * returns `ok(null)` → we emit a `registration_cross_tenant_probe` audit
 * (clause 4) and return `registration_not_found`.
 *
 * RBAC: admin only — enforced at the route handler.
 */
import { err, ok, type Result } from '@/lib/result';
import { isUniqueViolation, errorChainMessage } from '@/lib/db-errors';
import { z } from 'zod';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { EventRegistrationLookupPort } from '../ports/event-registration-lookup-port';
import type { EventDetailsLookupPort } from '../ports/event-details-lookup-port';
import type { MemberIdentityPort } from '../ports/member-identity-port';
import type {
  AuditPort,
  F4NonTimelineEventType,
} from '../ports/audit-port';
import {
  asInvoiceId,
  MAX_EVENT_INVOICE_SATANG,
  type Invoice,
  type InvoiceId,
} from '@/modules/invoicing/domain/invoice';
import {
  asInvoiceLineId,
  makeInvoiceLine,
  type InvoiceLine,
} from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import {
  makeMemberIdentitySnapshot,
  InvalidMemberIdentitySnapshotError,
  type MemberIdentitySnapshot,
} from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';

/**
 * The partial unique index on `invoices` that prevents two non-void event
 * invoices for the same `(tenant_id, event_registration_id)` pair. Named
 * here so the outer catch can narrow a generic 23505 to THIS index only —
 * a future unique constraint on a different column also raising 23505 inside
 * `insertDraft` would otherwise be mislabeled as `duplicate`.
 */
const EVENT_REGISTRATION_UNIQ_INDEX = 'invoices_event_registration_uniq';

export const createEventInvoiceDraftSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  eventRegistrationId: z.string().uuid(),
  /**
   * VAT-INCLUSIVE override in satang. Bounded to MAX_EVENT_INVOICE_SATANG
   * (1,000,000.00 THB) as defense-in-depth — the route handler zod bounds
   * the same value. `.int().min(1)` rejects 0 / negative / fractional.
   */
  amountOverride: z.number().int().min(1).max(MAX_EVENT_INVOICE_SATANG).optional(),
  /**
   * Non-member buyer identity (manual entry). Omitted for a matched member
   * (the buyer comes from F3). `tax_id` is `^\d{13}$` or null (Thai TIN);
   * an empty contact email is accepted (the snapshot contract allows it).
   */
  buyer: z
    .object({
      legal_name: z.string().min(1).max(500),
      tax_id: z
        .string()
        .regex(/^\d{13}$/)
        .nullable(),
      address: z.string().min(1).max(1000),
      primary_contact_name: z.string(),
      primary_contact_email: z.union([z.string().email(), z.literal('')]),
    })
    .optional(),
});

export type CreateEventInvoiceDraftInput = z.infer<typeof createEventInvoiceDraftSchema>;

export type CreateEventInvoiceDraftError =
  | { code: 'lookup_failed' }
  | { code: 'registration_not_found' }
  | { code: 'attendee_erased' }
  | { code: 'no_fee_free_event' }
  | { code: 'invalid_amount' }
  | { code: 'buyer_required' }
  | { code: 'invalid_tax_id_format' }
  | { code: 'invalid_buyer_snapshot' }
  | { code: 'event_not_found' }
  | { code: 'duplicate' };

export interface CreateEventInvoiceDraftDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly eventRegistrationLookup: EventRegistrationLookupPort;
  readonly eventDetailsLookup: EventDetailsLookupPort;
  readonly memberIdentity: MemberIdentityPort;
  readonly audit: AuditPort;
  readonly newUuid: () => string;
}

/**
 * Emit `invoice_draft_created` for a NON-member event invoice through the
 * NON-timeline `F4AuditEvent` branch (no `member_id` in the payload).
 *
 * `invoice_draft_created` is declared in `F4MemberTimelineAuditEventType`, so
 * the `AuditPort.emit` discriminated union would otherwise force a
 * `member_id: string` payload. A non-member event buyer has no F3 member id,
 * and per the design decision (§3f / NF-A) we must NOT widen
 * `MemberTimelineAuditPayload` to make `member_id` optional (that would
 * silently weaken the F3-timeline `member_id` guarantee for the 5 membership
 * events). This helper is the single, audited escape: it constructs the event
 * and casts it to the non-timeline branch so the persisted payload carries NO
 * `member_id` key — the F3 timeline filter (`payload->>'member_id'`) then
 * correctly never surfaces a non-member event draft. The matched-member event
 * draft path does NOT use this helper (it emits with a real `member_id` on the
 * timeline branch).
 */
async function emitNonTimelineDraftCreated(
  audit: AuditPort,
  tx: unknown,
  event: {
    readonly tenantId: string;
    readonly requestId: string | null;
    readonly actorUserId: string;
    readonly summary: string;
    readonly payload: Record<string, unknown>;
  },
): Promise<void> {
  await audit.emit(tx, {
    tenantId: event.tenantId,
    requestId: event.requestId,
    // deliberate: emit a timeline-typed event through the non-timeline payload
    // branch for non-member events (no member_id); MemberTimelineAuditPayload
    // intentionally NOT widened. The runtime adapter is event-type-agnostic;
    // only the compile-time payload contract differs. `as unknown as
    // F4NonTimelineEventType` makes the bypass explicit (a plain `as
    // Exclude<…>` would silently skip the payload check since invoice_draft_created
    // IS in F4MemberTimelineAuditEventType and Exclude resolves to `never` for it).
    eventType: 'invoice_draft_created' as unknown as F4NonTimelineEventType,
    actorUserId: event.actorUserId,
    summary: event.summary,
    payload: event.payload,
  });
}

export async function createEventInvoiceDraft(
  deps: CreateEventInvoiceDraftDeps,
  input: CreateEventInvoiceDraftInput,
): Promise<Result<Invoice, CreateEventInvoiceDraftError>> {
  // The partial unique index `invoices_event_registration_uniq` raises a
  // 23505 on a second non-void event invoice for the same registration. We
  // CANNOT catch that inside `withTx` and continue — a constraint violation
  // poisons the Postgres transaction (any later statement, incl. the
  // implicit COMMIT, fails with "current transaction is aborted"). So we let
  // the 23505 propagate OUT of `withTx` (rolling the tx back cleanly) and
  // translate it to the typed `duplicate` error here.
  try {
    return await deps.invoiceRepo.withTx(async (tx) => {
      // 1. Read the F6 event registration under the caller's tenant RLS.
      const regResult = await deps.eventRegistrationLookup.findById(
        tx,
        input.tenantId,
        input.eventRegistrationId,
      );
      if (!regResult.ok) return err({ code: 'lookup_failed' });
      if (regResult.value === null) {
        // RLS-hidden cross-tenant row OR genuine miss — audit either way
        // (Constitution Principle I clause 4). Non-timeline payload: no
        // member_id is available (we never resolved a buyer).
        await deps.audit.emit(tx, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'registration_cross_tenant_probe',
          actorUserId: input.actorUserId,
          summary: `Probe on event registration ${input.eventRegistrationId} (not found on event-invoice draft)`,
          payload: {
            event_registration_id: input.eventRegistrationId,
            actor_role: 'admin',
            route: 'create-event-invoice-draft',
          },
        });
        return err({ code: 'registration_not_found' });
      }
      const reg = regResult.value;

      // 2. Refuse drafting a fee invoice against a retention-purged attendee.
      if (reg.pseudonymised) return err({ code: 'attendee_erased' });

      // 3. Resolve the VAT-INCLUSIVE amount in satang (Model B — line carries
      // the all-in price; no VAT split at draft). `ticketPriceThb` is integer
      // whole THB → × 100. zod already bounds an explicit override; we
      // defensively bound the ticket-price-derived value too.
      // ticketPriceThb is whole THB (integer stored by F6); × 100 → satang.
      const inclusiveSatang =
        input.amountOverride ?? (reg.ticketPriceThb === null ? null : reg.ticketPriceThb * 100);
      if (inclusiveSatang === null || inclusiveSatang <= 0) {
        return err({ code: 'no_fee_free_event' });
      }
      if (inclusiveSatang > MAX_EVENT_INVOICE_SATANG) {
        return err({ code: 'invalid_amount' });
      }

      // 4. Read event details for the line description (event name + CE date).
      const eventResult = await deps.eventDetailsLookup.findById(tx, input.tenantId, reg.eventId);
      if (!eventResult.ok) return err({ code: 'lookup_failed' });
      if (eventResult.value === null) return err({ code: 'event_not_found' });
      const event = eventResult.value;
      // CE date in Asia/Bangkok local time (BE is display-only — the renderer
      // converts at presentation). Using bangkokLocalDate avoids the UTC-vs-
      // Bangkok off-by-one on a tax document: an event at 23:00 UTC = 06:00
      // Bangkok next day would render the wrong calendar date on the PDF if
      // we sliced the raw ISO string.
      const ceDate = bangkokLocalDate(event.startDateIso);

      // 5. Resolve the buyer.
      //    - matched member → buyer is the F3 member; snapshot pinned at ISSUE
      //      (null here).
      //    - non-member → manual buyer; snapshot pinned at DRAFT.
      //
      // 054-event-fee-invoices Task 9 — EVENTS do NOT block on a missing buyer
      // TIN. The §86/4 doc-type model resolves a TIN-less event buyer to a §105
      // ใบเสร็จรับเงิน (receipt) at ISSUE rather than a full ใบกำกับภาษี — the
      // event ticket was already paid, so a receipt is legally valid. The old
      // matched-company-null-tax_id `tax_id_required` gate is therefore REMOVED
      // here (it only applied to MEMBERSHIP invoices, where issue-invoice still
      // enforces it). A matched company member with no TIN is a rare data
      // anomaly that now yields a receipt rather than blocking — acceptable per
      // the ruling. (`invalid_tax_id_format` below is a DIFFERENT guard — it
      // rejects a malformed non-null manual tax_id, not an absent one.)
      let memberId: string | null;
      let buyerSnapshot: MemberIdentitySnapshot | null;

      if (reg.matchedMemberId !== null) {
        const member = await deps.memberIdentity.getForIssue(
          tx,
          input.tenantId,
          reg.matchedMemberId,
        );
        // A matched member id that no longer resolves (archived-purge race or a
        // dangling match) — treat as a not-found path. The error union carries
        // no `member_not_found`; the registration is effectively un-billable.
        if (!member) return err({ code: 'registration_not_found' });

        memberId = reg.matchedMemberId;
        buyerSnapshot = null; // pinned at issue
      } else {
        // Non-member — the manual buyer object is REQUIRED.
        if (!input.buyer) return err({ code: 'buyer_required' });
        // Pre-check tax_id format explicitly (zod's regex already rejects a
        // malformed non-null value, but a route bypassing the schema would
        // not — defense-in-depth + a precise typed error).
        if (input.buyer.tax_id !== null && !/^\d{13}$/.test(input.buyer.tax_id)) {
          return err({ code: 'invalid_tax_id_format' });
        }
        try {
          buyerSnapshot = makeMemberIdentitySnapshot({
            legal_name: input.buyer.legal_name,
            tax_id: input.buyer.tax_id ?? null,
            address: input.buyer.address,
            primary_contact_name: input.buyer.primary_contact_name,
            primary_contact_email: input.buyer.primary_contact_email,
          });
        } catch (e) {
          if (e instanceof InvalidMemberIdentitySnapshotError) {
            return err({ code: 'invalid_buyer_snapshot' });
          }
          throw e;
        }
        memberId = null;
      }

      // 6. Build the single event_fee line — Model B: unitPrice = the
      // VAT-INCLUSIVE satang, quantity 1, no pro-rate.
      const lineResult = makeInvoiceLine({
        lineId: asInvoiceLineId(deps.newUuid()),
        kind: 'event_fee',
        descriptionTh: `ค่าเข้าร่วมงาน ${event.name} (${ceDate})`,
        descriptionEn: `Event: ${event.name} (${ceDate})`,
        unitPrice: Money.fromSatangUnsafe(BigInt(inclusiveSatang)),
        quantity: '1.0000',
        proRateFactor: null,
        position: 1,
      });
      if (!lineResult.ok) {
        // Unreachable: the event_fee line construction cannot fail for this
        // fixed input (non-empty localised descriptions, quantity '1.0000',
        // positive unitPrice, no membership pro-rate rule). If we ever reach
        // here a Domain invariant has drifted — throw rather than surfacing
        // an internal error shape through the typed error union.
        throw new Error('createEventInvoiceDraft: event_fee line construction failed unexpectedly');
      }
      const lines: InvoiceLine[] = [lineResult.value];

      // 7. Persist the draft. A `invoices_event_registration_uniq` violation
      // (a non-void event invoice already exists for this registration) is
      // raised as a 23505; we DELIBERATELY do NOT catch it here — a constraint
      // violation aborts the surrounding Postgres tx, so the only safe move is
      // to let it propagate out of `withTx` (clean rollback) and translate it
      // to `duplicate` in the OUTER catch.
      const invoiceId: InvoiceId = asInvoiceId(deps.newUuid());
      const invoice = await deps.invoiceRepo.insertDraft(tx, {
        tenantId: input.tenantId,
        invoiceId,
        memberId,
        planId: null,
        planYear: null,
        invoiceSubject: 'event',
        eventId: reg.eventId,
        eventRegistrationId: input.eventRegistrationId,
        vatInclusive: true,
        draftByUserId: input.actorUserId,
        autoEmailOnIssue: null,
        memberIdentitySnapshot: buyerSnapshot,
        lines,
      });

      // 8. Audit `invoice_draft_created`. Branch on member presence (design
      // §3f / NF-A):
      //    - matched member → TIMELINE payload (member_id present → surfaces
      //      in the member's F3 timeline via `payload->>'member_id'`);
      //    - non-member (memberId null) → NON-timeline payload (NO member_id).
      //      The buyer is not an F3 member, so the timeline filter MUST NOT
      //      surface it — omitting member_id is the correct behaviour. We do
      //      NOT widen `MemberTimelineAuditPayload` (audit-port.ts) per the
      //      design decision; instead we narrow the event at THIS one call
      //      site to the non-timeline `F4AuditEvent` branch via the
      //      `emitNonTimeline` helper below. (`invoice_draft_created` is a
      //      member-timeline event type, so the discriminated union otherwise
      //      requires member_id — the cast is the documented escape for the
      //      no-member event-fee variant.)
      if (memberId === null) {
        await emitNonTimelineDraftCreated(deps.audit, tx, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          actorUserId: input.actorUserId,
          summary: `Event-fee draft invoice created for registration ${input.eventRegistrationId}`,
          payload: {
            invoice_id: invoiceId,
            event_registration_id: input.eventRegistrationId,
            event_id: reg.eventId,
            invoice_subject: 'event',
          },
        });
      } else {
        await deps.audit.emit(tx, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'invoice_draft_created',
          actorUserId: input.actorUserId,
          summary: `Event-fee draft invoice created for member ${memberId} (registration ${input.eventRegistrationId})`,
          payload: {
            invoice_id: invoiceId,
            member_id: memberId,
            event_registration_id: input.eventRegistrationId,
            event_id: reg.eventId,
            invoice_subject: 'event',
          },
        });
      }

      return ok(invoice);
    });
  } catch (e) {
    // Translate the `invoices_event_registration_uniq` violation to the typed
    // `duplicate` error (a 409 at the route). The constraint-name check ensures
    // we only swallow THIS index's 23505 — a future unique constraint on a
    // different column would still propagate as an unexpected 500.
    if (isUniqueViolation(e) && errorChainMessage(e).includes(EVENT_REGISTRATION_UNIQ_INDEX)) {
      return err({ code: 'duplicate' });
    }
    throw e;
  }
}
