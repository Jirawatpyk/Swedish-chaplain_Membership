'use client';

/**
 * F119 T088 + T094 + T098 (FR-038, FR-044, FR-048) — the E-Blast writing
 * tool's toolbar.
 *
 * **One control per construct the platform keeps, and nothing else.** The set
 * below is the shared content policy's set: H2 and H3 (the subject is the
 * email's title, so H1 is never offered), quote, divider, bulleted and
 * numbered lists, bold, italic, underline, link, image, CTA button, banner.
 * A control with no matching construct would promise formatting the sanitiser
 * deletes on the way to the inbox; a construct with no control leaves the
 * feature discoverable only by shortcut. The other half of that guarantee is
 * the schema — see `broadcast-editor-extensions.ts`.
 *
 * **APG roving tabindex (T098).** The toolbar is ONE tab stop: the active
 * control carries `tabindex="0"`, every other carries `-1`, and ArrowLeft /
 * ArrowRight (wrapping) plus Home / End move within it. Before F119 this was
 * `role="toolbar"` with a tab stop per button, so a keyboard user Tabbing out
 * of the subject field walked through seven buttons before reaching the
 * message body. Focus is moved by querying `[data-toolbar-control]` inside the
 * container rather than by holding a ref per button, so the control list can
 * grow or shrink (locale, image flag) without an index/ref mismatch.
 *
 * **Italic under `th` (FR-044).** Thai has no italic form — sloped Thai is a
 * synthetic transform that hurts legibility — so the CONTROL is dropped when
 * the interface language is Thai. The italic MARK stays in the schema, so
 * `<em>` from a paste or a template survives untouched.
 *
 * At 320 px the strip WRAPS onto further rows (`flex-wrap`). There is
 * deliberately no overflow menu: a formatting control hidden behind a "More"
 * button at phone width is a control most authors never find.
 */
