/**
 * T099 (F7.1a US7) — `createBroadcastTemplate` Application use-case.
 *
 * Admin-only template create flow per contracts/broadcast-template.md
 * § 1.1 + FR-046:
 *   1. zod validate name (≤100) + subject (≤200) + body (≤200KB)
 *   2. Body validated against tenant image-source allowlist (FR-017
 *      — same enforcement as broadcast submit, no template bypass)
 *   3. Atomic mutation+audit via port.withTx (Constitution Principle I
 *      clause 3) — port.create + audit.emit(tx, ...) in ONE tx so a
 *      transient audit-storage failure rolls back the template row
 *   4. Audit payload: actor + templateId + name + subject (body
 *      excluded to keep audit row size bounded)
 *
 * Pure Application logic — no framework imports (Constitution Principle
 * III NON-NEGOTIABLE).
 */
import { err, ok, type Result } from '@/lib/result';
import type {
  BroadcastTemplatesPort,
  TemplateCreateError,
  TemplateLocale,
} from '../ports/broadcast-templates-port';
import type { AuditPort } from '../ports/audit-port';
import type { HtmlSanitizerPort } from '../ports/html-sanitizer-port';
import { sanitizeHtml } from './sanitize-html';
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

// R2.2 A3 — re-exported as local aliases to keep call-site grep
// patterns short while routing through the central constant.
const MAX_NAME = TEMPLATE_MAX_NAME_LENGTH;
const MAX_SUBJECT = TEMPLATE_MAX_SUBJECT_LENGTH;
const MAX_BODY = TEMPLATE_MAX_BODY_BYTES;

export interface CreateBroadcastTemplateDeps {
  readonly port: BroadcastTemplatesPort;
  readonly audit: AuditPort;
  readonly sanitizer: HtmlSanitizerPort;
  readonly validateImageSourceAllowlist: ValidateImageSourceAllowlistDeps;
}

export interface CreateBroadcastTemplateInput {
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly name: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly locale: TemplateLocale;
  readonly requestId: string;
}

export type CreateBroadcastTemplateError =
  | { readonly kind: 'invalid_input'; readonly detail: string }
  | {
      readonly kind: 'template_body_unsafe';
      readonly unsafeImageSources: readonly string[];
    }
  | TemplateCreateError;

export interface CreateBroadcastTemplateOutput {
  readonly templateId: string;
}

export async function createBroadcastTemplate(
  deps: CreateBroadcastTemplateDeps,
  input: CreateBroadcastTemplateInput,
): Promise<
  Result<CreateBroadcastTemplateOutput, CreateBroadcastTemplateError>
> {
  // 1. Input validation — fast-fail before any port/audit work.
  if (input.name.length === 0 || input.name.length > MAX_NAME) {
    return err({
      kind: 'invalid_input',
      detail: `name length must be 1..${MAX_NAME}`,
    });
  }
  if (input.subject.length === 0 || input.subject.length > MAX_SUBJECT) {
    return err({
      kind: 'invalid_input',
      detail: `subject length must be 1..${MAX_SUBJECT}`,
    });
  }
  if (input.bodyHtml.length > MAX_BODY) {
    return err({
      kind: 'invalid_input',
      detail: `body length must be ≤${MAX_BODY}`,
    });
  }

  // 1b. HTML sanitisation (defense-in-depth — security review 2026-05-22).
  //     Templates previously persisted RAW bodyHtml; only the submit +
  //     render paths re-sanitised. Sanitising at persist makes "every
  //     stored broadcast/template body is DOMPurify-filtered" a true
  //     invariant, and lets the allowlist check (step 2) run on canonical
  //     markup — eliminating the regex/DOMPurify parser differential.
  //     Mirrors submit-broadcast.ts order (sanitise → allowlist → persist).
  const sanitised = sanitizeHtml(
    { sanitizer: deps.sanitizer },
    { rawHtml: input.bodyHtml },
  );
  if (!sanitised.ok) {
    if (sanitised.error.kind === 'sanitizer_unavailable') {
      // Infra fault, not user-content fault → 500 via storage_error.
      return err({
        kind: 'storage_error',
        detail: `sanitizer_unavailable: ${sanitised.error.reason}`,
      });
    }
    // empty-after-strip or too-large → user-content fault → 400.
    return err({
      kind: 'invalid_input',
      detail:
        sanitised.error.kind === 'broadcast_body_too_large'
          ? `body length must be ≤${MAX_BODY}`
          : 'body is empty or unsafe after HTML sanitisation',
    });
  }
  const sanitisedBody = sanitised.value.sanitisedHtml;

  // 2. Image-source allowlist check (FR-017) — runs on the SANITISED body
  //    so any <img src=non-http(s)> already had its src stripped by the
  //    DOMPurify hook + the markup is canonical. Emits its own audit on
  //    rejection (broadcast_body_image_source_unsafe).
  const allowlistCheck = await validateImageSourceAllowlist(
    deps.validateImageSourceAllowlist,
    {
      bodyHtml: sanitisedBody,
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

  // 3. Atomic mutation + audit (Constitution Principle I clause 3).
  return deps.port.withTx(input.tenantId, async (tx) => {
    const createRes = await deps.port.create(
      input.tenantId,
      {
        name: input.name,
        subject: input.subject,
        bodyHtml: sanitisedBody,
        locale: input.locale,
        createdByUserId: input.actorUserId,
      },
      tx,
    );
    if (!createRes.ok) return err(createRes.error);

    const template = createRes.value;
    await deps.audit.emit(tx, {
      eventType: 'broadcast_template_created',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Template created — ${template.name} (${template.locale})`,
      payload: {
        templateId: template.id,
        name: template.name,
        subject: template.subject,
        locale: template.locale,
        // body excluded to keep audit row bounded (FR-021 + privacy)
      },
      requestId: input.requestId,
    });
    return ok({ templateId: template.id });
  });
}
