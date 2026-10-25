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
 *
 * Spec 122 US12d-2: each control is an AURA `IconButton`, 32px on desktop and
 * 44px on touch / phone widths (`touchHeight`), as the compose boards draw it.
 * Its `label` is the accessible name and AURA's own tooltip, on every control:
 * the two unavailable image controls give their reason through the visible
 * hint they are described by, not a hover-only `title` (which would also turn
 * AURA's tooltip off). AURA has no Toolbar, so the roving tabindex above stays
 * the app's.
 */
import { useCallback, useRef, useState } from 'react';
import { getMarkRange } from '@tiptap/core';
import { type Editor, useEditorState } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
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
  Redo2,
  Underline,
  Undo2,
} from 'lucide-react';
import { IconButton } from '@jirawatpyk/aura-react';
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
  /** While the host saves or submits, every control is unavailable (round 2, #3). */
  readonly disabled?: boolean;
}

interface CtaTarget {
  /** The selected button block's position, or null for a new button. */
  readonly editPos: number | null;
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly href: string;
}

interface LinkTarget {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly sameBlock: boolean;
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
  /** The visible reason a control is unavailable, when it has one. */
  readonly describedBy?: string;
}

export function TiptapToolbar({
  editor,
  onAnnounce,
  imagesEnabled = false,
  imageInsertEnabled = true,
  onInsertImage,
  onInsertBanner,
  disabled = false,
}: TiptapToolbarProps): React.ReactElement {
  const t = useTranslations('broadcast.editor.toolbar');
  const locale = useLocale();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [linkOpen, setLinkOpen] = useState<boolean>(false);
  const [ctaOpen, setCtaOpen] = useState<boolean>(false);
  // Set by a confirmed link or button dialog, so focus goes back to the text
  // (round 2, #18); a cancelled dialog returns it to the control.
  const confirmedRef = useRef<boolean>(false);
  const dialogFinalFocus = (): HTMLElement | null =>
    confirmedRef.current ? editor.view.dom : triggerRef.current;

  // Round 2, #7: Tiptap v3 does not re-render on every transaction, so state
  // read during render went stale as the caret moved (Bold read "off" inside
  // bold text). `useEditorState` re-renders the toolbar when these change.
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      heading2: e.isActive('heading', { level: 2 }),
      heading3: e.isActive('heading', { level: 3 }),
      quote: e.isActive('blockquote'),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      link: e.isActive('link'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const toggle = useCallback(
    (isActive: boolean, run: () => void, on: AnnounceKey, off: AnnounceKey) => {
      const willBeOn = !isActive;
      run();
      onAnnounce(willBeOn ? on : off);
    },
    [onAnnounce],
  );

  /**
   * What the link dialog works on, captured when it opens (round 2, #2/#9):
   * with the caret inside a link and nothing selected, the WHOLE link, so its
   * words pre-fill the dialog and survive an address-only edit (before, the
   * empty selection made Save replace "our 2026 report" with the URL). A
   * selection across blocks cannot become one line of text without merging
   * the paragraphs and dropping any image in it, so there only the mark is set.
   */
  const [linkTarget, setLinkTarget] = useState<LinkTarget>({ from: 0, to: 0, text: '', sameBlock: true });

  const captureLinkTarget = (): LinkTarget => {
    const { state } = editor;
    const { from, to, empty, $from, $to } = state.selection;
    const linkType = state.schema.marks['link'];
    if (empty && linkType !== undefined) {
      const range = getMarkRange($from, linkType);
      if (range !== undefined) {
        return { ...range, text: state.doc.textBetween(range.from, range.to, ' '), sameBlock: true };
      }
    }
    return { from, to, text: state.doc.textBetween(from, to, ' '), sameBlock: $from.sameParent($to) };
  };

  const applyLink = ({ href, text }: { href: string; text: string }): void => {
    const target = linkTarget;
    const label = text !== '' ? text : target.text !== '' ? target.text : href;
    if (!target.sameBlock || (label === target.text && target.from !== target.to)) {
      editor.chain().focus().setTextSelection({ from: target.from, to: target.to }).setLink({ href }).run();
    } else {
      // A new link, or one renamed in the dialog: the label carrying the mark
      // replaces the range, then the mark is dropped at the caret so the next
      // character typed is not part of the link (#8).
      editor
        .chain()
        .focus()
        .insertContentAt(
          { from: target.from, to: target.to },
          { type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] },
        )
        .unsetMark('link')
        .run();
    }
    onAnnounce('linkSet');
  };

  /**
   * Round 2, #6 — what the button dialog works on: the selected button block
   * (edited in place), or the selected words in one block, which pre-fill a
   * new button and are replaced by it. Captured when the dialog opens.
   */
  const [ctaTarget, setCtaTarget] = useState<CtaTarget>({ editPos: null, from: 0, to: 0, text: '', href: '' });

  const captureCtaTarget = (): CtaTarget => {
    const { selection, doc } = editor.state;
    if (selection instanceof NodeSelection && selection.node.type.name === 'ctaButton') {
      const href: unknown = selection.node.attrs['href'];
      return {
        editPos: selection.from,
        from: selection.from,
        to: selection.to,
        text: selection.node.textContent,
        href: typeof href === 'string' ? href : '',
      };
    }
    const { from, to, $from, $to } = selection;
    const words = $from.sameParent($to) ? doc.textBetween(from, to, ' ').trim() : '';
    return { editPos: null, from, to, text: words, href: '' };
  };

  const applyCta = ({ href, text }: { href: string; text: string }): void => {
    const target = ctaTarget;
    const node = { type: 'ctaButton', attrs: { href }, content: [{ type: 'text', text }] };
    if (target.editPos !== null || target.text !== '') {
      editor.chain().focus().insertContentAt({ from: target.from, to: target.to }, node).run();
    } else {
      editor.chain().focus().setCtaButton({ href, text }).run();
    }
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
      pressed: active.heading2,
      onActivate: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      key: 'heading3',
      label: t('heading3'),
      Icon: Heading3,
      pressed: active.heading3,
      onActivate: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    },
    {
      key: 'quote',
      label: t('quote'),
      Icon: Quote,
      pressed: active.quote,
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
      pressed: active.bulletList,
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
      pressed: active.orderedList,
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
      pressed: active.bold,
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
            pressed: active.italic,
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
      pressed: active.underline,
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
      pressed: active.link,
      opensDialog: true,
      onActivate: () => {
        confirmedRef.current = false;
        setLinkTarget(captureLinkTarget());
        setLinkOpen(true);
      },
    },
    ...(imagesEnabled
      ? [
          {
            key: 'image',
            label: t('image'),
            Icon: ImageIcon,
            opensDialog: true,
            unavailable: !imageInsertEnabled,
            describedBy: IMAGE_DISABLED_HINT_ID,
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
      onActivate: () => {
        confirmedRef.current = false;
        setCtaTarget(captureCtaTarget());
        setCtaOpen(true);
      },
    },
    ...(imagesEnabled
      ? [
          {
            key: 'banner',
            label: t('banner'),
            Icon: RectangleHorizontal,
            opensDialog: true,
            unavailable: !imageInsertEnabled,
            describedBy: IMAGE_DISABLED_HINT_ID,
            onActivate: () => {
              if (imageInsertEnabled) onInsertBanner?.();
            },
          } satisfies ToolbarControl,
        ]
      : []),
    // Round 2, #16 — a visible way back on touch screens, where there is no
    // Ctrl+Z: a deleted banner or button can be restored. Not on the boards
    // (spec 122 Session 2026-10-25).
    {
      key: 'undo',
      label: t('undo'),
      Icon: Undo2,
      unavailable: !active.canUndo,
      onActivate: () => {
        if (editor.can().undo()) editor.chain().focus().undo().run();
      },
    },
    {
      key: 'redo',
      label: t('redo'),
      Icon: Redo2,
      unavailable: !active.canRedo,
      onActivate: () => {
        if (editor.can().redo()) editor.chain().focus().redo().run();
      },
    },
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
        // Sticky below the shell bar, so a long message never scrolls the
        // formatting out of reach (round 2, #11); the frame clips, not scrolls.
        className="sticky top-[var(--shell-bar-height,0px)] z-10 flex flex-wrap items-center gap-1 border-b border-[var(--aura-border-default)] bg-[var(--aura-bg-input)] p-1.5"
      >
        {controls.map((control, index) => (
          <IconButton
            key={control.key}
            icon={<control.Icon />}
            label={control.label}
            touchHeight
            data-toolbar-control={control.key}
            {...(control.pressed !== undefined && { 'aria-pressed': control.pressed })}
            {...(control.opensDialog === true && { 'aria-haspopup': 'dialog' as const })}
            {...((control.unavailable === true || disabled) && { 'aria-disabled': true })}
            {...(control.unavailable === true &&
              control.describedBy !== undefined && {
                // U6 — the reason, reachable without a pointer.
                'aria-describedby': control.describedBy,
              })}
            tabIndex={index === tabStop ? 0 : -1}
            onFocus={() => setActiveIndex(index)}
            onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
              if (disabled) return;
              triggerRef.current = event.currentTarget;
              control.onActivate();
            }}
            className={cn(
              // AURA's IconButton has no pressed (toggle) look: stand-in until AURA #180.
              // The fill alone is ~1.07:1 on white, so an accent edge marks the
              // state (AURA's selected-segment rule), and forced colours keep
              // it as a Highlight outline.
              'aria-pressed:bg-[var(--aura-bg-selected)] aria-pressed:text-[var(--aura-fg-accent)]',
              'aria-pressed:shadow-[inset_0_0_0_1px_var(--aura-fg-accent)]',
              'forced-colors:aria-pressed:outline-2 forced-colors:aria-pressed:outline-[Highlight] forced-colors:aria-pressed:-outline-offset-2',
              (control.unavailable === true || disabled) && 'opacity-[var(--aura-disabled-opacity)]',
            )}
          />
        ))}
      </div>

      <LinkDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        canRemove={active.link}
        initialHref={(editor.getAttributes('link')['href'] as string | undefined) ?? ''}
        initialText={linkTarget.text}
        editing={active.link}
        textReadOnly={!linkTarget.sameBlock}
        onConfirm={(link) => {
          confirmedRef.current = true;
          applyLink(link);
        }}
        onRemove={() => {
          confirmedRef.current = true;
          removeLink();
        }}
        finalFocus={dialogFinalFocus}
      />
      <CtaButtonDialog
        open={ctaOpen}
        onOpenChange={setCtaOpen}
        initialText={ctaTarget.text}
        initialHref={ctaTarget.href}
        editing={ctaTarget.editPos !== null}
        onConfirm={({ href, text }) => {
          confirmedRef.current = true;
          applyCta({ href, text });
        }}
        finalFocus={dialogFinalFocus}
      />
    </>
  );
}
