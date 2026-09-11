/**
 * F114 — the stand-in for a submitting contact whose row is GONE (hard-deleted
 * or never readable). `decideChangeRequest` and `getChangeRequestReview` still
 * need a `Contact` to build the Group B record (its contact-target rows render
 * "(empty)" and can only be rejected — FR-020), so the stand-in is a FULL
 * `Contact` with explicit values, never an `as unknown as Contact` that hides
 * an `undefined` behind the compiler (round 6, silent-failure #21): a removed,
 * unlinked, non-primary contact with empty text fields and no opt-out.
 */
import type { Contact } from '../../../domain/contact';
import type { ChangeRequest } from '../../../domain/change-request/change-request';

const EPOCH = new Date(0);

export function removedContactStandIn(request: Pick<ChangeRequest, 'tenantId' | 'memberId' | 'submittedByContactId'>): Contact {
  return {
    tenantId: request.tenantId,
    contactId: request.submittedByContactId,
    memberId: request.memberId,
    firstName: '',
    lastName: '',
    email: '' as Contact['email'],
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en',
    dateOfBirth: null,
    linkedUserId: null,
    inviteBouncedAt: null,
    art14AttestedAt: null,
    marketing: { optedOutAt: null, source: null, byUserId: null },
    isPrimary: false,
    removedAt: EPOCH,
    createdAt: EPOCH,
    updatedAt: EPOCH,
  };
}
