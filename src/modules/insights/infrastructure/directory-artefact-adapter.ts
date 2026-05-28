/**
 * F9 US5 `DirectoryArtefactPort` adapter (T080/T081).
 *
 * Renders the projected directory into a PDF E-Book (react-pdf, Sarabun
 * embedded) or a structured JSON export. The Sarabun font assets are the same
 * OFL TTFs F4 ships under `public/fonts/sarabun`, registered here independently
 * so the insights module stays decoupled from the invoicing module
 * (Constitution Principle III — no cross-module deep import).
 */
import path from 'node:path';
import { Font, renderToStream } from '@react-pdf/renderer';
import type {
  BuiltArtefact,
  DirectoryArtefactInput,
  DirectoryArtefactPort,
} from '../application/ports/directory-artefact-port';
import { DirectoryEbookDocument } from './pdf/directory-ebook-document';

let fontsRegistered = false;
function registerFonts(): void {
  if (fontsRegistered) return;
  const dir = path.join(process.cwd(), 'public', 'fonts', 'sarabun');
  Font.register({
    family: 'Sarabun',
    fonts: [
      { src: path.join(dir, 'Sarabun-Regular.ttf'), fontWeight: 400 },
      { src: path.join(dir, 'Sarabun-Medium.ttf'), fontWeight: 500 },
      { src: path.join(dir, 'Sarabun-Bold.ttf'), fontWeight: 700 },
    ],
  });
  // Directory names/descriptions never hyphenate across lines (keeps the
  // deterministic layout + avoids splitting company names oddly).
  Font.registerHyphenationCallback((word) => [word]);
  fontsRegistered = true;
}

async function streamToBytes(
  stream: NodeJS.ReadableStream,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export const directoryArtefactAdapter: DirectoryArtefactPort = {
  async buildEbookPdf(input: DirectoryArtefactInput): Promise<BuiltArtefact> {
    registerFonts();
    // Call the component directly — its <Document> root makes it a
    // ReactElement<DocumentProps>, matching renderToStream (F4 pattern).
    const element = DirectoryEbookDocument({
      tenantName: input.tenantName,
      locale: input.locale,
      generatedAtIso: input.generatedAtIso,
      listings: input.listings,
    });
    const stream = await renderToStream(element);
    const bytes = await streamToBytes(stream);
    return { bytes, contentType: 'application/pdf', extension: 'pdf' };
  },

  async buildJson(input: DirectoryArtefactInput): Promise<BuiltArtefact> {
    // Structured, nested, opt-in-only export for the tenant's own website
    // (FR-027). `listings` is already the SC-007-projected set (chosen fields
    // only); JSON.stringify preserves the optional-field structure.
    const envelope = {
      tenant: input.tenantName,
      generatedAt: input.generatedAtIso,
      count: input.listings.length,
      listings: input.listings,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope, null, 2));
    return { bytes, contentType: 'application/json', extension: 'json' };
  },
};
