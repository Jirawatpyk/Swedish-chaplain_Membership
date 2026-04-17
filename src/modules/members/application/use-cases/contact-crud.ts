/**
 * Contact CRUD use cases (T083 + T084, US3 FR-011).
 *
 * Four use cases bundled in one file because they share the same deps
 * shape and error types:
 *
 *   - addContact         — insert a new contact (non-primary by default)
 *   - updateContactFields — edit non-email fields (email change is US3.b)
 *   - removeContact      — soft-delete (removed_at = NOW)
 *   - promotePrimary     — demote current + promote target atomically
 *
 * Email changes route through the separate `change-contact-email.ts`
 * use case (US3.b) because they require a 6-step atomic transaction
 * with session revocation + dual-channel notification.
 *
 * The primary-contact invariant (FR-003) is enforced at the DB layer
 * by the `contacts_one_primary_per_member` partial unique index; the
 * `promotePrimary` use case demotes BEFORE promoting to avoid a
 * partial-index collision, and maps the residual race condition to
 * `repo.conflict` (→ 409 in the API route).
 */

import { z } from 'zod';
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import { asPhone } from '../../domain/value-objects/phone';
import { asEmail } from '../../domain/value-objects/email';
import type { TenantContext } from '@/modules/tenants';
import type { Contact, ContactId } from '../../domain/contact';
import { asTenantId } from '../../domain/member';
import type { MemberId } from '../../domain/member';
import type { Phone } from '../../domain/value-objects/phone';
import type { AuditPort } from '../ports/audit-port';
import type { ContactRepo } from '../ports/contact-repo';
import type { RepoError } from '../ports/member-repo';
import { UseCaseAbort } from '../tx-abort';

// --- Schemas -----------------------------------------------------------------

export const addContactSchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  email: z.string().trim().min(1).max(254),
  phone: z.string().max(20).nullable().optional(),
  role_title: z.string().max(100).nullable().optional(),
  preferred_language: z.enum(['en', 'th', 'sv']).default('en'),
  date_of_birth: z.string().nullable().optional(),
});

export const updateContactFieldsSchema = z
  .object({
    first_name: z.string().trim().min(1).max(100).optional(),
    last_name: z.string().trim().min(1).max(100).optional(),
    phone: z.string().max(20).nullable().optional(),
    role_title: z.string().max(100).nullable().optional(),
    preferred_language: z.enum(['en', 'th', 'sv']).optional(),
  })
  .strict();

// --- Errors ------------------------------------------------------------------

export type ContactCrudError =
  | {
      type: 'invalid_body';
      issues: ReadonlyArray<{ path: string; message: string }>;
    }
  | { type: 'invalid_email' }
  | { type: 'invalid_phone' }
  | { type: 'not_found' }
  | { type: 'conflict'; reason: string }
  | { type: 'cannot_remove_primary' }
  | { type: 'server_error'; message: string };

// --- Deps --------------------------------------------------------------------

export type ContactCrudDeps = {
  tenant: TenantContext;
  contactRepo: ContactRepo;
  audit: AuditPort;
  idFactory: { contactId(): ContactId };
};

export type ContactCrudCallMeta = {
  actorUserId: string;
  requestId: string;
};

// --- add ---------------------------------------------------------------------

export async function addContact(
  memberId: MemberId,
  input: unknown,
  meta: ContactCrudCallMeta,
  deps: ContactCrudDeps,
): Promise<Result<Contact, ContactCrudError>> {
  const parsed = addContactSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      type: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const data = parsed.data;

  const email = asEmail(data.email);
  if (!email.ok) return err({ type: 'invalid_email' });

  let phone: Phone | null = null;
  if (data.phone) {
    const r = asPhone(data.phone);
    if (!r.ok) return err({ type: 'invalid_phone' });
    phone = r.value;
  }

  const contactId = deps.idFactory.contactId();
  try {
    const contact = await runInTenant(deps.tenant, async (tx) => {
      const added = await deps.contactRepo.addInTx(tx, {
        tenantId: asTenantId(deps.tenant.slug),
        contactId,
        memberId,
        firstName: data.first_name.trim(),
        lastName: data.last_name.trim(),
        email: email.value,
        phone,
        roleTitle: data.role_title ?? null,
        preferredLanguage: data.preferred_language,
        isPrimary: false,
        dateOfBirth: data.date_of_birth ? new Date(data.date_of_birth) : null,
        linkedUserId: null,
        removedAt: null,
      });
      // W1: throw-to-rollback — a `return err(...)` here would commit
      // the (non-existent) writes; only `throw` triggers Drizzle tx
      // rollback. Pattern mirrors archive-member.ts + change-plan.ts.
      if (!added.ok) throw new UseCaseAbort<RepoError>(added.error);

      const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'contact_created',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `contact_created for member ${memberId}`,
        payload: {
          member_id: memberId,
          contact_id: added.value.contactId,
          is_primary: added.value.isPrimary,
        },
      });
      // W1: rollback the `addInTx` row if audit write fails — keeps
      // state + audit atomic (Principle VIII audit-with-state).
      if (!auditResult.ok) throw new UseCaseAbort<RepoError>(auditResult.error);

      return added.value;
    });
    return ok(contact);
  } catch (e) {
    if (e instanceof UseCaseAbort) {
      const re = e.error as RepoError;
      if (re.code === 'repo.conflict')
        return err({ type: 'conflict', reason: re.reason });
      return err({ type: 'server_error', message: `add: ${re.code}` });
    }
    return err({ type: 'server_error', message: 'add: unexpected' });
  }
}

// --- update ------------------------------------------------------------------

