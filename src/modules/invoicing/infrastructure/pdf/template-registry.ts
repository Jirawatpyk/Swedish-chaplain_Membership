/**
 * T045 — PDF template version registry (F4).
 *
 * MUST remain forward-only — each version ever shipped stays here
 * indefinitely because resend / Blob-miss-recovery paths render using
 * the PINNED version from the invoice row (FR-016, R3-E4). Deleting
 * an old version breaks deterministic re-rendering.
 *
 * When a template changes, bump `CURRENT_TEMPLATE_VERSION` and add a
 * new mapping entry. The smoke test `pdf-template-version-smoke.test.ts`
 * (T017 future) asserts every version in the registry still renders.
 */

export const CURRENT_TEMPLATE_VERSION = 1 as const;

export const TEMPLATE_VERSIONS = [1] as const;
export type PdfTemplateVersion = (typeof TEMPLATE_VERSIONS)[number];

export function isKnownTemplateVersion(v: number): v is PdfTemplateVersion {
  return (TEMPLATE_VERSIONS as readonly number[]).includes(v);
}
