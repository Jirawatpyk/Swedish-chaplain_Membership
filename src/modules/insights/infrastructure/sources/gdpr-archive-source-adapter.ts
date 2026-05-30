/**
 * F9 US6 (T090/T091) — `GdprArchiveSource` adapter.
 *
 * Gathers ONE member's personal data for their GDPR archive, composing the four
 * data-source module barrels (members, invoicing, events, broadcasts) + the auth
 * GDPR audit-subset reader — all via PUBLIC BARRELS, no deep
 * imports (Constitution Principle III). Returns `null` when the subject member
 * does not exist for the tenant (the worker maps that to `member_not_found`); an
 * ARCHIVED member still resolves (FR-032a).
 *
 * Curated serialisation: each category is projected to a stable, JSON-safe
 * subset (Money `satang` BigInt → string; Dates → ISO 8601) — never the raw
 * Drizzle/domain object — so the archive shape is deterministic and carries
 * only the member's own data. The audit subset is scoped (member-performed ∪
 * member-targeted) by the bounded reader and redacted by the pure
 * `buildMemberAuditSubset` (third-party PII + internal annotations stripped).
 */
import { buildMembersDeps } from '@/modules/members/members-deps';
import { asMemberId, asTenantId } from '@/modules/members';
import {
  listInvoicesByMember,
  makeListInvoicesByMemberDeps,
  vercelBlobAdapter,
  type Invoice,
} from '@/modules/invoicing';
import {
  getEventAttendeesByMember,
  drizzleEventAttendeesQueryStrict,
} from '@/modules/events';
import { listMemberBroadcasts, makeListMemberBroadcastsDeps } from '@/modules/broadcasts';
import { gdprAuditSubsetReadAdapter } from '@/modules/auth';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import { buildMemberAuditSubset } from '../../application/gdpr-audit-subset';
import type {
  GdprArchiveSource,
  GdprInvoiceEntry,
  GdprMemberData,
} from '../../application/ports/gdpr-archive-source';

/** Defensive caps — the GDPR path is low-volume; bound the blast radius (FR-037). */
const INVOICE_PAGE = 200;
const MAX_INVOICES = 1000;
const MAX_EVENTS = 1000;
const BROADCAST_PAGE = 100;
const MAX_BROADCASTS = 1000;
const MAX_AUDIT_ROWS = 5000;
/** Far-past lower bound so ALL event attendance is included (not the 365-day default). */
const EPOCH_ISO = '2000-01-01T00:00:00.000Z';

function isoOrNull(d: Date | string | null): string | null {
  if (d === null) return null;
  return typeof d === 'string' ? d : d.toISOString();
}

function serialiseInvoiceRecord(inv: Invoice): Record<string, unknown> {
  return {
    invoiceId: String(inv.invoiceId),
    // `documentNumber` is a DocumentNumber CLASS (no toString) — use `.raw` or it
    // serialises to "[object Object]" (security-review F9-US6-03).
    documentNumber: inv.documentNumber === null ? null : inv.documentNumber.raw,
    status: inv.status,
    fiscalYear: inv.fiscalYear === null ? null : Number(inv.fiscalYear),
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    paidAt: inv.paidAt,
    currency: inv.currency,
    subtotalSatang: inv.subtotal ? inv.subtotal.satang.toString() : null,
    vatSatang: inv.vat ? inv.vat.satang.toString() : null,
    totalSatang: inv.total ? inv.total.satang.toString() : null,
  };
}

