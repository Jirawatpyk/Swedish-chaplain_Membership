'use client';

/**
 * Spec 122 US12d-3 follow-up (PR C) — the E-Blast sending rules on the member
 * compose page (boards `Portal-broadcast-new-rules`, `Portal-broadcast-new`).
 *
 * Reuses the company's acknowledgement the portal banner records
 * (`members.broadcasts_acknowledged_at`, POST /api/portal/broadcasts/acknowledge,
 * audited once as `member_acknowledged_broadcasts_terms`) and the banner's
 * own copy, so the two surfaces say the same thing:
 * - not yet acknowledged: the banner's warning alert, with "I acknowledge";
 * - acknowledged: one line, "E-Blast sending rules · Read again", a
 *   disclosure that shows the same rules and changes nothing on the server.
 *
 * It explains the rules; it never gates Save or Submit (they never were).
 * The portal banner is hidden on this route, so the rules show once.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Alert, Button } from '@jirawatpyk/aura-react';
import {
  useAcknowledgeBroadcastsTerms,
  useBroadcastsAcknowledgedInThisTab,
} from '@/components/broadcast/acknowledgement/use-acknowledge-broadcasts-terms';
import { BroadcastsRulesBody } from '@/components/broadcast/acknowledgement/rules-body';

export interface ComposeSendingRulesProps {
  /** The signed-in member (company); keys the in-tab acknowledgement. */
  readonly memberId: string;
  /** ISO time the company acknowledged the rules, or null when it has not. */
  readonly acknowledgedAt: string | null;
  /** Recorded on the audit row, as the banner does. */
  readonly locale: 'en' | 'th' | 'sv';
  /** The tenant's privacy policy, when one is published. */
  readonly privacyPolicyUrl: string | null;
}

export function ComposeSendingRules({
  memberId,
  acknowledgedAt,
  locale,
  privacyPolicyUrl,
}: ComposeSendingRulesProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.banner.acknowledgement');
  const tRules = useTranslations('portal.broadcasts.compose.rules');
  // Recorded on the server (the prop) or in this tab: the form remounts this
  // block when it crosses the phone breakpoint, and nothing refreshes the prop.
  const acknowledgedInThisTab = useBroadcastsAcknowledgedInThisTab(memberId);
  const acknowledged = acknowledgedAt !== null || acknowledgedInThisTab;
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusToggle = useRef(false);
  const titleId = useId();
  const lineId = useId();
  const rulesId = useId();

  const { acknowledge, pending } = useAcknowledgeBroadcastsTerms({
    memberId,
    locale,
    // No banner on this page: the hint says the rules stay here.
    failureHint: tRules('toastAcknowledgeFailedHint'),
    onAcknowledged: () => {
      focusToggle.current = true;
    },
  });

  // After acknowledging, the alert's button unmounts: focus moves to the
  // line's "Read again", where the rules can be opened again.
  useEffect(() => {
    if (acknowledged && focusToggle.current) {
      focusToggle.current = false;
      toggleRef.current?.focus();
    }
  }, [acknowledged]);

  const rules = (
    <BroadcastsRulesBody
      body={t('body')}
      privacyPolicyUrl={privacyPolicyUrl}
      privacyPolicyLinkLabel={t('privacyPolicyLink')}
    />
  );

  if (!acknowledged) {
    return (
      // A named region, as the banner is: a standing request, not an alert.
      <div role="region" aria-labelledby={titleId} data-testid="compose-sending-rules">
        <Alert
          tone="warning"
          role="none"
          icon={<ShieldCheck aria-hidden="true" />}
          title={<span id={titleId}>{t('title')}</span>}
          action={
            // Secondary: Submit stays the page's one primary action.
            <Button type="button" variant="secondary" onClick={acknowledge} loading={pending}>
              {t('acknowledge')}
            </Button>
          }
        >
          {rules}
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="compose-sending-rules">
      <div className="flex flex-wrap items-center gap-x-2 text-sm text-[var(--aura-fg-secondary)]">
        <ShieldCheck aria-hidden="true" className="size-4 shrink-0" />
        <span id={lineId}>{tRules('line')}</span>
        {/* The dot and the button wrap together, so the dot never ends a line. */}
        <span className="inline-flex items-center gap-x-2">
          <span aria-hidden="true">·</span>
          {/* One name; the state is aria-expanded, the line is its context. */}
          <Button
            ref={toggleRef}
            type="button"
            variant="ghost"
            size="sm"
            touchHeight
            aria-expanded={open}
            aria-controls={rulesId}
            aria-describedby={lineId}
            onClick={() => setOpen((v) => !v)}
          >
            {tRules('readAgain')}
          </Button>
        </span>
      </div>
      {/* Mounted while closed, so aria-controls always resolves. */}
      <div
        id={rulesId}
        hidden={!open}
        className="flex flex-col gap-2 rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] p-3 text-sm"
      >
        {rules}
      </div>
    </div>
  );
}
