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
 * Base layout component — identical chrome across every F4 auto-email.
 * Templates compose a `bodyContent` node + heading + CTA + pass them
 * through here.
 */
export function BaseEmailLayout(props: BaseEmailLayoutProps) {
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
          <Text style={FOOTER_STYLE}>{props.footerBrand ?? FOOTER_BRAND_DEFAULT}</Text>
        </Container>
      </Body>
    </Html>
  );
}
