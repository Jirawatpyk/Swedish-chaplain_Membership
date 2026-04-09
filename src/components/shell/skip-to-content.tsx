/**
 * SkipToContent — keyboard accessibility shortcut (T046, ux-standards § 7.1).
 *
 * Renders a visually-hidden link that becomes visible when focused
 * (Tab from the address bar). Activating it scrolls + focuses
 * `#main-content` so screen-reader and keyboard users can bypass the
 * navigation chrome.
 *
 * The matching `.skip-to-content` class is in `src/app/globals.css`.
 */
import { useTranslations } from 'next-intl';

export function SkipToContent() {
  const t = useTranslations('shell');
  return (
    <a href="#main-content" className="skip-to-content">
      {t('skipToContent')}
    </a>
  );
}
