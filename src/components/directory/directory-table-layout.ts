/**
 * The staff directory table's columns: key, label key (`admin.directory.table.*`)
 * and size. Shared by `DirectoryTable` and the route's loading skeleton, so
 * the skeleton grid lands where the real one does (CLS 0, ux-standards § 2.1).
 * Plain data, no client code: the server `loading.tsx` imports it.
 *
 * Industry, Logo and Contact drop out on a table narrower than `lg` (a tablet,
 * or a laptop beside the nav), so the rest fits without scrolling; a phone
 * card still shows every field.
 */
export const DIRECTORY_COLUMN_LAYOUT = [
  { key: 'companyName', labelKey: 'company' },
  { key: 'tier', labelKey: 'tier', width: 170 },
  { key: 'industry', labelKey: 'industry', width: 160, hideBelow: 'lg' },
  { key: 'location', labelKey: 'location', width: 130 },
  { key: 'listed', labelKey: 'listed', width: 90, pill: true },
  { key: 'hasLogo', labelKey: 'logo', width: 64, hideBelow: 'lg' },
  { key: 'contactName', labelKey: 'contact', width: 150, hideBelow: 'lg' },
] as const;

export type DirectoryColumnKey = (typeof DIRECTORY_COLUMN_LAYOUT)[number]['key'];
