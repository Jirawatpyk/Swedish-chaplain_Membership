/** @jsxImportSource react */
/**
 * F8 Phase 4 Wave I3 — Shared chrome for F8 reminder emails.
 *
 * Mirrors F4's `BaseEmailLayout` structurally (560px container, system
 * font stack, Resend-friendly `@react-email/components`) but adds the
 * dual-format date footer slot for FR-014 compliance. Footer brand
 * defaults to SweCham/TSCC; tenant-override is OOS-17 (post-MVP
 * white-label).
 *
 * Why a separate base layout (not reusing F4's): Constitution III
 * module boundary — F8 should not cross-import F4's templates.
 * Visual divergence is small (footer slot); the duplication cost is
 * 1 file vs the cross-module risk.
 */
import * as React from 'react';
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
import type { RenewalEmailLocale } from './copy';

export interface BaseRenewalLayoutProps {
  readonly locale: RenewalEmailLocale;
  readonly previewText: string;
  /** Top-line heading — the subject, ALREADY interpolated. */
  readonly heading: string;
  /** Body content (paragraph). Auto-escaped by JSX. */
  readonly bodyContent: React.ReactNode;
  readonly ctaLabel: string;
  readonly ctaHref: string;
  /** Footer dual-format date (rendered ABOVE brand line). */
  readonly footer?: React.ReactNode;
  /** Footer brand line — tenant-hardcoded for MVP per OOS-17. */
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
  whiteSpace: 'pre-wrap',
};

const BUTTON_STYLE: React.CSSProperties = {
  backgroundColor: '#111',
  color: '#fff',
  padding: '12px 24px',
  borderRadius: '6px',
  textDecoration: 'none',
  fontSize: '14px',
  fontWeight: 600,
  display: 'inline-block',
};

const FOOTER_BRAND_STYLE: React.CSSProperties = {
  fontSize: '12px',
  color: '#6b7280',
  margin: '16px 0 0',
};

export function BaseRenewalLayout({
  locale,
  previewText,
  heading,
  bodyContent,
  ctaLabel,
  ctaHref,
  footer,
  footerBrand = FOOTER_BRAND_DEFAULT,
}: BaseRenewalLayoutProps) {
  return (
    <Html lang={locale}>
      <Head />
      <Preview>{previewText}</Preview>
      <Body>
        <Container style={CONTAINER_STYLE}>
          <Text style={HEADING_STYLE}>{heading}</Text>
          <Text style={BODY_STYLE}>{bodyContent}</Text>
          <Section style={{ margin: '0 0 24px' }}>
            <Button href={ctaHref} style={BUTTON_STYLE}>
              {ctaLabel}
            </Button>
          </Section>
          {footer ?? null}
          <Text style={FOOTER_BRAND_STYLE}>{footerBrand}</Text>
        </Container>
      </Body>
    </Html>
  );
}