import { useCallback, useRef, useState } from 'react';
import { type Editor } from '@tiptap/react';
import { useLocale, useTranslations } from 'next-intl';
import {
  Bold,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  MousePointerClick,
  Quote,
  RectangleHorizontal,
  Underline,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { LinkDialog } from './link-dialog';
import { CtaButtonDialog } from './cta-button-dialog';

/**
 * T155 finding U6 — id of the VISIBLE sentence that explains why the Image and
 * Banner controls are unavailable ("Save this draft first to enable image
 * uploads."). `tiptap-editor.tsx` renders it on exactly the same condition
 * that makes those controls `aria-disabled`, so the `aria-describedby` target
 * exists whenever it is referenced and never dangles.
 *
 * `title` alone was the whole explanation before this: hover-only (no touch,
 * no keyboard) and not a reliable description once an `aria-label` is present.
 */
export const IMAGE_DISABLED_HINT_ID = 'broadcast-image-draft-required-hint';

export type AnnounceKey =
  | 'boldOn'
  | 'boldOff'
  | 'italicOn'
  | 'italicOff'
  | 'underlineOn'
  | 'underlineOff'
  | 'bulletListOn'
  | 'bulletListOff'
  | 'orderedListOn'
  | 'orderedListOff'
  | 'linkSet'
  | 'linkCleared';

export interface TiptapToolbarProps {
  readonly editor: Editor;
  readonly onAnnounce: (state: AnnounceKey) => void;
  /** Mirrors the editor's image flag — with it off, `<img>` is forbidden, so both image controls go. */
  readonly imagesEnabled?: boolean;
  /** False while the draft is unsaved: uploads are tied to a draft, so the control explains itself instead of failing. */
  readonly imageInsertEnabled?: boolean;
  readonly onInsertImage?: () => void;
  readonly onInsertBanner?: () => void;
}

interface ToolbarControl {
  readonly key: string;
  readonly label: string;
  readonly Icon: React.ComponentType<{ className?: string }>;
  readonly onActivate: () => void;
  /** Toggles report their state; one-shot inserts and dialog openers do not. */
  readonly pressed?: boolean;
  readonly opensDialog?: boolean;
  readonly unavailable?: boolean;
  readonly title?: string;
}

export function TiptapToolbar({
  editor,
  onAnnounce,
  imagesEnabled = false,
  imageInsertEnabled = true,
  onInsertImage,
  onInsertBanner,
}: TiptapToolbarProps): React.ReactElement {
  const t = useTranslations('broadcast.editor.toolbar');
  const locale = useLocale();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [linkOpen, setLinkOpen] = useState<boolean>(false);
  const [ctaOpen, setCtaOpen] = useState<boolean>(false);

  const toggle = useCallback(
    (isActive: boolean, run: () => void, on: AnnounceKey, off: AnnounceKey) => {
      const willBeOn = !isActive;
      run();
      onAnnounce(willBeOn ? on : off);
    },
    [onAnnounce],
  );

  const selectionText = (): string => {
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, ' ');
  };

  const applyLink = ({ href, text }: { href: string; text: string }): void => {
    const selected = selectionText();
    const label = text !== '' ? text : selected !== '' ? selected : href;
    if (label !== selected) {
      // The author renamed the link (or there was no selection): replace the
      // range with the label carrying the link mark, so "click here" can become
      // "our 2026 report" without leaving the dialog.
      editor
        .chain()
        .focus()
        .extendMarkRange('link')
        .insertContent({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] })
        .run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
    onAnnounce('linkSet');
  };

  const removeLink = (): void => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    onAnnounce('linkCleared');
  };

  const controls: ToolbarControl[] = [
    {
      key: 'heading2',
      label: t('heading2'),
      Icon: Heading2,
      pressed: editor.isActive('heading', { level: 2 }),
      onActivate: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      key: 'heading3',
      label: t('heading3'),
      Icon: Heading3,
      pressed: editor.isActive('heading', { level: 3 }),
      onActivate: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    },
    {
      key: 'quote',
      label: t('quote'),
      Icon: Quote,
      pressed: editor.isActive('blockquote'),
      onActivate: () => editor.chain().focus().toggleBlockquote().run(),
    },
    {
      key: 'divider',
      label: t('divider'),
      Icon: Minus,
      onActivate: () => editor.chain().focus().setHorizontalRule().run(),
    },
    {
      key: 'bulletList',
      label: t('bulletList'),
      Icon: List,
      pressed: editor.isActive('bulletList'),
      onActivate: () =>
        toggle(
          editor.isActive('bulletList'),
          () => editor.chain().focus().toggleBulletList().run(),
          'bulletListOn',
          'bulletListOff',
        ),
    },
    {
      key: 'orderedList',
      label: t('orderedList'),
      Icon: ListOrdered,
      pressed: editor.isActive('orderedList'),
      onActivate: () =>
        toggle(
          editor.isActive('orderedList'),
          () => editor.chain().focus().toggleOrderedList().run(),
          'orderedListOn',
          'orderedListOff',
        ),
    },
    {
      key: 'bold',
      label: t('bold'),
      Icon: Bold,
      pressed: editor.isActive('bold'),
      onActivate: () =>
        toggle(
          editor.isActive('bold'),
          () => editor.chain().focus().toggleBold().run(),
          'boldOn',
          'boldOff',
        ),
    },
    // FR-044 — the control only; the mark stays registered in every locale.
    ...(locale === 'th'
      ? []
      : [
          {
            key: 'italic',
            label: t('italic'),
            Icon: Italic,
            pressed: editor.isActive('italic'),
            onActivate: () =>
              toggle(
                editor.isActive('italic'),
                () => editor.chain().focus().toggleItalic().run(),
                'italicOn',
                'italicOff',
              ),
          } satisfies ToolbarControl,
        ]),
    {
      key: 'underline',
      label: t('underline'),
      Icon: Underline,
      pressed: editor.isActive('underline'),
      onActivate: () =>
        toggle(
          editor.isActive('underline'),
          () => editor.chain().focus().toggleUnderline().run(),
          'underlineOn',
          'underlineOff',
        ),
    },
    {
      key: 'link',
      label: t('link'),
      Icon: LinkIcon,
      pressed: editor.isActive('link'),
      opensDialog: true,
      onActivate: () => setLinkOpen(true),
    },
    ...(imagesEnabled
      ? [
          {
            key: 'image',
            label: t('image'),
            Icon: ImageIcon,
            opensDialog: true,
            unavailable: !imageInsertEnabled,
            ...(imageInsertEnabled ? {} : { title: t('imageNeedsDraft') }),
            onActivate: () => {
              if (imageInsertEnabled) onInsertImage?.();
            },
          } satisfies ToolbarControl,
        ]
      : []),
    {
      key: 'cta',
      label: t('cta'),
      Icon: MousePointerClick,
      opensDialog: true,
      onActivate: () => setCtaOpen(true),
    },
    ...(imagesEnabled
      ? [
          {
            key: 'banner',
            label: t('banner'),
            Icon: RectangleHorizontal,
            opensDialog: true,
            unavailable: !imageInsertEnabled,
            ...(imageInsertEnabled ? {} : { title: t('imageNeedsDraft') }),
            onActivate: () => {
              if (imageInsertEnabled) onInsertBanner?.();
            },
          } satisfies ToolbarControl,
        ]
      : []),
  ];

  const controlElements = (): HTMLButtonElement[] =>
    Array.from(
      containerRef.current?.querySelectorAll<HTMLButtonElement>('[data-toolbar-control]') ?? [],
    );

  const focusAt = (index: number): void => {
    setActiveIndex(index);
    controlElements()[index]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const count = controls.length;
    if (count === 0) return;
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusAt((activeIndex + 1) % count);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        focusAt((activeIndex - 1 + count) % count);
        return;
      case 'Home':
        event.preventDefault();
        focusAt(0);
        return;
      case 'End':
        event.preventDefault();
        focusAt(count - 1);
        return;
      default:
        return;
    }
  };

  // The index can outlive its control (the image flag flips, the locale
  // changes): clamp so the toolbar always has exactly one tab stop.
  const tabStop = Math.min(activeIndex, Math.max(controls.length - 1, 0));

  return (
    <>
      <div
        ref={containerRef}
        role="toolbar"
        aria-label={t('label')}
        onKeyDown={handleKeyDown}
        className="flex flex-wrap items-center gap-1 border-b bg-muted/30 p-1"
      >
        {controls.map((control, index) => (
          <Button
            key={control.key}
            type="button"
            variant="ghost"
            size="sm"
            data-toolbar-control={control.key}
            aria-label={control.label}
            {...(control.pressed !== undefined && { 'aria-pressed': control.pressed })}
            {...(control.opensDialog === true && { 'aria-haspopup': 'dialog' as const })}
            {...(control.unavailable === true && {
              'aria-disabled': true,
              // U6 — the reason, reachable without a pointer. `unavailable` is
              // set only by the two image controls, and only while no draft is
              // saved, which is exactly when the hint is on the page.
              'aria-describedby': IMAGE_DISABLED_HINT_ID,
            })}
            {...(control.title !== undefined && { title: control.title })}
            tabIndex={index === tabStop ? 0 : -1}
            onFocus={() => setActiveIndex(index)}
            onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
              triggerRef.current = event.currentTarget;
              control.onActivate();
            }}
            className={cn(
              'h-11 w-11 min-h-11 min-w-11 p-0',
              control.pressed === true && 'bg-accent text-accent-foreground',
              control.unavailable === true && 'opacity-50',
            )}
          >
            <control.Icon className="h-4 w-4" aria-hidden="true" />
          </Button>
        ))}
      </div>

      <LinkDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        canRemove={editor.isActive('link')}
        initialHref={(editor.getAttributes('link')['href'] as string | undefined) ?? ''}
        initialText={selectionText()}
        onConfirm={applyLink}
        onRemove={removeLink}
        finalFocus={() => triggerRef.current}
      />
      <CtaButtonDialog
        open={ctaOpen}
        onOpenChange={setCtaOpen}
        onConfirm={({ href, text }) => editor.chain().focus().setCtaButton({ href, text }).run()}
        finalFocus={() => triggerRef.current}
      />
    </>
  );
}
