/**
 * T042 — Sarabun font registration for @react-pdf/renderer (F4).
 *
 * Runs at module-load time. Registering the same family twice is
 * harmless (idempotent in the library).
 */
import path from 'node:path';
import { Font } from '@react-pdf/renderer';

const FONT_DIR = path.join(process.cwd(), 'public', 'fonts', 'sarabun');

let registered = false;

export function registerSarabun(): void {
  if (registered) return;
  registered = true;
  Font.register({
    family: 'Sarabun',
    fonts: [
      { src: path.join(FONT_DIR, 'Sarabun-Regular.ttf'), fontWeight: 400 },
      { src: path.join(FONT_DIR, 'Sarabun-Medium.ttf'), fontWeight: 500 },
      { src: path.join(FONT_DIR, 'Sarabun-Bold.ttf'), fontWeight: 700 },
    ],
  });
}
