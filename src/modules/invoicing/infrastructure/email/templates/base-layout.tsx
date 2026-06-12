/** @jsxImportSource react */
/**
 * T108 — shared F4 auto-email layout (@react-email/components).
 *
 * Wraps the template-specific body (subject heading, content paragraph,
 * CTA button) in a single brand-consistent chrome: Html + Head + Body
 * + Container. Render pipeline (via `render()` from @react-email/render)
 * inlines the styles for Gmail/Outlook/Apple Mail compat — no mso
 * conditionals needed because the Container + Button components
 * already emit the boilerplate.
 *
 * Chrome design decisions:
 *   - 560px max-width: matches the pre-migration inline HTML so the
 *     visual footprint is unchanged across client reflow breakpoints.
 *   - System font stack: preserves the pre-migration rendering on every
 *     client; webfont loading in email is unreliable.
 *   - Single-button CTA: Gmail's clipping rule (102KB max) + Outlook's
 *     VML fallback are both happy with @react-email/components `<Button>`.
 */
import {
  Body,
  Button,
  Container,
  Head,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import * as React from 'react';
import { EMAIL_BRAND_PRIMARY } from '@/lib/email-brand';
import type { InvoiceAutoEmailLocale } from './copy';

export interface BaseEmailLayoutProps {
  readonly locale: InvoiceAutoEmailLocale;
  readonly previewText: string;
  /** Top-line heading — the subject, ALREADY interpolated. */
  readonly heading: string;
  /**
   * Body content. Accepts React nodes so templates can emit escaped
   * spans (e.g. bold document number, italic reason). JSX auto-escapes
   * any interpolated string — do NOT pre-escape via `escapeHtml` in
   * the template layer.
   */
  readonly bodyContent: React.ReactNode;
  readonly ctaLabel: string;
  readonly ctaHref: string;
  /** Footer brand line — tenant-hardcoded for now (F1 STD); future MTA replaces via prop. */
  readonly footerBrand?: string;
  /**
   * F5 FR-027 — optional "Pay online" primary CTA rendered ABOVE the
   * standard download button. Both `primaryCtaLabel` and `primaryCtaHref`
   * MUST be provided together; omitting either renders the layout with a
   * single CTA (pre-F5 behaviour preserved).
   */
  readonly primaryCtaLabel?: string;
  readonly primaryCtaHref?: string;
  /**
   * 054-event-fee-invoices (Task 14) — optional PDPA privacy-notice block
   * rendered ABOVE the footer brand line. Both `title` and `notice` MUST be
   * provided together; omitting either renders the layout with no notice
   * (pre-Task-14 behaviour preserved). Used by the non-member event-invoice
   * auto-email to explain why the buyer's identity was recorded.
   */
  readonly privacyNoticeTitle?: string;
  readonly privacyNoticeBody?: string;
}

const FOOTER_BRAND_DEFAULT = 'Thailand-Swedish Chamber of Commerce (SweCham / TSCC)';

const CONTAINER_STYLE: React.CSSProperties = {
  maxWidth: '560px',
  margin: '0 auto',
  padding: '24px',
  color: '#111',
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
};

const HEADING_STYLE: React.CSSProperties = {
  fontSize: '18px',
  lineHeight: '1.4',
  margin: '0 0 16px',
  fontWeight: 600,
};

const BODY_STYLE: React.CSSProperties = {
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '0 0 24px',
};

const BUTTON_STYLE: React.CSSProperties = {
  display: 'inline-block',
  padding: '10px 20px',
  backgroundColor: '#111',
  color: '#ffffff',
  textDecoration: 'none',
  borderRadius: '6px',
  fontSize: '14px',
  fontWeight: 500,
};

/**
 * F5 FR-027 — "Pay online" primary button style. Deliberately visually
 * distinct from the download CTA: coloured primary (deep Swedish navy
 * `EMAIL_BRAND_PRIMARY` = the app's `--primary` token value, inlined at
 * render — email clients don't resolve CSS variables). Meets WCAG 2.1 AA
 * contrast ≥ 4.5:1 on `#ffffff` body (white-on-navy ≈ 9.4:1).
 */
const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  display: 'inline-block',
  padding: '12px 24px',
  backgroundColor: EMAIL_BRAND_PRIMARY,
  color: '#ffffff',
  textDecoration: 'none',
  borderRadius: '6px',
  fontSize: '15px',
  fontWeight: 600,
};

