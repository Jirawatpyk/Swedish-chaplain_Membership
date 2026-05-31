/**
 * F9 US5 `LogoStorePort` Vercel Blob adapter (T079 / FR-025a).
 *
 * Logos are PUBLIC because the re-encoded image is referenced **by URL in the
 * JSON export** (the E-Book PDF does not currently embed it — see
 * `directory-ebook-document.tsx`) and Vercel Blob doesn't gate image fetches
 * behind auth. `addRandomSuffix: true` makes the URL unguessable, and only the
 * RE-ENCODED bytes are ever uploaded (the original is never served, FR-025a).
 */
import { put, del } from '@vercel/blob';
import { env } from '@/lib/env';
import type { LogoStorePort } from '../../application/ports/logo-port';

export const publicLogoBlobAdapter: LogoStorePort = {
  async putPublicLogo(input): Promise<{ readonly url: string }> {
    const result = await put(input.key, Buffer.from(input.body), {
      access: 'public',
      contentType: input.contentType,
      token: env.blob.readWriteToken,
      addRandomSuffix: true,
      allowOverwrite: false,
    });
    return { url: result.url };
  },

  async deleteLogo(urlOrKey: string): Promise<void> {
    await del(urlOrKey, { token: env.blob.readWriteToken });
  },
};
