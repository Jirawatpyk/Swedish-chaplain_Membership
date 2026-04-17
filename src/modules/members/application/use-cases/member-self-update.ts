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
    // W-4: Audit the forgery attempt (FR-014) — fail-closed if audit fails
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

  // 3. Load existing member to verify ownership
  const memberResult = await deps.memberRepo.findById(
    deps.tenant,
    input.memberId,
  );
  if (!memberResult.ok) {
    return err({
      type: memberResult.error.code === 'repo.not_found' ? 'not_found' : 'server_error',
      ...(memberResult.error.code !== 'repo.not_found' && {
        message: memberResult.error.code,
      }),
    } as MemberSelfUpdateError);
  }

  // B-1: Verify contactId belongs to this member — prevents IDOR
  const contactCheck = await deps.contactRepo.findById(
    deps.tenant,
    input.contactId,
  );
  if (!contactCheck.ok) {
    return err({
      type: contactCheck.error.code === 'repo.not_found' ? 'not_found' : 'server_error',
      ...(contactCheck.error.code !== 'repo.not_found' && {
        message: contactCheck.error.code,
      }),
    } as MemberSelfUpdateError);
  }
  if (contactCheck.value.memberId !== input.memberId) {
    return err({
      type: 'forbidden',
      reason: 'contact does not belong to this member',
    });
  }

  const data = parsed.data;
  const fieldsChanged: string[] = [];

  // 4. Update member fields if any changed
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

  let updatedMember = memberResult.value;
  if (Object.keys(mutableMemberPatch).length > 0) {
    const updateResult = await deps.memberRepo.updateFields(
      deps.tenant,
      input.memberId,
      memberPatch,
    );
    if (!updateResult.ok) {
      return err({
        type: 'server_error',
        message: `member update: ${updateResult.error.code}`,
      });
    }
    updatedMember = updateResult.value;
  }

  // 5. Update contact fields if any changed
  let updatedContact: Contact | null = null;
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
    const contactPatch = mutableContactPatch as ContactPatch;

    if (Object.keys(mutableContactPatch).length > 0) {
      // S1 + W1 — contact update + per-contact audit atomic via throw-
      // to-rollback. `return err(...)` inside the tx would commit the
      // update without the audit; only `throw` triggers Drizzle rollback.
      try {
        const updatedRow = await runInTenant(deps.tenant, async (tx) => {
          const updated = await deps.contactRepo.updateInTx(
            tx,
            input.contactId,
            contactPatch,
          );
          if (!updated.ok) throw new UseCaseAbort<RepoError>(updated.error);

          const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
            type: 'contact_updated',
            actorUserId: input.actorUserId,
            requestId: input.requestId,
            summary: `contact_updated ${input.contactId}`,
            payload: {
              member_id: updated.value.memberId,
              contact_id: input.contactId,
              fields_changed: Object.keys(contactPatch),
            },
          });
          if (!auditResult.ok)
            throw new UseCaseAbort<RepoError>(auditResult.error);

          return updated.value;
        });
        updatedContact = updatedRow;
      } catch (e) {
        if (e instanceof UseCaseAbort) {
          const re = e.error as RepoError;
          return err({
            type: 'server_error',
            message: `contact update: ${re.code}`,
          });
        }
        return err({
          type: 'server_error',
          message: 'contact update: unexpected',
        });
      }
    }
  }

  // 6. Audit the self-update — W-4: check result and log on failure
  if (fieldsChanged.length > 0) {
    const auditResult = await deps.audit.record(deps.tenant, {
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
    if (!auditResult.ok) {
      logger.warn(
        { requestId: input.requestId, memberId: input.memberId },
        'member-self-update: audit write failed on success path',
      );
    }
  }

  // R2-W3: Reuse the contact loaded by the B-1 ownership check
  // instead of a redundant DB round-trip.
  if (!updatedContact) {
    updatedContact = contactCheck.value;
  }

  return ok({ member: updatedMember, contact: updatedContact });
}
