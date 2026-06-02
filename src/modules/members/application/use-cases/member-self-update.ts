/**
 * `member-self-update` use case — FR-014, FR-014a (T118).
 *
 * Enforces the compile-time whitelist from `portal-self-update-fields.ts`:
 *   - Member fields: website, description
 *   - Contact fields: firstName, lastName, phone, preferredLanguage
 *
 * Any field outside the whitelist in the incoming payload triggers a 403
 * with `member_self_update_forbidden` audit event (FR-014 forged-payload
 * guard). The zod schema is generated FROM the tuple so adding/removing
 * a field is a single-source-change.
 */

import { z } from 'zod';
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { Member, MemberId } from '../../domain/member';
import type { Contact, ContactId, PreferredLanguage } from '../../domain/contact';
import {
  PORTAL_SELF_UPDATE_CONTACT_FIELDS,
  PORTAL_SELF_UPDATE_MEMBER_FIELDS,
  type PortalSelfUpdateContactField,
  type PortalSelfUpdateMemberField,
} from '../../domain/portal-self-update-fields';
import { asPhone } from '../../domain/value-objects/phone';
import type { MemberRepo, MemberPatch, RepoError } from '../ports/member-repo';
import type { ContactRepo, ContactPatch } from '../ports/contact-repo';
import type { AuditPort } from '../ports/audit-port';
import { UseCaseAbort } from '../tx-abort';
import { logger } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Zod schemas generated from the compile-time tuples (FR-014a)
// ---------------------------------------------------------------------------

/**
 * Build a zod object schema whose keys are exactly the whitelist tuple.
 * This is the single source of truth — if the tuple changes, the schema
 * changes automatically. T116 unit test asserts key-set parity.
 */
// W-5: `satisfies` ensures compile-time parity with the tuple —
// adding a field to the tuple without updating the schema is a TS error.
const _contactFields = {
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  phone: z.string().max(16).nullable().optional(), // E.164 max = +15 digits = 16 chars
  preferredLanguage: z.enum(['en', 'th', 'sv']).optional(),
} satisfies Record<PortalSelfUpdateContactField, z.ZodTypeAny>;
const contactFieldsSchema = z.object(_contactFields).strict();

const _memberFields = {
  website: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
} satisfies Record<PortalSelfUpdateMemberField, z.ZodTypeAny>;
const memberFieldsSchema = z.object(_memberFields).strict();

// S-1: .strict() rejects unknown keys if the schema is used standalone
// (defence-in-depth — primary guard is detectForbiddenFields).
export const selfUpdateSchema = z.object({
  primary_contact: contactFieldsSchema.optional(),
  website: memberFieldsSchema.shape.website,
  description: memberFieldsSchema.shape.description,
}).strict();

/** Exported for T116 key-set parity assertion. */
export const SELF_UPDATE_CONTACT_SCHEMA_KEYS = Object.keys(
  contactFieldsSchema.shape,
).sort() as string[];

export const SELF_UPDATE_MEMBER_SCHEMA_KEYS = Object.keys(
  memberFieldsSchema.shape,
).sort() as string[];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemberSelfUpdateInput = {
  readonly memberId: MemberId;
  readonly contactId: ContactId;
  readonly rawBody: Record<string, unknown>;
  readonly actorUserId: string;
  readonly requestId: string;
};

export type MemberSelfUpdateError =
  | { type: 'not_found' }
  | { type: 'forbidden'; reason: string }
  | { type: 'validation_error'; issues: z.ZodIssue[] }
  | { type: 'server_error'; message: string };

export type MemberSelfUpdateDeps = {
  readonly tenant: TenantContext;
  readonly memberRepo: MemberRepo;
  readonly contactRepo: ContactRepo;
  readonly audit: AuditPort;
};

// ---------------------------------------------------------------------------
// Whitelist enforcement
// ---------------------------------------------------------------------------

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  ...PORTAL_SELF_UPDATE_MEMBER_FIELDS,
  'primary_contact',
]);

const ALLOWED_CONTACT_KEYS = new Set<string>(
  PORTAL_SELF_UPDATE_CONTACT_FIELDS,
);

/**
 * Returns forbidden field names if ANY key in the raw body is not in the
 * whitelist. This catches forged payloads that include `plan_id`, `status`,
 * `tax_id`, etc.
 */