export const gdprArchiveSourceAdapter: GdprArchiveSource = {
  async gather(
    ctx: TenantContext,
    opts: { readonly subjectMemberId: string },
  ): Promise<GdprMemberData | null> {
    const memberId = asMemberId(opts.subjectMemberId);
    const memberDeps = buildMembersDeps(ctx);

    // 1) Profile — null (not found) short-circuits to member_not_found.
    const memberRes = await memberDeps.memberRepo.findById(ctx, memberId);
    if (!memberRes.ok) return null;
    const member = memberRes.value;

    // 2) Contacts (incl. removed — the member's own data). Derive the set of
    //    linked user accounts for audit scoping. FAIL-LOUD (staff-review C2): a
    //    repo error must NOT degrade to `[]` — that would ship a falsely-complete
    //    archive (empty contacts.json + an under-scoped audit subset, since
    //    memberUserIds derives from contacts) with a valid manifest, violating
    //    FR-037. A genuinely contact-less member still returns ok([]). Mirrors
    //    the invoice list-failure throw below.
    const contactsRes = await memberDeps.contactRepo.listByMember(ctx, memberId, {
      includeRemoved: true,
    });
    if (!contactsRes.ok) {
      throw new Error(`GDPR gather: contacts list failed (${contactsRes.error.code})`);
    }
    const contacts = contactsRes.value;
    const memberUserIds = [
      ...new Set(
        contacts
          .map((c) => c.linkedUserId)
          .filter((id): id is NonNullable<typeof id> => id !== null)
          .map((id) => String(id)),
      ),
    ];

    // 3) Invoices (+ PDF bytes for documented invoices).
    const invoiceDeps = makeListInvoicesByMemberDeps(ctx.slug);
    const invoices: GdprInvoiceEntry[] = [];
    let offset = 0;
    for (;;) {
      const page = await listInvoicesByMember(invoiceDeps, {
        tenantId: ctx.slug,
        memberId: opts.subjectMemberId,
        pageSize: INVOICE_PAGE,
        offset,
        status: 'all',
      });
      if (!page.ok) throw new Error(`GDPR gather: invoice list failed (${page.error.type})`);
      for (const inv of page.value.rows) {
        let pdf: GdprInvoiceEntry['pdf'] = null;
        if (inv.pdf !== null) {
          // The invoice PDF lives in F4's content-addressed Blob; fetch its bytes
          // for the archive. A fetch failure must not silently drop the document —
          // record the reference without bytes (logged) rather than abort the whole
          // archive over one missing PDF.
          try {
            const bytes = await vercelBlobAdapter.downloadBytes(inv.pdf.blobKey);
            // Disambiguate with invoiceId (staff-review I3): two invoices can
            // share a documentNumber (or a draft has none), and the zip entry key
            // `invoices/<filename>` is last-writer-wins — a collision would
            // silently drop a document the member is entitled to. invoiceId is
            // unique, so suffixing it guarantees one entry per invoice.
            // `documentNumber.raw` (NOT the DocumentNumber object) — else the
            // filename becomes "[object Object]-<id>.pdf" (security-review F9-US6-03).
            // Sanitise the zip entry stem (zip-slip / double-extension defence):
            // `documentNumber.raw` is §87-allocator-generated today (no separators),
            // but the entry key `invoices/<filename>` must never be able to escape
            // the `invoices/` prefix or smuggle a path. Collapse anything outside
            // [A-Za-z0-9._-] to `_`; invoiceId (UUID) keeps each entry unique.
            const stem =
              inv.documentNumber !== null
                ? `${inv.documentNumber.raw}-${inv.invoiceId}`
                : inv.invoiceId;
            const filename = `${stem.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`;
            pdf = { filename, bytes };
          } catch (e) {
            logger.warn(
              { errKind: errKind(e), invoiceId: inv.invoiceId, route: 'insights.gdpr-gather' },
              'insights.gdpr_export.invoice_pdf_fetch_failed',
            );
          }
        }
        invoices.push({ record: serialiseInvoiceRecord(inv), pdf });
        if (invoices.length >= MAX_INVOICES) break;
      }
      offset += page.value.rows.length;
      if (
        page.value.rows.length < INVOICE_PAGE ||
        offset >= page.value.total ||
        invoices.length >= MAX_INVOICES
      ) {
        break;
      }
    }

    // 4) Events — all attendance (wide window), fail-loud reader.
    const eventRecords = await getEventAttendeesByMember(
      asTenantId(ctx.slug),
      memberId,
      { sinceIso: EPOCH_ISO, untilIso: new Date().toISOString(), limit: MAX_EVENTS },
      { query: drizzleEventAttendeesQueryStrict },
    );
    const events = eventRecords.map((r) => ({
      eventId: r.eventId,
      eventType: r.eventType,
      attendedAt: r.attendedAt,
    }));

    // 5) Broadcasts the member composed/sent (their own content; curated subset).
    const broadcastDeps = makeListMemberBroadcastsDeps(ctx.slug);
    const broadcasts: Record<string, unknown>[] = [];
    let page = 1;
    for (;;) {
      const list = await listMemberBroadcasts(broadcastDeps, {
        memberId,
        page,
        perPage: BROADCAST_PAGE,
      });
      for (const b of list.rows) {
        broadcasts.push({
          broadcastId: b.broadcastId,
          subject: b.subject,
          status: b.status,
          segmentType: b.segmentType,
          estimatedRecipientCount: b.estimatedRecipientCount,
          submittedAt: isoOrNull(b.submittedAt),
          sentAt: isoOrNull(b.sentAt),
        });
        if (broadcasts.length >= MAX_BROADCASTS) break;
      }
      if (
        list.rows.length < BROADCAST_PAGE ||
        page >= list.totalPages ||
        broadcasts.length >= MAX_BROADCASTS
      ) {
        break;
      }
      page += 1;
    }

    // 6) Audit subset (member-performed ∪ member-targeted) → redacted entries.
    const auditRows = await gdprAuditSubsetReadAdapter.query(ctx, {
      memberUserIds,
      memberId: opts.subjectMemberId,
      limit: MAX_AUDIT_ROWS,
    });
    const auditEvents = buildMemberAuditSubset(
      auditRows.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        summary: r.summary,
        occurredAt: r.occurredAt,
        actorUserId: r.actorUserId,
        targetUserId: r.targetUserId,
        payload: r.payload,
      })),
      { memberUserIds, memberId: opts.subjectMemberId },
    );

    return {
      subjectMemberId: opts.subjectMemberId,
      profile: {
        memberId: member.memberId,
        companyName: member.companyName,
        legalEntityType: member.legalEntityType,
        country: member.country,
        taxId: member.taxId,
        website: member.website,
        description: member.description,
        foundedYear: member.foundedYear,
        planId: member.planId,
        planYear: member.planYear,
        status: member.status,
        registrationDate: isoOrNull(member.registrationDate),
        registrationFeePaid: member.registrationFeePaid,
        createdAt: isoOrNull(member.createdAt),
        updatedAt: isoOrNull(member.updatedAt),
      },
      contacts: contacts.map((c) => ({
        contactId: c.contactId,
        firstName: c.firstName,
        lastName: c.lastName,
        email: String(c.email),
        phone: c.phone === null ? null : String(c.phone),
        roleTitle: c.roleTitle,
        preferredLanguage: c.preferredLanguage,
        isPrimary: c.isPrimary,
        removedAt: isoOrNull(c.removedAt),
        createdAt: isoOrNull(c.createdAt),
      })),
      invoices,
      events,
      broadcasts,
      auditEvents,
    };
  },
};
