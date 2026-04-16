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
import { err, ok, type Result } from '@/lib/result';
import { asPhone } from '../../domain/value-objects/phone';
import { asEmail } from '../../domain/value-objects/email';
import type { TenantContext } from '@/modules/tenants';
import type { Contact, ContactId } from '../../domain/contact';
import { asTenantId } from '../../domain/member';
import type { MemberId } from '../../domain/member';
import type { Phone } from '../../domain/value-objects/phone';
import type { ContactRepo } from '../ports/contact-repo';

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

  const r = await deps.contactRepo.add(
    deps.tenant,
    {
      tenantId: asTenantId(deps.tenant.slug),
      contactId: deps.idFactory.contactId(),
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
    },
    meta.actorUserId,
    meta.requestId,
  );
  if (!r.ok) {
    if (r.error.code === 'repo.conflict')
      return err({ type: 'conflict', reason: r.error.reason });
    return err({
      type: 'server_error',
      message: `add: ${r.error.code}`,
    });
  }
  return ok(r.value);
}

// --- update ------------------------------------------------------------------

export async function updateContactFields(
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

  const r = await deps.contactRepo.update(
    deps.tenant,
    contactId,
    patch,
    meta.actorUserId,
    meta.requestId,
  );
  if (!r.ok) {
    if (r.error.code === 'repo.not_found')
      return err({ type: 'not_found' });
    return err({
      type: 'server_error',
      message: `update: ${r.error.code}`,
    });
  }
  return ok(r.value);
}

// --- remove ------------------------------------------------------------------

export async function removeContact(
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
  if (existing.value.isPrimary)
    return err({ type: 'cannot_remove_primary' });

  const r = await deps.contactRepo.remove(
    deps.tenant,
    contactId,
    meta.actorUserId,
    meta.requestId,
  );
  if (!r.ok) {
    if (r.error.code === 'repo.not_found')
      return err({ type: 'not_found' });
    return err({
      type: 'server_error',
      message: `remove: ${r.error.code}`,
    });
  }
  return ok(r.value);
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
  const r = await deps.contactRepo.promotePrimary(
    deps.tenant,
    memberId,
    newPrimaryContactId,
    meta.actorUserId,
    meta.requestId,
  );
  if (!r.ok) {
    if (r.error.code === 'repo.not_found')
      return err({ type: 'not_found' });
    if (r.error.code === 'repo.conflict')
      return err({ type: 'conflict', reason: r.error.reason });
    return err({
      type: 'server_error',
      message: `promote: ${r.error.code}`,
    });
  }
  return ok(r.value);
}