function detectForbiddenFields(
  raw: Record<string, unknown>,
): string[] {
  const forbidden: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      forbidden.push(key);
    }
  }
  const contactObj = raw['primary_contact'];
  if (contactObj && typeof contactObj === 'object' && contactObj !== null) {
    for (const key of Object.keys(contactObj)) {
      if (!ALLOWED_CONTACT_KEYS.has(key)) {
        forbidden.push(`primary_contact.${key}`);
      }
    }
  }
  return forbidden;
}

/** Map a repo load error to the use-case error union (P3.2 — drops the cast). */
function mapRepoLoadError(error: RepoError): MemberSelfUpdateError {
  if (error.code === 'repo.not_found') return { type: 'not_found' };
  return { type: 'server_error', message: error.code };
}

/**
 * P2 Wave-0 — sentinel thrown when the in-tx FOR-UPDATE re-read finds the member
 * archived (a concurrent archive raced the pre-tx ownership read). Caught in the
 * outer catch and mapped to `forbidden`; rolls the (empty-so-far) tx back.
 */
class MemberArchivedAbort extends Error {}

// ---------------------------------------------------------------------------
// Use case
// ---------------------------------------------------------------------------

export async function memberSelfUpdate(
  deps: MemberSelfUpdateDeps,
  input: MemberSelfUpdateInput,
): Promise<
  Result<{ member: Member; contact: Contact }, MemberSelfUpdateError>
