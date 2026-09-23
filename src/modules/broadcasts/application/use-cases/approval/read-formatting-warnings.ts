/**
 * F119 T063 — the two standing warnings on the staff detail page
 * (contracts/admin-eblast-formatting-api.md § Page contracts, "Warnings"):
 *
 *   - the owning member company has **no active portal user**, so a formatted
 *     version cannot be sent for approval (`POST …/version/send` → 409
 *     `no_portal_user`; only "Approve as submitted" or inviting a user is left);
 *   - an image in the body **no longer resolves to an allow-listed host**
 *     (the send and the promotion → 422 `image_source_not_allowlisted`),
 *     named image by image.
 *
 * A read, not a gate: the send and the schedule use cases re-check both under
 * their row lock, and they are the authority. It reads the SAME two ports
 * those use cases read (`MemberPortalRecipientPort` on the caller's tenant tx,
 * because contacts are RLS-scoped; the tenant allow-list) and applies the SAME
 * Domain rule (`evaluateImageSources`), so the warning cannot say something
 * the refusal would not.
 *
 * A failed read is `server_error` — never "no warning": an empty contact list
 * must mean "nobody can approve", not "the read failed".
 *
 * Pure Application — no framework imports.
 */
import { errKind } from '@/lib/log-id';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import {
  evaluateImageSources,
  type UnsafeImageSource,
} from '../../../domain/value-objects/image-source-allowlist';
import type { ImageAllowlistPort } from '../../ports/image-allowlist-port';
import type { MemberPortalRecipientPort } from '../../ports/member-portal-recipient-port';
import type { ApprovalBroadcastsRepo } from './_approval-tx';

export interface ReadFormattingWarningsDeps {
  readonly tenant: TenantContext;
  /** Only its `withTx` — the tenant tx the contact read must ride. */
  readonly broadcastsRepo: Pick<ApprovalBroadcastsRepo, 'withTx'>;
  readonly portalRecipients: MemberPortalRecipientPort;
  readonly imageAllowlist: Pick<ImageAllowlistPort, 'findByTenantId'>;
}

export interface ReadFormattingWarningsInput {
  /** `broadcasts.requested_by_member_id` — the company that must approve. */
  readonly memberId: string;
  /** The body the next hand-off would carry (working copy, approved version, or the record). */
  readonly bodyHtml: string;
}

export interface FormattingWarnings {
  readonly hasPortalUser: boolean;
  readonly unsafeImages: readonly UnsafeImageSource[];
}

export type ReadFormattingWarningsError = { readonly kind: 'server_error'; readonly errKind: string };

export async function readFormattingWarnings(
  deps: ReadFormattingWarningsDeps,
  input: ReadFormattingWarningsInput,
): Promise<Result<FormattingWarnings, ReadFormattingWarningsError>> {
  try {
    const allowlist = await deps.imageAllowlist.findByTenantId(deps.tenant.slug);
    const contacts = await deps.broadcastsRepo.withTx((tx) =>
      deps.portalRecipients.listActivePortalContacts(deps.tenant, input.memberId, tx),
    );
    return ok({
      hasPortalUser: contacts.length > 0,
      unsafeImages: evaluateImageSources(input.bodyHtml, allowlist),
    });
  } catch (e) {
    return err({ kind: 'server_error', errKind: errKind(e) });
  }
}
