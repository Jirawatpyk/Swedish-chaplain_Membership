'use client';

/**
 * Spec 122 US12d-2 — the E-Blast editor as the compose hosts mount it, for
 * board checks: images on, a saved draft (`draft`) or none yet (`unsaved`,
 * the two image controls unavailable with their hint).
 */
import TiptapEditor from '@/components/broadcast/tiptap-editor';

const SAMPLE =
  '<h2>Nordic Business Evening</h2><p>Join us on <strong>14 November</strong> at the Residence. <a href="https://swecham.example/events">See the programme</a>.</p><ul><li>Networking from 18:00</li><li>Dinner at 19:30</li></ul>';

export function EditorPreview({ state }: { readonly state: string | undefined }): React.ReactElement {
  return (
    <div className="max-w-3xl">
      <TiptapEditor
        initialHtml={SAMPLE}
        onChange={() => {}}
        imagesEnabled
        draftId={state === 'unsaved' ? null : 'preview-draft'}
        invalid={state === 'invalid'}
      />
    </div>
  );
}