> {
  // 1. Detect forbidden fields BEFORE parsing — reject forged payloads
  const forbidden = detectForbiddenFields(input.rawBody);
  if (forbidden.length > 0) {
    // W-4: Audit the forgery attempt (FR-014). The forged payload is rejected
    // (403) REGARDLESS of audit success — an audit-write failure here is logged
    // (so SREs can detect an un-audited forgery attempt) but never opens the
    // request. The security outcome is fail-closed on the mutation; only the
    // audit row is best-effort.
    const auditResult = await deps.audit.record(deps.tenant, {
      type: 'member_self_update_forbidden',
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      summary: `forged fields: ${forbidden.join(', ')}`,
      payload: {
        member_id: input.memberId,
        attempted_fields: forbidden,
      },
    });
    if (!auditResult.ok) {
      logger.error(
        { requestId: input.requestId, memberId: input.memberId },
        'member-self-update: audit write failed on forgery path',
      );
    }
    return err({
      type: 'forbidden',
      reason: `forbidden fields: ${forbidden.join(', ')}`,
    });
  }

  // 2. Parse the whitelisted payload
  const parsed = selfUpdateSchema.safeParse(input.rawBody);
  if (!parsed.success) {
    return err({
      type: 'validation_error',
      issues: parsed.error.issues,
    });
  }

  // 3. Load existing member + own contact to verify ownership (reads, pre-tx)
  const memberResult = await deps.memberRepo.findById(
    deps.tenant,
    input.memberId,
  );
  if (!memberResult.ok) return err(mapRepoLoadError(memberResult.error));

  // B-1: Verify contactId belongs to this member — prevents IDOR
  const contactCheck = await deps.contactRepo.findById(
    deps.tenant,
    input.contactId,
  );
  if (!contactCheck.ok) return err(mapRepoLoadError(contactCheck.error));
  if (contactCheck.value.memberId !== input.memberId) {
    return err({
      type: 'forbidden',
      reason: 'contact does not belong to this member',
    });
  }

  const data = parsed.data;
  const fieldsChanged: string[] = [];

  // 4. Build the member patch (website/description).
  // B-3: Pass null directly — do NOT coerce to undefined (Drizzle skips undefined)
  const mutableMemberPatch: Record<string, unknown> = {};
  if (data.website !== undefined) {
    mutableMemberPatch.website = data.website;
    fieldsChanged.push('website');
  }
  if (data.description !== undefined) {
    mutableMemberPatch.description = data.description;
    fieldsChanged.push('description');
  }
  const memberPatch = mutableMemberPatch as MemberPatch;
  const hasMemberPatch = Object.keys(mutableMemberPatch).length > 0;

  // 5. Build the contact patch. Phone is re-validated HERE (pre-tx) so a bad
  //    phone fails fast with validation_error before a transaction is opened.
  let contactPatch: ContactPatch | null = null;
  if (data.primary_contact) {
    const mutableContactPatch: Record<string, unknown> = {};
    const pc = data.primary_contact;

    if (pc.firstName !== undefined) {
      mutableContactPatch.firstName = pc.firstName;
      fieldsChanged.push('firstName');
    }
    if (pc.lastName !== undefined) {
      mutableContactPatch.lastName = pc.lastName;
      fieldsChanged.push('lastName');
    }
    if (pc.phone !== undefined) {
      if (pc.phone === null) {
        mutableContactPatch.phone = null;
      } else {
        const phoneResult = asPhone(pc.phone);
        if (!phoneResult.ok) {
          return err({
            type: 'validation_error',
            issues: [{
              code: 'custom',
              path: ['primary_contact', 'phone'],
              message: `invalid phone: ${phoneResult.error.code}`,
            }],
          });
        }
        mutableContactPatch.phone = phoneResult.value;
      }
      fieldsChanged.push('phone');
    }
    // S-2: zod z.enum(['en','th','sv']) already validates preferredLanguage —
    // the isPreferredLanguage guard was redundant dead code post-parse.
    if (pc.preferredLanguage !== undefined) {
      mutableContactPatch.preferredLanguage = pc.preferredLanguage as PreferredLanguage;
      fieldsChanged.push('preferredLanguage');
    }
    if (Object.keys(mutableContactPatch).length > 0) {
      contactPatch = mutableContactPatch as ContactPatch;
    }
  }

  // 6. No-op short-circuit — nothing to persist, nothing to audit.
  if (fieldsChanged.length === 0) {
    return ok({ member: memberResult.value, contact: contactCheck.value });
  }

  // 7. H2 — persist member + contact + BOTH audit events in ONE transaction
  //    (throw-to-rollback). Previously the member-field write, the contact
  //    write, and the `member_self_updated` audit were three separate,
  //    non-atomic phases: a contact failure left a committed member change,
  //    and an audit failure left the change with NO audit row (Principle VIII
  //    gap, surfaced only as a warn). Now it is all-or-nothing.
  try {
    const persisted = await runInTenant(deps.tenant, async (tx) => {
      // P2 Wave-0 — re-read the member FOR UPDATE inside the tx and re-assert it
      // is not archived. The ownership/IDOR reads above are PRE-tx; a concurrent
      // archive between them and these writes would otherwise let a portal member
      // mutate a now-archived member, bypassing the archived-immutability
      // invariant that inline-edit enforces (inline-edit.ts § archived guard).
      const fresh = await deps.memberRepo.findByIdInTx(tx, input.memberId);
      if (!fresh.ok) throw new UseCaseAbort<RepoError>(fresh.error);
      if (fresh.value.status === 'archived') throw new MemberArchivedAbort();
      // `member`/`contact` are the echoed return values; `updateFieldsInTx` /
      // `updateInTx` overwrite them with the freshly-written rows below. The FOR
      // UPDATE re-read above is the guard — we only need its status here.
      let member = memberResult.value;
      let contact = contactCheck.value;

      if (hasMemberPatch) {
        const r = await deps.memberRepo.updateFieldsInTx(
          tx,
          input.memberId,
          memberPatch,
        );
        if (!r.ok) throw new UseCaseAbort<RepoError>(r.error);
        member = r.value;
      }

      if (contactPatch) {
        const r = await deps.contactRepo.updateInTx(
          tx,
          input.contactId,
          contactPatch,
        );
        if (!r.ok) throw new UseCaseAbort<RepoError>(r.error);
        contact = r.value;

        const a = await deps.audit.recordInTx(tx, deps.tenant, {
          type: 'contact_updated',
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          summary: `contact_updated ${input.contactId}`,
          payload: {
            member_id: r.value.memberId,
            contact_id: input.contactId,
            fields_changed: Object.keys(contactPatch),
          },
        });
        if (!a.ok) throw new UseCaseAbort<RepoError>(a.error);
      }

      // Overarching self-update audit — now transactional; a failure rolls
      // back the whole self-update rather than committing it audit-less.
      const selfAudit = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_self_updated',
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        summary: `self-updated: ${fieldsChanged.join(', ')}`,
        payload: {
          member_id: input.memberId,
          contact_id: input.contactId,
          fields_changed: fieldsChanged,
        },
      });
      if (!selfAudit.ok) throw new UseCaseAbort<RepoError>(selfAudit.error);

      return { member, contact };
    });

    return ok({ member: persisted.member, contact: persisted.contact });
  } catch (e) {
    if (e instanceof MemberArchivedAbort) {
      // Concurrent archive won the race — refuse the self-update (the member is
      // now immutable). 403 forbidden, consistent with the archived-immutability
      // invariant.
      return err({
        type: 'forbidden',
        reason: 'member is archived and can no longer be edited',
      });
    }
    if (e instanceof UseCaseAbort) {
      const re = e.error as RepoError;
      return err({ type: 'server_error', message: `self update: ${re.code}` });
    }
    return err({
      type: 'server_error',
      message: `self update: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