const LINK_FALLBACK_STYLE: React.CSSProperties = {
  fontSize: '12px',
  color: '#666',
  lineHeight: '1.5',
  margin: '16px 0 0',
};

const FOOTER_STYLE: React.CSSProperties = {
  fontSize: '12px',
  color: '#888',
  lineHeight: '1.5',
  margin: '32px 0 0',
  borderTop: '1px solid #eee',
  paddingTop: '16px',
};

/**
 * 054-event-fee-invoices (Task 14) — PDPA privacy-notice block. Visually
 * distinct from the brand footer (slightly darker text + its own top border)
 * so a non-member buyer's eye lands on the transparency notice rather than
 * skipping it as boilerplate. Kept inline-literal (email clients do not
 * resolve CSS variables) and WCAG-AA contrast on the white body.
 */
const PRIVACY_NOTICE_STYLE: React.CSSProperties = {
  fontSize: '12px',
  color: '#555',
  lineHeight: '1.5',
  margin: '24px 0 0',
  borderTop: '1px solid #eee',
  paddingTop: '16px',
};

const PRIVACY_NOTICE_TITLE_STYLE: React.CSSProperties = {
  fontSize: '12px',
  color: '#555',
  lineHeight: '1.5',
  margin: '0 0 4px',
  fontWeight: 600,
};

/**
 * Footer brand line WITHOUT its own top border — used when a privacy
 * notice block immediately precedes it (the notice already drew the rule).
 */
const FOOTER_STYLE_NO_BORDER: React.CSSProperties = {
  fontSize: '12px',
  color: '#888',
  lineHeight: '1.5',
  margin: '16px 0 0',
};

/**
 * Base layout component — identical chrome across every F4 auto-email.
 * Templates compose a `bodyContent` node + heading + CTA + pass them
 * through here.
 */
export function BaseEmailLayout(props: BaseEmailLayoutProps) {
  const hasPrimaryCta =
    typeof props.primaryCtaLabel === 'string' &&
    props.primaryCtaLabel.length > 0 &&
    typeof props.primaryCtaHref === 'string' &&
    props.primaryCtaHref.length > 0;
  const hasPrivacyNotice =
    typeof props.privacyNoticeTitle === 'string' &&
    props.privacyNoticeTitle.length > 0 &&
    typeof props.privacyNoticeBody === 'string' &&
    props.privacyNoticeBody.length > 0;
  return (
    <Html lang={props.locale}>
      <Head />
      <Preview>{props.previewText}</Preview>
      <Body style={{ backgroundColor: '#ffffff', margin: 0, padding: 0 }}>
        <Container style={CONTAINER_STYLE}>
          <Text style={HEADING_STYLE} role="heading" aria-level={1}>
            {props.heading}
          </Text>
          <Section>
            <Text style={BODY_STYLE}>{props.bodyContent}</Text>
          </Section>
          {hasPrimaryCta ? (
            <Section style={{ margin: '0 0 16px' }} data-testid="pay-online-cta">
              <Button
                href={props.primaryCtaHref as string}
                style={PRIMARY_BUTTON_STYLE}
              >
                {props.primaryCtaLabel}
              </Button>
            </Section>
          ) : null}
          <Section style={{ margin: '0 0 24px' }}>
            <Button href={props.ctaHref} style={BUTTON_STYLE}>
              {props.ctaLabel}
            </Button>
          </Section>
          <Text style={LINK_FALLBACK_STYLE}>
            If the button does not work, copy this link:
            <br />
            <a href={props.ctaHref} style={{ color: '#666', wordBreak: 'break-all' }}>
              {props.ctaHref}
            </a>
          </Text>
          {hasPrivacyNotice ? (
            <Section data-testid="event-non-member-privacy-footer">
              <Text style={PRIVACY_NOTICE_TITLE_STYLE}>
                {props.privacyNoticeTitle}
              </Text>
              <Text style={PRIVACY_NOTICE_STYLE}>{props.privacyNoticeBody}</Text>
            </Section>
          ) : null}
          <Text
            style={
              // When the privacy notice already drew the section divider,
              // drop the brand line's own top border so the two blocks
              // share one rule instead of stacking two adjacent lines.
              hasPrivacyNotice ? FOOTER_STYLE_NO_BORDER : FOOTER_STYLE
            }
          >
            {props.footerBrand ?? FOOTER_BRAND_DEFAULT}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
