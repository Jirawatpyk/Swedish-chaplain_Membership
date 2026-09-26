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
import { type ChangeRequestCursor, type ChangeRequestListRow, type UserId, asMemberId, asTenantId, projectChangeRequestForViewer } from '@/modules/members';
import {
  listInvoicesByMember,
  makeListInvoicesByMemberDeps,
  billFirstDocumentNumber,
  vercelBlobAdapter,
  type Invoice,
} from '@/modules/invoicing';
import {
  getEventAttendeesByMember,
  drizzleEventAttendeesQueryStrict,
} from '@/modules/events';
import {
  listMemberBroadcasts,
  listMemberBroadcastImages,
  listMemberBroadcastVersions,
  makeListMemberBroadcastImagesDeps,
  makeListMemberBroadcastVersionsDeps,
  makeListMemberBroadcastsDeps,
} from '@/modules/broadcasts';
import { gdprAuditSubsetReadAdapter } from '@/modules/auth';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import { buildMemberAuditSubset } from '../../application/gdpr-audit-subset';
import { projectContactsForRequester } from '../../application/gdpr-contact-scope';
import type {
  GdprArchiveSource,
  GdprChangeRequestEntry,
  GdprInvoiceEntry,
  GdprMemberData,
  GdprTruncatableCategory,
} from '../../application/ports/gdpr-archive-source';

/**
 * Defensive caps — the GDPR path is low-volume; bound the blast radius (FR-037).
 * When a cap is hit the NEWEST records are kept and the category is recorded in
 * `completeness.truncatedCategories` so the README + manifest disclose the
 * partial export rather than presenting it as a complete copy (F9 #5).
 */
const INVOICE_PAGE = 200;
const MAX_INVOICES = 1000;
const MAX_EVENTS = 1000;
const BROADCAST_PAGE = 100;
const MAX_BROADCASTS = 1000;
const MAX_BROADCAST_IMAGES = 1000;
const MAX_BROADCAST_VERSION_ROWS = 1000;
const MAX_AUDIT_ROWS = 5000;
const CHANGE_REQUEST_PAGE = 50;
const MAX_CHANGE_REQUESTS = 1000;
/** Far-past lower bound so ALL event attendance is included (not the 365-day default). */
const EPOCH_ISO = '2000-01-01T00:00:00.000Z';

function isoOrNull(d: Date | string | null): string | null {
  if (d === null) return null;
  return typeof d === 'string' ? d : d.toISOString();
}

/**
 * F114 (FR-014 / FR-029 / FR-030) — one change request for the archive:
 * values + per-field outcomes, the reviewer's reason AND note when the row
 * is the REQUESTER's own (both are the submitting person's personal data),
 * the decider as the ORGANISATION — the archive never names a staff member
 * (`decidedByUserId` / the reviewer's display name are dropped). The row
 * arrives already projected for its viewer (`projectChangeRequestForViewer`
 * in the members module — the one FR-029 / FR-014 rule the portal history
 * applies too, review round 1 P-5): a colleague's `mixed` row carries its
 * company fields only, and a row that is not the requester's carries no
 * reason / note.
 */
function serialiseChangeRequest(
  row: ChangeRequestListRow,
  viewerUserId: UserId | null,
): GdprChangeRequestEntry {
  const r = row.request;
  // Art. 15(4) — a colleague's submission is disclosed by name (the business
  // identity the archive already carries), never by their internal contact id.
  const ownSubmission = viewerUserId !== null && String(r.submittedByUserId) === String(viewerUserId);
  return {
    id: r.id,
    scope: r.scope,
    state: r.state,
    outcome: r.outcome,
    withdrawnReason: r.withdrawnReason,
    // NOT NULL in migration 0300, and `ChangeRequest.submittedAt` is a
    // `Date` — so the nullable reader plus an empty-string fallback said
    // a row could arrive without a submission time and the archive would
    // ship `"submittedAt": ""` rather than fail (C3). It cannot; the JSON
    // is byte-identical either way.
    submittedAt: r.submittedAt.toISOString(),
    submittedBy: {
      contactId: ownSubmission ? r.submittedByContactId : null,
      displayName: row.submitter.displayName,
    },
    decidedAt: isoOrNull(r.decidedAt),
    decidedBy: 'organisation',
    decisionReason: r.decisionReason,
    decisionNote: r.decisionNote,
    fields: r.fields.map((f) => ({
      key: f.key,
      target: f.target,
      seen: f.seen,
      proposed: f.proposed,
      outcome: f.outcome,
      appliedAt: isoOrNull(f.appliedAt),
      affectsTaxDocuments: f.affectsTaxDocuments,
    })),
  };
}

