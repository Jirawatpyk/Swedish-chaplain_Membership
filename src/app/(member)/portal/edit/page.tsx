import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';
import { runInTenant } from '@/lib/db';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { asMembersUserId } from '@/lib/members-change-request-deps';
import { serialiseChangeRequestForPortal, type ChangeRequestView } from '@/lib/change-request-portal-view';
import { PortalEditForm } from '@/components/members/portal-edit-form';
import {
  PortalChangeRequestForm,
  type ChangeRequestFormValues,
} from '@/components/members/change-requests/portal-change-request-form';
import { PendingRequestBanner } from '@/components/members/change-requests/pending-request-banner';
import type { Contact, Member } from '@/modules/members';

/**
 * Portal edit page — US5 AS2 (T124) + F114 US1 (T040).
 *
 * Resolves the tenant's member-change GATE server-side (flag ∧ setting):
 *   - `approval`  → the Group B change-request form (FR-002): the caller's
 *                   own contact fields; the company fields only for the
 *                   primary contact; the pending banner when the caller's own
 *                   request is awaiting review; the GDPR Art. 13 notice.
 *   - `immediate` → the F3 immediate form (flag-OFF path, unchanged).
 * The contact's email language (Group A) left this page in both modes — it
 * lives on /portal/account beside the display language (FR-004, R6).
 *
 * FR-042: forbidden fields are hidden entirely (not shown disabled).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.edit');
  return { title: t('pageTitle') };
}

function loadFailed(title: string, message: string) {
  return (
    <FormContainer>
      <PageHeader title={title} />
      <div className="py-12 text-center">
        <p className="text-body text-muted-foreground">{message}</p>
      </div>
    </FormContainer>
  );
}

/** The Group B record → form strings (nulls → ''). */
export function changeRequestInitialValues(member: Member, contact: Contact): ChangeRequestFormValues {
  return {
    firstName: contact.firstName,
    lastName: contact.lastName,
    phone: contact.phone ?? '',
    roleTitle: contact.roleTitle ?? '',
    companyName: member.companyName,
    website: member.website ?? '',
    description: member.description ?? '',
    regLine1: member.addressLine1 ?? '',
    regLine2: member.addressLine2 ?? '',
    regSubDistrict: member.subDistrict ?? '',
    regCity: member.city ?? '',
    regProvince: member.province ?? '',
    regPostalCode: member.postalCode ?? '',
    billLine1: member.billingAddressLine1 ?? '',
    billLine2: member.billingAddressLine2 ?? '',
    billSubDistrict: member.billingSubDistrict ?? '',
    billCity: member.billingCity ?? '',
    billProvince: member.billingProvince ?? '',
    billPostalCode: member.billingPostalCode ?? '',
    billCountry: member.billingCountry ?? '',
  };
}

/** US5 AS5 — a pending request's proposed values are the starting point. */
export function overlayPending(values: ChangeRequestFormValues, pending: ChangeRequestView | null): ChangeRequestFormValues {
  if (!pending) return values;
  const out = { ...values };
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  for (const f of pending.fields) {
    const p = f.proposed as Record<string, string | null> | string | null;
    switch (f.key) {
      case 'first_name': out.firstName = str(p); break;
      case 'last_name': out.lastName = str(p); break;
      case 'phone': out.phone = str(p); break;
      case 'role_title': out.roleTitle = str(p); break;
      case 'company_name': out.companyName = str(p); break;
      case 'website': out.website = str(p); break;
      case 'description': out.description = str(p); break;
      case 'registered_address':
        if (p && typeof p === 'object') {
          out.regLine1 = p.line1 ?? ''; out.regLine2 = p.line2 ?? ''; out.regSubDistrict = p.sub_district ?? '';
          out.regCity = p.city ?? ''; out.regProvince = p.province ?? ''; out.regPostalCode = p.postal_code ?? '';
        }
        break;
      case 'billing_address':
        if (p && typeof p === 'object') {
          out.billLine1 = p.line1 ?? ''; out.billLine2 = p.line2 ?? ''; out.billSubDistrict = p.sub_district ?? '';
          out.billCity = p.city ?? ''; out.billProvince = p.province ?? ''; out.billPostalCode = p.postal_code ?? '';
          out.billCountry = p.country ?? '';
        }
        break;
    }
  }
  return out;
}

