/**
 * T100 (F7.1a US7) — `updateBroadcastTemplate` Application use-case.
 *
 * Admin edit per contracts/broadcast-template.md § 1.2.
 *
 * Flow:
 *   1. Validate input lengths (subset of T099 — only changed fields).
 *   2. If `bodyHtml` is provided, validate against the tenant's image-
 *      source allowlist (`validateImageSourceAllowlist`) BEFORE
 *      entering the tx so we don't open a transaction we'll roll back.
 *
 * Post-R3.2 in-tx 3-branch flow (single tx via `withTxAllowDeleted`)
 * after `findByIdAllowDeletedInTx`:
 *   (a) row not found in RLS scope → cross-tenant probe → emit
 *       `broadcast_template_cross_tenant_probe` (tx=null) → return
 *       `{kind: 'not_found'}`
 *   (b) row exists but already soft-deleted → idempotent no-op →
 *       `logger.info` benign branch (R4.3 M-5) → return
 *       `{kind: 'not_found'}` (treat soft-deleted as gone from the
 *       admin edit surface)
 *   (c) live row → `port.update` → emit `broadcast_template_updated`
 *       with before/after payload (FR-021 forensic visibility) →
 *       return `ok`
 *
 * Snapshot invariant (FR-019): drafts already started from this
 * template are NOT modified (the `broadcasts.body_html` column is
 * independent of `broadcast_templates.body_html` — `updateDraft` and
 * `updateDraftFromTemplate` are the only writers to draft body).
 *
 * Pure Application logic.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { omitUndefined } from '@/lib/object-helpers';
import type {
  BroadcastTemplatesPort,
  TemplateUpdateError,
} from '../ports/broadcast-templates-port';
import type { AuditPort } from '../ports/audit-port';
import { emitTemplateCrossTenantProbeAudit } from './_emit-cross-tenant-probe';
import {
  validateImageSourceAllowlist,
  type ValidateImageSourceAllowlistDeps,
} from './validate-image-source-allowlist';
import type { TenantSlug } from '@/modules/tenants';
import {
  TEMPLATE_MAX_BODY_BYTES,
  TEMPLATE_MAX_NAME_LENGTH,
  TEMPLATE_MAX_SUBJECT_LENGTH,
} from './_template-field-limits';

const MAX_NAME = TEMPLATE_MAX_NAME_LENGTH;
const MAX_SUBJECT = TEMPLATE_MAX_SUBJECT_LENGTH;
const MAX_BODY = TEMPLATE_MAX_BODY_BYTES;

export interface UpdateBroadcastTemplateDeps {
  readonly port: BroadcastTemplatesPort;
  readonly audit: AuditPort;
  readonly validateImageSourceAllowlist: ValidateImageSourceAllowlistDeps;
}

export interface UpdateBroadcastTemplateInput {
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly templateId: string;
  readonly name?: string;
  readonly subject?: string;
  readonly bodyHtml?: string;
  readonly requestId: string;
}

export type UpdateBroadcastTemplateError =
  | { readonly kind: 'invalid_input'; readonly detail: string }
  | {
      readonly kind: 'template_body_unsafe';
      readonly unsafeImageSources: readonly string[];
    }
  | TemplateUpdateError;

export interface UpdateBroadcastTemplateOutput {
  readonly templateId: string;
}

export async function updateBroadcastTemplate(
  deps: UpdateBroadcastTemplateDeps,
  input: UpdateBroadcastTemplateInput,
): Promise<
  Result<UpdateBroadcastTemplateOutput, UpdateBroadcastTemplateError>
> {
  // 1. Validate only the fields being changed.
  if (
    input.name !== undefined &&
    (input.name.length === 0 || input.name.length > MAX_NAME)
  ) {
    return err({
      kind: 'invalid_input',
      detail: `name length must be 1..${MAX_NAME}`,
    });
  }
  if (
    input.subject !== undefined &&
    (input.subject.length === 0 || input.subject.length > MAX_SUBJECT)
  ) {
    return err({
      kind: 'invalid_input',
      detail: `subject length must be 1..${MAX_SUBJECT}`,
    });
  }
  if (input.bodyHtml !== undefined && input.bodyHtml.length > MAX_BODY) {
    return err({
      kind: 'invalid_input',
      detail: `body length must be ≤${MAX_BODY}`,
    });
  }

  // 2. Image-source allowlist check on new bodyHtml (if changed).
  //    Runs OUTSIDE the mutation tx — early-fail validation has no
  //    side effects to roll back.
  if (input.bodyHtml !== undefined) {
    const allowlistCheck = await validateImageSourceAllowlist(
      deps.validateImageSourceAllowlist,
      {
        bodyHtml: input.bodyHtml,
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
      },
    );
    if (!allowlistCheck.ok) {
      return err({
        kind: 'template_body_unsafe',
        unsafeImageSources: allowlistCheck.error.unsafeImageSources,
      });
    }
  }

  // 3. R3.2 H-1 — load + branch + mutate + audit in ONE withTx so the
  //    existing-template read uses findByIdAllowDeletedInTx and we can
  //    distinguish:
  //      (a) cross-tenant probe → emit probe audit + not_found
  //      (b) already soft-deleted → return not_found SILENTLY (benign
  //          race; no false-positive probe audit)
  //      (c) live template → update + audit normally
  return deps.port.withTx(input.tenantId, async (tx) => {
    const existing = await deps.port.findByIdAllowDeletedInTx(
      input.tenantId,
      input.templateId,
      tx,
    );
    if (!existing) {
      // (a) — true cross-tenant probe.
      await emitTemplateCrossTenantProbeAudit({
        audit: deps.audit,
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        templateId: input.templateId,
        operation: 'update',
        requestId: input.requestId,
      });
      return err<UpdateBroadcastTemplateError>({ kind: 'not_found' });
    }
    if (existing.deletedAt !== null) {
      // (b) — benign double-edit race; the template was soft-deleted
      // between picker render + edit submit.
      // R4.3 M-5 — info-level observability so SRE can confirm the
      // benign branch is hit when an edit returns 404; cross-tenant
      // probes go to the audit log via path (a), but this branch has
      // historically been silent.
      // R8.2 M-3 — see `delete-broadcast-template.ts` for the
      // Drizzle mode='date' rationale; the `!== null` guard above is
      // sufficient narrowing for `.toISOString()`. If Drizzle config
      // ever switches to mode='string', fix at the adapter boundary
      // not in every use-case.
      logger.info(
        {
          tenantId: input.tenantId,
          templateId: input.templateId,
          actorUserId: input.actorUserId,
          deletedAt: existing.deletedAt.toISOString(),
          requestId: input.requestId,
        },
        'broadcasts.template.update_idempotent_noop',
      );
      return err<UpdateBroadcastTemplateError>({ kind: 'not_found' });
    }

    // (c) — live template. Build patch + update + audit.
    const patch: Parameters<typeof deps.port.update>[2] = omitUndefined({
      name: input.name,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
    });
    const updateRes = await deps.port.update(
      input.tenantId,
      input.templateId,
      patch,
      tx,
    );
    if (!updateRes.ok) {
      // R3.3 H-5 — adapter's duplicate_name path defaults locale to
      // input.locale ?? 'en' (the adapter cannot know the existing
      // row's locale without a re-fetch). Override with `existing.locale`
      // so the i18n surface shows the right language in the UI ("name
      // already exists in Swedish" not "in English") when an admin
      // edits a TH/SV template's name to one that collides.
      if (updateRes.error.kind === 'duplicate_name') {
        return err({ kind: 'duplicate_name', locale: existing.locale });
      }
      return err(updateRes.error);
    }

    const after = updateRes.value;
    await deps.audit.emit(tx, {
      eventType: 'broadcast_template_updated',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Template updated — ${after.name}`,
      payload: {
        templateId: after.id,
        before: {
          name: existing.name,
          subject: existing.subject,
          // bodyHtml excluded from before/after (size + privacy)
        },
        after: {
          name: after.name,
          subject: after.subject,
        },
      },
      requestId: input.requestId,
    });
    return ok({ templateId: after.id });
  });
}
