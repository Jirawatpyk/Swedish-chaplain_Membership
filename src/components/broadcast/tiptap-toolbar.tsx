'use client';

/**
 * T083 — Tiptap toolbar (bold / italic / underline / lists / link).
 *
 * Bilingual aria-labels via `useTranslations`. Ctrl+B/I/U keyboard
 * shortcuts handled by Tiptap's built-in StarterKit; the toolbar
 * surfaces them visually + announces state changes via the parent's
 * `onAnnounce` callback (CHK029 ARIA-live region in tiptap-editor.tsx).
 *
 * `event.isComposing` IME guard (CHK059) is automatic — Tiptap's
 * keyboard shortcut handlers respect IME composition state internally.
 */
import { useCallback, useState } from 'react';
import { type Editor } from '@tiptap/react';
import { useTranslations } from 'next-intl';
import {
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Link as LinkIcon,
  Unlink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

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
}

export function TiptapToolbar({
  editor,
  onAnnounce,
}: TiptapToolbarProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose.editor.aria');
  const tForm = useTranslations('portal.broadcasts.compose.fields');
  const [linkOpen, setLinkOpen] = useState<boolean>(false);
  const [linkUrl, setLinkUrl] = useState<string>('');

  const toggleBold = useCallback(() => {
    const willBeOn = !editor.isActive('bold');
    editor.chain().focus().toggleBold().run();
    onAnnounce(willBeOn ? 'boldOn' : 'boldOff');
  }, [editor, onAnnounce]);

  const toggleItalic = useCallback(() => {
    const willBeOn = !editor.isActive('italic');
    editor.chain().focus().toggleItalic().run();
    onAnnounce(willBeOn ? 'italicOn' : 'italicOff');
  }, [editor, onAnnounce]);

  const toggleUnderline = useCallback(() => {
    const willBeOn = !editor.isActive('underline');
    editor.chain().focus().toggleMark?.('underline').run();
    onAnnounce(willBeOn ? 'underlineOn' : 'underlineOff');
  }, [editor, onAnnounce]);

  const toggleBulletList = useCallback(() => {
    const willBeOn = !editor.isActive('bulletList');
    editor.chain().focus().toggleBulletList().run();
    onAnnounce(willBeOn ? 'bulletListOn' : 'bulletListOff');
  }, [editor, onAnnounce]);

  const toggleOrderedList = useCallback(() => {
    const willBeOn = !editor.isActive('orderedList');
    editor.chain().focus().toggleOrderedList().run();
    onAnnounce(willBeOn ? 'orderedListOn' : 'orderedListOff');
  }, [editor, onAnnounce]);

  const openLinkPopover = useCallback(() => {
    setLinkUrl(
      (editor.getAttributes('link').href as string | undefined) ?? '',
    );
    setLinkOpen(true);
  }, [editor]);

  const confirmLink = useCallback(() => {
    if (linkUrl.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      onAnnounce('linkCleared');
    } else {
      editor
        .chain()
        .focus()
        .extendMarkRange('link')
        .setLink({ href: linkUrl.trim() })
        .run();
      onAnnounce('linkSet');
    }
    setLinkOpen(false);
  }, [editor, linkUrl, onAnnounce]);

  const clearLink = useCallback(() => {
    editor.chain().focus().unsetLink().run();
    onAnnounce('linkCleared');
  }, [editor, onAnnounce]);

  const button = (
    label: string,
    active: boolean,
    onClick: () => void,
    Icon: React.ComponentType<{ className?: string }>,
    disabled = false,
  ) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'h-11 w-11 min-h-11 min-w-11 p-0',
        active && 'bg-accent text-accent-foreground',
      )}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </Button>
  );

  return (
    <div
      role="toolbar"
      aria-label={t('toolbar')}
      className="flex flex-wrap items-center gap-1 border-b bg-muted/30 p-1"
    >
      {button(t('bold'), editor.isActive('bold'), toggleBold, Bold)}
      {button(t('italic'), editor.isActive('italic'), toggleItalic, Italic)}
      {button(
        t('underline'),
        editor.isActive('underline'),
        toggleUnderline,
        Underline,
        !editor.can().toggleMark?.('underline'),
      )}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      {button(t('bulletList'), editor.isActive('bulletList'), toggleBulletList, List)}
      {button(
        t('orderedList'),
        editor.isActive('orderedList'),
        toggleOrderedList,
        ListOrdered,
      )}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      <Popover open={linkOpen} onOpenChange={setLinkOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t('link')}
              aria-pressed={editor.isActive('link')}
              onClick={openLinkPopover}
              className={cn(
                'h-11 w-11 min-h-11 min-w-11 p-0',
                editor.isActive('link') && 'bg-accent text-accent-foreground',
              )}
            >
              <LinkIcon className="h-4 w-4" aria-hidden="true" />
            </Button>
          }
        />
        <PopoverContent className="w-72 max-w-[calc(100vw-2rem)] space-y-2 p-3">
          <Label htmlFor="tiptap-link-url" className="text-xs">
            {tForm('linkUrlLabel')}
          </Label>
          <Input
            id="tiptap-link-url"
            type="url"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://example.com"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                confirmLink();
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setLinkOpen(false)}
            >
              {tForm('linkCancel')}
            </Button>
            <Button type="button" size="sm" onClick={confirmLink}>
              {tForm('linkConfirm')}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {button(
        t('clearLink'),
        false,
        clearLink,
        Unlink,
        !editor.isActive('link'),
      )}
    </div>
  );
}