export default async function PortalEditPage() {
  const { user } = await requireSession('member');
  const t = await getTranslations('portal.edit');
  const tCr = await getTranslations('portal.changeRequests.form');

  const tenant = resolveTenantFromRequest();
  const deps = buildMembersDeps(tenant);

  // Resolve member from linked user
  const memberResult = await deps.memberRepo.findByLinkedUserId(tenant, user.id);
  if (!memberResult.ok) {
    // Distinguish a legitimate "no member linked" (repo.not_found → notLinked)
    // from a real DB/RLS failure (repo.unexpected). Without this split a
    // transient Neon error would tell the member they have no account AND
    // leave ops with no trace. Mirrors account/page.tsx.
    if (memberResult.error.code !== 'repo.not_found') {
      logger.error(
        { err: memberResult.error, tenantId: tenant.slug, userId: user.id },
        'portal.edit.member_lookup_failed',
      );
    }
    const message = memberResult.error.code === 'repo.not_found' ? t('notLinked') : t('loadError');
    return loadFailed(t('pageTitle'), message);
  }

  const member = memberResult.value;

  // Load contacts to find the caller's own contact
  const contactsResult = await deps.contactRepo.listByMember(tenant, member.memberId);
  if (!contactsResult.ok) {
    if (contactsResult.error.code !== 'repo.not_found') {
      logger.error(
        { err: contactsResult.error, tenantId: tenant.slug, userId: user.id },
        'portal.edit.contacts_lookup_failed',
      );
    }
    return loadFailed(t('pageTitle'), t('loadError'));
  }

  const ownContact = contactsResult.value.find(
    (c) => String(c.linkedUserId) === user.id && !c.removedAt,
  );
  if (!ownContact) {
    return loadFailed(t('pageTitle'), t('notLinked'));
  }

  // F114 — the gate decides which form renders. A resolver failure is a
  // load error (never a guessed mode: guessing `immediate` would let a Group
  // B edit bypass the gate on a transient fault).
  let gate: 'immediate' | 'approval';
  try {
    gate = await deps.memberChangeGate.resolve(tenant);
  } catch (e) {
    logger.error(
      { errorId: 'M114.portal.edit.gate_failed', err: errKind(e), tenantId: tenant.slug, userId: user.id },
      'portal.edit.gate_failed',
    );
    return loadFailed(t('pageTitle'), t('loadError'));
  }

  if (gate === 'immediate') {
    return (
      <FormContainer>
        <PageHeader title={t('pageTitle')} subtitle={member.companyName} />
        <PortalEditForm
          initialValues={{
            firstName: ownContact.firstName,
            lastName: ownContact.lastName,
            phone: ownContact.phone ?? '',
            website: member.website ?? '',
            description: member.description ?? '',
          }}
        />
      </FormContainer>
    );
  }

  // approval — the caller's own pending request (never another contact's)
  let pending: ChangeRequestView | null = null;
  try {
    const pendingResult = await runInTenant(tenant, (tx) =>
      deps.changeRequestRepo.findPendingBySubmitterInTx(tx, asMembersUserId(user.id)),
    );
    if (pendingResult.ok && pendingResult.value) {
      pending = serialiseChangeRequestForPortal(pendingResult.value, {
        contactId: ownContact.contactId,
        displayName: `${ownContact.firstName} ${ownContact.lastName}`.trim(),
        isMe: true,
      });
    } else if (!pendingResult.ok) {
      logger.error(
        { errorId: 'M114.portal.edit.pending_read_failed', err: pendingResult.error.code, tenantId: tenant.slug, userId: user.id },
        'portal.edit.pending_read_failed',
      );
    }
  } catch (e) {
    logger.error(
      { errorId: 'M114.portal.edit.pending_read_failed', err: errKind(e), tenantId: tenant.slug, userId: user.id },
      'portal.edit.pending_read_failed',
    );
  }

  const initialValues = overlayPending(changeRequestInitialValues(member, ownContact), pending);

  return (
    <FormContainer>
      <PageHeader title={tCr('pageTitle')} subtitle={tCr('pageSubtitle')} />
      {pending ? (
        <div className="mb-6">
          <PendingRequestBanner request={pending} showEditLink={false} />
        </div>
      ) : null}
      <PortalChangeRequestForm
        initialValues={initialValues}
        canProposeCompanyFields={ownContact.isPrimary}
        pending={pending}
        privacyNoticeHref="/privacy"
      />
    </FormContainer>
  );
}
