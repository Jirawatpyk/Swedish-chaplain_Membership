/**
 * T-3 — Unit tests for `buildInvoiceAutoEmail` (F4 auto-email template).
 *
 * Pure function with zero framework dependencies — perfectly unit-
 * testable. Covers the FR-036 `invoice_voided` copy rewrite:
 *   - `{docNumber}` interpolation in EN / TH / SV subject + body
 *   - "no longer payable / เอกสารฉบับนี้ยกเลิกแล้ว" phrasing present
 *   - missing `documentNumber` fallback renders empty string (not the
 *     literal `{docNumber}` placeholder)
 *   - subject/body/text/html all consistent
 */
import { describe, expect, it } from 'vitest';
import { buildInvoiceAutoEmail } from '@/modules/invoicing/infrastructure/email/invoice-auto-email';

const DOWNLOAD_URL = 'https://blob.test/invoice-voided.pdf';
const DOC_NUMBER = 'TI-2026-000042';

describe('buildInvoiceAutoEmail — invoice_voided FR-036 copy', () => {
  it('EN: references documentNumber in subject + body + declares not payable', async () => {
    const out = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_voided',
      downloadUrl: DOWNLOAD_URL,
      locale: 'en',
      documentNumber: DOC_NUMBER,
      hasAttachment: true,
    });
    expect(out.subject).toContain(DOC_NUMBER);
    expect(out.subject.toLowerCase()).toContain('voided');
    expect(out.html).toContain(DOC_NUMBER);
    expect(out.html.toLowerCase()).toContain('no longer payable');
    expect(out.text).toContain(DOC_NUMBER);
    expect(out.text.toLowerCase()).toContain('no longer payable');
    // PG-2 — attachment-clause copy when flag ON says "attached".
    expect(out.html.toLowerCase()).toContain('is attached for your records');
    // Placeholders must be substituted, not leaked.
    expect(out.subject).not.toContain('{docNumber}');
    expect(out.html).not.toContain('{docNumber}');
    expect(out.html).not.toContain('{attachmentClause}');
    expect(out.text).not.toContain('{attachmentClause}');
  });

  it('EN: hasAttachment=false switches copy to link-only (PG-2 DPA gate)', async () => {
    const out = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_voided',
      downloadUrl: DOWNLOAD_URL,
      locale: 'en',
      documentNumber: DOC_NUMBER,
      hasAttachment: false,
    });
    // Must NOT promise an attachment when the flag is OFF.
    expect(out.html.toLowerCase()).not.toContain('is attached for your records');
    // Should still reference the VOID document + link.
    expect(out.html.toLowerCase()).toContain('via the link below');
    expect(out.html).toContain(DOC_NUMBER);
    expect(out.html).not.toContain('{attachmentClause}');
  });

  it('TH: references documentNumber + contains "เอกสารฉบับนี้ยกเลิกแล้ว"', async () => {
    const out = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_voided',
      downloadUrl: DOWNLOAD_URL,
      locale: 'th',
      documentNumber: DOC_NUMBER,
      hasAttachment: true,
    });
    expect(out.subject).toContain(DOC_NUMBER);
    expect(out.subject).toContain('ยกเลิก');
    expect(out.html).toContain(DOC_NUMBER);
    expect(out.html).toContain('เอกสารฉบับนี้ยกเลิกแล้ว');
    expect(out.text).toContain('เอกสารฉบับนี้ยกเลิกแล้ว');
    expect(out.subject).not.toContain('{docNumber}');
    expect(out.html).not.toContain('{docNumber}');
  });

  it('SV: references documentNumber + declares "ska inte längre betalas"', async () => {
    const out = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_voided',
      downloadUrl: DOWNLOAD_URL,
      locale: 'sv',
      documentNumber: DOC_NUMBER,
      hasAttachment: true,
    });
    expect(out.subject).toContain(DOC_NUMBER);
    expect(out.subject.toLowerCase()).toContain('annullerats');
    expect(out.html).toContain(DOC_NUMBER);
    expect(out.html).toContain('ska inte längre betalas');
    expect(out.text).toContain('ska inte längre betalas');
    expect(out.subject).not.toContain('{docNumber}');
  });

  it('documentNumber omitted → placeholder substitutes to empty string (not literal)', async () => {
    const out = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_voided',
      downloadUrl: DOWNLOAD_URL,
      locale: 'en',
      // documentNumber deliberately omitted
    });
    expect(out.subject).not.toContain('{docNumber}');
    expect(out.html).not.toContain('{docNumber}');
    expect(out.text).not.toContain('{docNumber}');
    // Subject still reads naturally even with an empty slot.
    expect(out.subject.toLowerCase()).toContain('voided');
  });

  it('non-void event types unaffected by docNumber (no interpolation, no throw)', async () => {
    const out = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_issued',
      downloadUrl: DOWNLOAD_URL,
      locale: 'en',
      documentNumber: DOC_NUMBER,
    });
    // invoice_issued copy doesn't reference {docNumber} — substitution is a no-op.
    expect(out.subject).toBe('Your invoice is ready');
    expect(out.html).toContain(DOWNLOAD_URL);
  });

  it('T-3b TH — hasAttachment=false renders link-only clause (ผ่านลิงก์ด้านล่าง)', async () => {
    const out = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_voided',
      downloadUrl: DOWNLOAD_URL,
      locale: 'th',
      documentNumber: DOC_NUMBER,
      hasAttachment: false,
    });
    expect(out.html).toContain('ผ่านลิงก์ด้านล่าง');
    expect(out.html).not.toContain('ระบบได้แนบสำเนา');
    expect(out.text).toContain('ผ่านลิงก์ด้านล่าง');
  });

  it('T-3b SV — hasAttachment=false renders link-only clause (via länken nedan)', async () => {
    const out = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_voided',
      downloadUrl: DOWNLOAD_URL,
      locale: 'sv',
      documentNumber: DOC_NUMBER,
      hasAttachment: false,
    });
    expect(out.html).toContain('via länken nedan');
    expect(out.html).not.toContain('bifogas för dina register');
    expect(out.text).toContain('via länken nedan');
  });

  it('B-1 EN — voidReason renders as "Reason:" clause + HTML-escaped', async () => {
    const out = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_voided',
      downloadUrl: DOWNLOAD_URL,
      locale: 'en',
      documentNumber: DOC_NUMBER,
      hasAttachment: false,
      voidReason: 'Wrong <tier> selected & filed',
    });
    // Plain-text preserves the raw reason verbatim.
    expect(out.text).toContain('Reason: Wrong <tier> selected & filed');
    // HTML output must escape < > &.
    expect(out.html).toContain('Reason: Wrong &lt;tier&gt; selected &amp; filed');
    // Placeholder must not leak.
    expect(out.html).not.toContain('{reasonClause}');
    expect(out.text).not.toContain('{reasonClause}');
  });

  it('B-1 TH — voidReason renders with Thai "เหตุผล:" prefix', async () => {
    const out = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_voided',
      downloadUrl: DOWNLOAD_URL,
      locale: 'th',
      documentNumber: DOC_NUMBER,
      hasAttachment: true,
      voidReason: 'เลือกแพ็กเกจผิด',
    });
    expect(out.text).toContain('เหตุผล: เลือกแพ็กเกจผิด');
    expect(out.html).toContain('เหตุผล: เลือกแพ็กเกจผิด');
  });

  it('B-1 SV — voidReason renders with Swedish "Orsak:" prefix', async () => {
    const out = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_voided',
      downloadUrl: DOWNLOAD_URL,
      locale: 'sv',
      documentNumber: DOC_NUMBER,
      hasAttachment: true,
      voidReason: 'Fel medlemsnivå vald',
    });
    expect(out.text).toContain('Orsak: Fel medlemsnivå vald');
    expect(out.html).toContain('Orsak: Fel medlemsnivå vald');
  });

  it('B-1 — voidReason omitted → no "Reason:" clause + no placeholder leak', async () => {
    const out = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_voided',
      downloadUrl: DOWNLOAD_URL,
      locale: 'en',
      documentNumber: DOC_NUMBER,
      hasAttachment: false,
      // voidReason omitted
    });
    expect(out.html).not.toContain('Reason:');
    expect(out.text).not.toContain('Reason:');
    expect(out.html).not.toContain('{reasonClause}');
  });

  it('B-1 — whitespace-only voidReason treated as omitted', async () => {
    const out = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_voided',
      downloadUrl: DOWNLOAD_URL,
      locale: 'en',
      documentNumber: DOC_NUMBER,
      hasAttachment: false,
      voidReason: '   ',
    });
    expect(out.html).not.toContain('Reason:');
    expect(out.text).not.toContain('Reason:');
  });

  it('downloadUrl appears in both CTA link and plain-text fallback', async () => {
    const out = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_voided',
      downloadUrl: DOWNLOAD_URL,
      locale: 'en',
      documentNumber: DOC_NUMBER,
    });
    expect(out.html).toContain(`href="${DOWNLOAD_URL}"`);
    expect(out.text).toContain(DOWNLOAD_URL);
  });
});
