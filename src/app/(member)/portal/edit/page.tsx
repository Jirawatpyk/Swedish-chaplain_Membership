import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';
import { env } from '@/lib/env';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { asMembersUserId } from '@/lib/members-change-request-deps';
import { readOwnPendingRequest } from '@/lib/portal-own-pending';
import { serialiseChangeRequestForPortal, type ChangeRequestView } from '@/lib/change-request-portal-view';
import { PortalEditForm } from '@/components/members/portal-edit-form';
import { PortalChangeRequestForm } from '@/components/members/change-requests/portal-change-request-form';
import { PendingRequestBanner } from '@/components/members/change-requests/pending-request-banner';
import { changeRequestInitialValues, overlayPending, overlayResubmit } from '@/lib/change-request-form-values';
import type { ChangeRequestId } from '@/modules/members';

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

/**
 * The failed-read state (a pending-read or profile fault). `role="alert"` so
 * assistive tech announces it, and NOT `text-muted-foreground` — muted is the
 * repo's EMPTY-state sentinel, and this is an error (round 7, silent-failure
 * N4). A retry is a reload (server component), so the copy says so.
 */
function loadFailed(title: string, message: string) {
  return (
    <FormContainer>
      <PageHeader title={title} />
      <div role="alert" className="py-12 text-center">
        <p className="text-body">{message}</p>
      </div>
    </FormContainer>
  );
}

// The form's starting values are pure helpers in `@/lib/change-request-form-values`
// (shared with the resubmit unit test); re-exported here for existing importers.
export { changeRequestInitialValues, overlayPending, overlayResubmit } from '@/lib/change-request-form-values';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PortalEditPage({ searchParams }: PageProps) {
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
  // A read FAULT is a load error, never "no pending request": prefilling from
  // the live record would make the next submit REPLACE the pending proposal
  // (round 5, silent-failure #1 — the same rule the gate resolver follows).
  const pendingRead = await readOwnPendingRequest(deps.changeRequestRepo, tenant, asMembersUserId(user.id));
  if (!pendingRead.ok) {
    logger.error(
      { errorId: 'M114.portal.edit.pending_read_failed', err: pendingRead.error.code, tenantId: tenant.slug, userId: user.id },
      'portal.edit.pending_read_failed',
    );
    return loadFailed(t('pageTitle'), t('loadError'));
  }
  const pending: ChangeRequestView | null = pendingRead.value
    ? serialiseChangeRequestForPortal(pendingRead.value, {
        contactId: ownContact.contactId,
        displayName: `${ownContact.firstName} ${ownContact.lastName}`.trim(),
        isMe: true,
      })
    : null;

  // US3 (FR-023) — `?resubmit=<id>`: the caller's OWN decided request, else
  // ignored (an unknown id, another person's request or a pending one is
  // simply not a resubmit source — no error, no existence leak). A pending
  // request wins: its proposal is the live starting point (US5 AS5).
  let resubmitOf: ChangeRequestView | null = null;
  const sp = await searchParams;
  const resubmitRaw = Array.isArray(sp.resubmit) ? sp.resubmit[0] : sp.resubmit;
  if (!pending && resubmitRaw && UUID_RE.test(resubmitRaw)) {
    // the repo answers a Result (its body is try/caught) — a fault is THIS
    // arm, not a throw; the member still gets the live form (no error, no
    // existence leak) but ops see why the rejected values were not prefilled
    // (round 7, code N1: the previous catch was dead and this arm was silent)
    const decided = await deps.changeRequestRepo.findById(tenant, resubmitRaw as ChangeRequestId);
    if (!decided.ok && decided.error.code !== 'repo.not_found') {
      logger.error(
        { errorId: 'M114.portal.edit.resubmit_read_failed', err: decided.error.code, tenantId: tenant.slug, userId: user.id },
        'portal.edit.resubmit_read_failed',
      );
    }
    if (decided.ok && decided.value.state === 'decided' && decided.value.submittedByUserId === asMembersUserId(user.id)) {
      resubmitOf = serialiseChangeRequestForPortal(decided.value, {
        contactId: ownContact.contactId,
        displayName: `${ownContact.firstName} ${ownContact.lastName}`.trim(),
        isMe: true,
      });
    }
  }

  const live = changeRequestInitialValues(member, ownContact);
  const initialValues = pending ? overlayPending(live, pending) : overlayResubmit(live, resubmitOf);

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
        privacyNoticeHref={env.broadcasts.privacyPolicyUrl ?? null}
        resubmitOf={resubmitOf}
      />
    </FormContainer>
  );
}