function serialiseInvoiceRecord(inv: Invoice): Record<string, unknown> {
  return {
    invoiceId: String(inv.invoiceId),
    // `documentNumber` is a DocumentNumber CLASS (no toString) — use `.raw` or it
    // serialises to "[object Object]" (security-review F9-US6-03).
    documentNumber: inv.documentNumber === null ? null : inv.documentNumber.raw,
    // 088 FR-030 — an 088 invoice's §87 `documentNumber` is NULL; its SC bill
    // number lives in `billDocumentNumberRaw` and (once paid) the §86/4 RC in
    // `receiptDocumentNumberRaw`. Carry both so the archive JSON is complete
    // (GDPR Art. 20 portability) for tax-at-payment rows.
    billDocumentNumberRaw: inv.billDocumentNumberRaw,
    receiptDocumentNumberRaw: inv.receiptDocumentNumberRaw,
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
    opts: {
      readonly subjectMemberId: string;
      readonly requestedByUserId?: string;
      readonly subjectContactId?: string;
    },
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

    // PDPA §30 / GDPR Art. 15 — a staff export for ONE named contact is built
    // for that person (incl. a former contact: the right of access outlives
    // the membership). FAIL-LOUD when the id is not one of this member's
    // contacts: never ship an archive for the wrong person.
    const subjectContact =
      opts.subjectContactId === undefined
        ? null
        : (contacts.find((c) => String(c.contactId) === opts.subjectContactId) ?? null);
    if (opts.subjectContactId !== undefined && subjectContact === null) {
      throw new Error('GDPR gather: the subject contact is not a contact of this member');
    }

    // 3) Invoices (+ PDF bytes for documented invoices).
    const invoiceDeps = makeListInvoicesByMemberDeps(ctx.slug);
    const invoices: GdprInvoiceEntry[] = [];
    let invoiceTotal = 0; // DB total — drives truncation precisely (not `>= cap`).
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
      invoiceTotal = page.value.total;
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
            // 088 FR-030 — bill-first so an 088 bill's PDF is named by its SC
            // (or paid RC) number, not a bare UUID. The `-${invoiceId}` suffix
            // is PRESERVED for zip-entry uniqueness (two invoices can share a
            // number; a draft has none). `documentNumber.raw` (NOT the VO).
            const numberPart =
              billFirstDocumentNumber(inv) ?? inv.receiptDocumentNumberRaw ?? null;
            const stem =
              numberPart !== null ? `${numberPart}-${inv.invoiceId}` : inv.invoiceId;
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

    // 4) Events — all attendance (wide window), fail-loud reader. Over-fetch by
    //    one so a member with EXACTLY MAX_EVENTS is not false-flagged truncated
    //    (Round 2 — #1); keep MAX, flag only on a genuine overflow.
    const eventRecordsRaw = await getEventAttendeesByMember(
      asTenantId(ctx.slug),
      memberId,
      { sinceIso: EPOCH_ISO, untilIso: new Date().toISOString(), limit: MAX_EVENTS + 1 },
      { query: drizzleEventAttendeesQueryStrict },
    );
    const eventsTruncated = eventRecordsRaw.length > MAX_EVENTS;
    const events = eventRecordsRaw.slice(0, MAX_EVENTS).map((r) => ({
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
        // Collect one past the cap (`> MAX`) so exactly-MAX is not false-flagged
        // truncated (Round 2 — #1); the array is trimmed to MAX below.
        if (broadcasts.length > MAX_BROADCASTS) break;
      }
      if (
        list.rows.length < BROADCAST_PAGE ||
        page >= list.totalPages ||
        broadcasts.length > MAX_BROADCASTS
      ) {
        break;
      }
      page += 1;
    }
    const broadcastsTruncated = broadcasts.length > MAX_BROADCASTS;
    if (broadcastsTruncated) broadcasts.length = MAX_BROADCASTS; // trim the probe row

    // 5a) F119 R17 — every image uploaded for those E-Blasts, live AND stamped
    //     (newest first). `listMemberBroadcastImages` already dropped the uploader
    //     (the archive never names a user) and the URL of a stamped image (about
    //     to be reclaimed — not re-published). Over-fetch by one like events.
    const imagesRaw = await listMemberBroadcastImages(makeListMemberBroadcastImagesDeps(ctx.slug), {
      memberId,
      limit: MAX_BROADCAST_IMAGES + 1,
    });
    const broadcastImagesTruncated = imagesRaw.length > MAX_BROADCAST_IMAGES;
    const broadcastImages = imagesRaw.slice(0, MAX_BROADCAST_IMAGES).map((img) => ({
      imageId: img.imageId,
      broadcastId: img.broadcastId,
      contentHash: img.contentHash,
      mimeType: img.mimeType,
      byteSize: img.byteSize,
      createdAt: img.createdAt.toISOString(),
      deletedAt: isoOrNull(img.deletedAt),
      ...(img.blobUrl === undefined ? {} : { blobUrl: img.blobUrl }),
    }));

    // 5a') F119 T083 (R17) — the approval round of each of those E-Blasts: the
    //      versions the member was shown and their decisions, through the
    //      broadcasts module's member projection (no working copy, no staff
    //      identity). The cap applies to each list; the newest rows are kept.
    const versionRounds = await listMemberBroadcastVersions(makeListMemberBroadcastVersionsDeps(ctx.slug), {
      memberId,
      limit: MAX_BROADCAST_VERSION_ROWS,
    });
    const broadcastVersions = versionRounds.threads.map((t) => ({
      broadcastId: t.broadcastId,
      versions: t.versions.map((v) => ({
        versionId: v.id,
        versionNo: v.versionNo,
        authoredBy: v.authoredBy,
        subject: v.subject,
        bodyHtml: v.bodyHtml,
        noteToMember: v.noteToMember,
        sentToMemberAt: isoOrNull(v.sentToMemberAt),
        createdAt: v.createdAt.toISOString(),
      })),
      decisions: t.decisions.map((d) => ({
        decisionId: d.id,
        versionId: d.versionId,
        round: d.round,
        decision: d.decision,
        reason: d.reason,
        decidedAt: d.decidedAt.toISOString(),
      })),
    }));

    // 5b) F114 — change requests (FR-030). Scoped as FR-029 when the requester
    //     is one of the member's linked contacts (their own in full + the
    //     company-level ones as a non-submitter sees them). An ON-BEHALF
    //     request (staff, or any requester who is not a linked contact) gets
    //     the COMPANY-LEVEL history only — `company` / `mixed` rows with their
    //     company fields and no reason / note, never a contact's own-field
    //     request: the artefact is downloadable by whoever requested it and
    //     may be handed to any contact, so it fails CLOSED to what every
    //     contact may see (review round 1, C1). FAIL-LOUD like contacts (a
    //     hollow file would be a falsely-complete archive, F9 FR-037). Every
    //     page is walked (keyset). A requester who is NOT (or no longer) a
    //     linked contact of the member — staff on behalf, or a contact
    //     unlinked between the request and the build — gets the same
    //     company-level scope; the second case is logged, since the member's
    //     own export is then narrower than they asked for (PR review).
    // The VIEWER is the person the archive is for: the named contact of a
    // staff export (their linked account, if any), else the requester when
    // they are a linked contact. The admin who asked is never the viewer.
    let viewerUserId: UserId | null;
    if (subjectContact !== null) {
      viewerUserId = subjectContact.linkedUserId === null ? null : (String(subjectContact.linkedUserId) as UserId);
    } else {
      const requesterIsLinked = opts.requestedByUserId !== undefined && memberUserIds.includes(opts.requestedByUserId);
      if (opts.requestedByUserId !== undefined && !requesterIsLinked) {
        logger.warn(
          { errorId: 'M114.gdpr.requester_not_linked', tenantId: ctx.slug, subjectMemberId: opts.subjectMemberId },
          'gdpr gather: the requester is not a linked contact of the member — change-request history scoped to company level',
        );
      }
      viewerUserId = requesterIsLinked ? (opts.requestedByUserId as UserId) : null;
    }
    const changeRequests: GdprChangeRequestEntry[] = [];
    let crCursor: ChangeRequestCursor | null = null;
    for (;;) {
      const page: Awaited<ReturnType<typeof memberDeps.changeRequestRepo.listByMember>> =
        viewerUserId !== null
          ? await memberDeps.changeRequestRepo.listVisibleToUser(ctx, viewerUserId, memberId, { cursor: crCursor, limit: CHANGE_REQUEST_PAGE })
          : await memberDeps.changeRequestRepo.listByMember(ctx, memberId, { cursor: crCursor, limit: CHANGE_REQUEST_PAGE });
      if (!page.ok) throw new Error(`GDPR gather: change-request list failed (${page.error.code})`);
      for (const row of page.value.items) {
        if (viewerUserId === null && row.request.scope === 'own_contact') continue; // a contact's own request is theirs alone
        changeRequests.push(serialiseChangeRequest(projectChangeRequestForViewer(row, viewerUserId), viewerUserId));
        if (changeRequests.length > MAX_CHANGE_REQUESTS) break; // one probe row past the cap
      }
      crCursor = page.value.nextCursor;
      if (crCursor === null || changeRequests.length > MAX_CHANGE_REQUESTS) break;
    }
    const changeRequestsTruncated = changeRequests.length > MAX_CHANGE_REQUESTS;
    if (changeRequestsTruncated) changeRequests.length = MAX_CHANGE_REQUESTS;

    // 6) Audit subset (member-performed ∪ member-targeted) → redacted entries.
    //    Over-fetch by one so exactly-MAX_AUDIT_ROWS is not false-flagged
    //    truncated (Round 2 — #1); trim to MAX before building the subset.
    //    GDPR Art. 15(4) · PDPA §30 — the actor/target arms match the
    //    REQUESTER's own account only: a colleague's login / session / account
    //    events are that colleague's personal data. Company rows still arrive
    //    via the payload member-id arms; `viewerUserId` strips their free text.
    const auditUserIds = viewerUserId !== null ? [String(viewerUserId)] : [];
    const auditRowsRaw = await gdprAuditSubsetReadAdapter.query(ctx, {
      memberUserIds: auditUserIds,
      memberId: opts.subjectMemberId,
      limit: MAX_AUDIT_ROWS + 1,
    });
    const auditTruncated = auditRowsRaw.length > MAX_AUDIT_ROWS;
    const auditRows = auditRowsRaw.slice(0, MAX_AUDIT_ROWS);
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
      {
        memberUserIds: auditUserIds,
        memberId: opts.subjectMemberId,
        viewerUserId: viewerUserId === null ? null : String(viewerUserId),
      },
    );

    // Completeness disclosure (FR-037 / F9 #5): a category that hit its cap kept
    // only its most-recent N records — flag it so the README + manifest say so.
    // (auditEvents is post-redaction count; the cap is on the read, so test the
    // raw `auditRows` length.)
    // Strict-overflow flags (Round 2 — #1): a category that holds EXACTLY its
    // cap is COMPLETE and must not be flagged. Invoices use the DB total;
    // events/broadcasts/audit over-fetched one probe row above.
    const truncatedCategories: GdprTruncatableCategory[] = [];
    if (invoiceTotal > MAX_INVOICES) truncatedCategories.push('invoices');
    if (eventsTruncated) truncatedCategories.push('events');
    if (broadcastsTruncated) truncatedCategories.push('broadcasts');
    if (broadcastImagesTruncated) truncatedCategories.push('broadcastImages');
    if (versionRounds.truncated) truncatedCategories.push('broadcastVersions');
    if (auditTruncated) truncatedCategories.push('auditEvents');
    if (changeRequestsTruncated) truncatedCategories.push('changeRequests');

    return {
      subjectMemberId: opts.subjectMemberId,
      completeness: { truncatedCategories },
      profile: {
        memberId: member.memberId,
        // 055-member-number — the subject's own human-readable display id.
        // GDPR Art. 15/20 transparency: the member is entitled to see the
        // number we assigned them. Stored as a plain integer (no brand
        // needed here; JSON-serialises as-is, matching portal/admin shape).
        member_number: member.memberNumber,
        companyName: member.companyName,
        legalEntityType: member.legalEntityType,
        country: member.country,
        taxId: member.taxId,
        // P2 Wave-0 — the member's own annual turnover is subject-provided
        // business data; part of Art. 20 portability completeness.
        turnoverThb: member.turnoverThb,
        // 058 / PR-B — ทุนจดทะเบียน. A NEW field, NOT a rename of
        // turnoverThb; likewise subject-provided business data, part of
        // Art. 20 portability completeness.
        registeredCapitalThb: member.registeredCapitalThb,
        // S1-P1-12: postal address (migration 0195) — part of the data
        // subject's profile, required for GDPR Art. 20 portability completeness.
        addressLine1: member.addressLine1,
        addressLine2: member.addressLine2,
        // 058 / PR-B — แขวง/ตำบล, part of the postal address (Art. 20).
        subDistrict: member.subDistrict,
        // member-billing-address (0284) — same Art. 20 completeness class.
        // `?? null` guards the optional aggregate keys (repo rows carry them).
        billingAddressLine1: member.billingAddressLine1 ?? null,
        billingAddressLine2: member.billingAddressLine2 ?? null,
        billingSubDistrict: member.billingSubDistrict ?? null,
        billingCity: member.billingCity ?? null,
        billingProvince: member.billingProvince ?? null,
        billingPostalCode: member.billingPostalCode ?? null,
        billingCountry: member.billingCountry ?? null,
        city: member.city,
        province: member.province,
        postalCode: member.postalCode,
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
      contacts: projectContactsForRequester(
        contacts.map((c) => ({
          contactId: String(c.contactId),
          linkedUserId: c.linkedUserId === null ? null : String(c.linkedUserId),
          firstName: c.firstName,
          lastName: c.lastName,
          email: String(c.email),
          phone: c.phone === null ? null : String(c.phone),
          dateOfBirth: c.dateOfBirth,
          roleTitle: c.roleTitle,
          preferredLanguage: c.preferredLanguage,
          isPrimary: c.isPrimary,
          removedAt: c.removedAt,
          createdAt: c.createdAt,
        })),
        subjectContact !== null
          ? { contactId: String(subjectContact.contactId) }
          : { userId: viewerUserId === null ? null : String(viewerUserId) },
      ),
      subjectContactId: subjectContact === null ? null : String(subjectContact.contactId),
      subjectContactName:
        subjectContact === null
          ? null
          : `${subjectContact.firstName} ${subjectContact.lastName}`.trim(),
      invoices,
      events,
      broadcasts,
      broadcastImages,
      broadcastVersions,
      auditEvents,
      changeRequests,
    };
  },
};
