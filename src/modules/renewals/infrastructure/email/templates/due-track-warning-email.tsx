/** @jsxImportSource react */
/**
 * 066 Round-2 §3.2(2) — DUE-TRACK overdue-invoice warning email.
 *
 * Sibling of `renewal-reminder-email.tsx` for the two tier-less
 * due-anchored steps (`due+7.email` / `due+30.email`). Resolves copy from
 * `DUE_TRACK_COPY` (bill-due framing) instead of the tier×offset matrix —
 * the reminder template's "expired on {expiresAt}" framing is wrong for a
 * born-awaiting member whose expiry is ~12 months out.
 *
 * Deliberate omissions vs the reminder template:
 *  - NO dual-format expiry footer (there is no meaningful expiry date to
 *    show; the bill's due date is already the subject of the copy).
 *  - NO preferences/opt-out link: these are contractual/bylaw dunning
 *    notices that BYPASS the renewal-reminder opt-out (design §3.2(2)) —
 *    a "manage preferences" link would falsely imply they can be muted.
 */
import * as React from 'react';
import { BaseRenewalLayout } from './base-renewal-layout';
import {
  interpolateCopy,
  resolveDueTrackCopy,
  type RenewalEmailLocale,
} from './copy';
import type { DueTrackStepId } from '@/modules/renewals/domain/due-track';

export interface DueTrackWarningEmailProps {
  readonly locale: RenewalEmailLocale;
  readonly stepId: DueTrackStepId;
  readonly memberFirstName: string;
  readonly memberCompanyName: string;
  /** CTA target — the member's invoice/renewal payment URL. */
  readonly payLinkUrl: string;
}

export function DueTrackWarningEmail(props: DueTrackWarningEmailProps) {
  const copy = resolveDueTrackCopy(props.stepId, props.locale);
  const variables: Record<string, string | number> = {
    firstName: props.memberFirstName,
    companyName: props.memberCompanyName,
  };
  const subject = interpolateCopy(copy.subject, variables);
  const body = interpolateCopy(copy.body, variables);
  const ctaLabel = interpolateCopy(copy.cta, variables);

  return (
    <BaseRenewalLayout
      locale={props.locale}
      previewText={subject}
      heading={subject}
      bodyContent={body}
      ctaLabel={ctaLabel}
      ctaHref={props.payLinkUrl}
    />
  );
}
