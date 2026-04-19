/**
 * T046 — @react-pdf/renderer adapter (F4).
 *
 * Renders a React tree → Uint8Array + sha256. Deterministic: runs
 * purely from input props with a fixed date string; no Date.now(),
 * no randomness. Registration of Sarabun fonts happens once at
 * module-init.
 */
import { renderToStream } from '@react-pdf/renderer';
import { createHash } from 'node:crypto';
import type {
  PdfRenderPort,
  PdfRenderInput,
  PdfRenderResult,
} from '../../application/ports/pdf-render-port';
import { asSha256Hex } from '../../domain/value-objects/sha256-hex';
import { registerSarabun } from '../pdf/fonts/register-sarabun';
import { InvoiceTemplate } from '../pdf/templates/invoice-template';

registerSarabun();

async function streamToBytes(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export const reactPdfRenderAdapter: PdfRenderPort = {
  async render(input: PdfRenderInput): Promise<PdfRenderResult> {
    const element = InvoiceTemplate(input);
    const stream = await renderToStream(element);
    const bytes = await streamToBytes(stream);
    // createHash('sha256').digest('hex') ALWAYS returns 64-char
    // lowercase hex by construction — `asSha256Hex` re-validates as
    // belt-and-suspenders, costs O(64) regex.
    const sha256 = asSha256Hex(createHash('sha256').update(bytes).digest('hex'));
    return { bytes, sha256 };
  },
};