export async function updateContactFields(
  memberId: MemberId,
  contactId: ContactId,
  input: unknown,
  meta: ContactCrudCallMeta,
  deps: ContactCrudDeps,
): Promise<Result<Contact, ContactCrudError>> {
  const parsed = updateContactFieldsSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      type: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const data = parsed.data;

  type MutableContact = { -readonly [K in keyof Contact]?: Contact[K] };
  const draft: MutableContact = {};
  if (data.first_name !== undefined) draft.firstName = data.first_name.trim();
  if (data.last_name !== undefined) draft.lastName = data.last_name.trim();
  if (data.phone !== undefined) {
    if (data.phone === null) {
      draft.phone = null;
    } else {
      const r = asPhone(data.phone);
      if (!r.ok) return err({ type: 'invalid_phone' });
      draft.phone = r.value;
    }
  }
  if (data.role_title !== undefined) draft.roleTitle = data.role_title;
  if (data.preferred_language !== undefined)
    draft.preferredLanguage = data.preferred_language;
  const patch = draft as Partial<Contact>;

  // Ownership check: verify contactId belongs to memberId (SEC-3 IDOR guard)
  const existing = await deps.contactRepo.findById(deps.tenant, contactId);
  if (!existing.ok) {
    if (existing.error.code === 'repo.not_found')
      return err({ type: 'not_found' });
    return err({ type: 'server_error', message: `lookup: ${existing.error.code}` });
  }
  if (existing.value.memberId !== memberId) {
    return err({ type: 'not_found' });
  }

  try {
    const contact = await runInTenant(deps.tenant, async (tx) => {
      const updated = await deps.contactRepo.updateInTx(tx, contactId, patch);
      if (!updated.ok) throw new UseCaseAbort<RepoError>(updated.error);

      const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'contact_updated',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `contact_updated ${contactId}`,
        payload: {
          member_id: updated.value.memberId,
          contact_id: contactId,
          fields_changed: Object.keys(patch),
        },
      });
      if (!auditResult.ok) throw new UseCaseAbort<RepoError>(auditResult.error);

      return updated.value;
    });
    return ok(contact);
  } catch (e) {
    if (e instanceof UseCaseAbort) {
      const re = e.error as RepoError;
      if (re.code === 'repo.not_found') return err({ type: 'not_found' });
      return err({ type: 'server_error', message: `update: ${re.code}` });
    }
    return err({ type: 'server_error', message: 'update: unexpected' });
  }
}

// --- remove ------------------------------------------------------------------

export async function removeContact(
  memberId: MemberId,
  contactId: ContactId,
  meta: ContactCrudCallMeta,
  deps: ContactCrudDeps,
): Promise<Result<Contact, ContactCrudError>> {
  // Pre-check: refuse to remove a primary. Caller must promote another
  // contact first. This is a UX contract (FR-003) — the partial unique
  // index + Domain invariant is a secondary defence.
  const existing = await deps.contactRepo.findById(deps.tenant, contactId);
  if (!existing.ok) {
    if (existing.error.code === 'repo.not_found')
      return err({ type: 'not_found' });
    return err({
      type: 'server_error',
      message: `lookup: ${existing.error.code}`,
    });
  }
  if (existing.value.memberId !== memberId) {
    return err({ type: 'not_found' });
  }
  if (existing.value.isPrimary)
    return err({ type: 'cannot_remove_primary' });

  try {
    const contact = await runInTenant(deps.tenant, async (tx) => {
      const removed = await deps.contactRepo.removeInTx(tx, contactId);
      if (!removed.ok) throw new UseCaseAbort<RepoError>(removed.error);

      const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'contact_removed',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `contact_removed ${contactId}`,
        payload: {
          member_id: removed.value.contact.memberId,
          contact_id: contactId,
          was_primary: removed.value.wasPrimary,
        },
      });
      if (!auditResult.ok) throw new UseCaseAbort<RepoError>(auditResult.error);

      return removed.value.contact;
    });
    return ok(contact);
  } catch (e) {
    if (e instanceof UseCaseAbort) {
      const re = e.error as RepoError;
      if (re.code === 'repo.not_found') return err({ type: 'not_found' });
      return err({ type: 'server_error', message: `remove: ${re.code}` });
    }
    return err({ type: 'server_error', message: 'remove: unexpected' });
  }
}

// --- promote primary ---------------------------------------------------------

export async function promotePrimary(
  memberId: MemberId,
  newPrimaryContactId: ContactId,
  meta: ContactCrudCallMeta,
  deps: ContactCrudDeps,
): Promise<
  Result<{ demoted: Contact; promoted: Contact }, ContactCrudError>
> {
  try {
    const result = await runInTenant(deps.tenant, async (tx) => {
      const promoted = await deps.contactRepo.promotePrimaryInTx(
        tx,
        memberId,
        newPrimaryContactId,
      );
      if (!promoted.ok) throw new UseCaseAbort<RepoError>(promoted.error);

      const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_primary_contact_changed',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `primary_contact_changed for ${memberId}`,
        payload: {
          member_id: memberId,
          old_primary_contact_id: promoted.value.demoted.contactId,
          new_primary_contact_id: newPrimaryContactId,
        },
      });
      if (!auditResult.ok) throw new UseCaseAbort<RepoError>(auditResult.error);

      return promoted.value;
    });
    return ok(result);
  } catch (e) {
    if (e instanceof UseCaseAbort) {
      const re = e.error as RepoError;
      if (re.code === 'repo.not_found') return err({ type: 'not_found' });
      if (re.code === 'repo.conflict')
        return err({ type: 'conflict', reason: re.reason });
      return err({ type: 'server_error', message: `promote: ${re.code}` });
    }
    return err({ type: 'server_error', message: 'promote: unexpected' });
  }
}
