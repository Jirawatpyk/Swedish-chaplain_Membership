/**
 * F119 T063 — the two standing warnings on the staff detail page (contract
 * § Page contracts, "Warnings"): the owning member company has NO active
 * portal user (the send would answer 409 `no_portal_user`), and an image in
 * the body no longer resolves to an allow-listed host (the send and the
 * promotion would answer 422 `image_source_not_allowlisted`). Read with the
 * SAME ports and the SAME Domain rule the send uses, so the warning and the
 * refusal cannot disagree.
 */
import { describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import { ApprovalDependencyError } from '@/modules/broadcasts/application/approval-dependency-error';
import {
  readFormattingWarnings,
  type ReadFormattingWarningsDeps,
} from '@/modules/broadcasts/application/use-cases/approval/read-formatting-warnings';
import {
  makeFakeApprovalStore,
  makeFakeImageAllowlist,
  makeFakePortalRecipients,
  makePortalContact,
} from '../../../helpers/eblast-approval-fakes';

const MEMBER = '22222222-2222-4222-8222-222222222222';
const ALLOWED = 'https://assets.swecham.zyncdata.app/a.png';
const REMOVED = 'https://old-cdn.example.org/b.png';

function deps(opts: { contacts?: boolean } = {}): ReadFormattingWarningsDeps {
  const store = makeFakeApprovalStore();
  return {
    tenant: asTenantContext('test-tenant'),
    broadcastsRepo: store.broadcastsRepo,
    portalRecipients: makeFakePortalRecipients(opts.contacts === false ? {} : { [MEMBER]: [makePortalContact()] }),
    imageAllowlist: makeFakeImageAllowlist(),
  };
}

describe('readFormattingWarnings', () => {
  it('no warning when the member has a portal user and every image is allow-listed', async () => {
    const r = await readFormattingWarnings(deps(), { memberId: MEMBER, bodyHtml: `<p>x</p><img src="${ALLOWED}" alt="a">` });
    expect(r).toEqual({ ok: true, value: { hasPortalUser: true, unsafeImages: [] } });
  });

  it('flags a member company with no active portal user', async () => {
    const r = await readFormattingWarnings(deps({ contacts: false }), { memberId: MEMBER, bodyHtml: '<p>x</p>' });
    expect(r.ok && r.value.hasPortalUser).toBe(false);
  });

  it('names each image whose host has left the allow-list', async () => {
    const r = await readFormattingWarnings(deps(), {
      memberId: MEMBER,
      bodyHtml: `<img src="${ALLOWED}" alt="a"><img src="${REMOVED}" alt="b">`,
    });
    expect(r.ok ? r.value.unsafeImages : null).toEqual([
      { src: REMOVED, host: 'old-cdn.example.org', reason: 'not_allowlisted' },
    ]);
  });

  it('a failed read is an error, never "no warning"', async () => {
    const d = deps();
    vi.mocked(d.imageAllowlist.findByTenantId).mockRejectedValueOnce(new TypeError('pool exhausted'));
    const r = await readFormattingWarnings(d, { memberId: MEMBER, bodyHtml: '<p>x</p>' });
    expect(r).toEqual({ ok: false, error: { kind: 'server_error', errKind: 'TypeError' } });
  });

  // F119 round-4 B3 — the staff page logs this errKind; a failed portal-contact
  // read names the dependency and its repo code rather than a bare `Error`.
  it('a failed portal-contact read keeps its cause in errKind', async () => {
    const d = deps();
    vi.mocked(d.portalRecipients.listActivePortalContacts).mockRejectedValueOnce(
      new ApprovalDependencyError('portal_contacts', 'repo.unexpected'),
    );
    const r = await readFormattingWarnings(d, { memberId: MEMBER, bodyHtml: '<p>x</p>' });
    expect(r).toEqual({
      ok: false,
      error: { kind: 'server_error', errKind: 'ApprovalDependencyError:portal_contacts:repo.unexpected' },
    });
  });
});
