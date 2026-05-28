/**
 * F9 US5 — Directory E-Book react-pdf document (T080 / FR-026).
 *
 * A deterministically-laid-out, chamber-branded PDF of the opt-in published
 * directory. Field LABELS render in the tenant default locale; member-entered
 * content (name, description) renders as authored. Sarabun is embedded so a
 * TH-locale tenant renders Thai content correctly (reuses the F4 font assets).
 *
 * Layout is reproducible: listings arrive pre-ordered by company name and the
 * projection has already stripped hidden fields, so the same directory state
 * always produces the same document structure (AS-5).
 */
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer';
import type { PublishedListing } from '../../domain/directory-listing';

type Locale = 'en' | 'th' | 'sv';

interface LabelSet {
  readonly title: string;
  readonly tier: string;
  readonly industry: string;
  readonly location: string;
  readonly website: string;
  readonly contact: string;
  readonly contactForm: string;
  readonly generated: string;
  readonly empty: string;
}

const LABELS: Record<Locale, LabelSet> = {
  en: {
    title: 'Member Directory',
    tier: 'Tier',
    industry: 'Industry',
    location: 'Location',
    website: 'Website',
    contact: 'Contact',
    contactForm: 'via contact form',
    generated: 'Generated',
    empty: 'No published listings.',
  },
  th: {
    title: 'ทำเนียบสมาชิก',
    tier: 'ระดับสมาชิก',
    industry: 'อุตสาหกรรม',
    location: 'ที่ตั้ง',
    website: 'เว็บไซต์',
    contact: 'ติดต่อ',
    contactForm: 'ผ่านแบบฟอร์มติดต่อ',
    generated: 'สร้างเมื่อ',
    empty: 'ยังไม่มีรายชื่อที่เผยแพร่',
  },
  sv: {
    title: 'Medlemskatalog',
    tier: 'Nivå',
    industry: 'Bransch',
    location: 'Plats',
    website: 'Webbplats',
    contact: 'Kontakt',
    contactForm: 'via kontaktformulär',
    generated: 'Genererad',
    empty: 'Inga publicerade poster.',
  },
};

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Sarabun',
    fontSize: 10,
    paddingTop: 48,
    paddingBottom: 56,
    paddingHorizontal: 48,
    color: '#1f2937',
  },
  header: { marginBottom: 18, borderBottomWidth: 1, borderBottomColor: '#0f766e', paddingBottom: 10 },
  chamber: { fontSize: 18, fontWeight: 700, color: '#0f766e' },
  title: { fontSize: 12, fontWeight: 500, marginTop: 2 },
  meta: { fontSize: 8, color: '#6b7280', marginTop: 4 },
  listing: {
    marginBottom: 12,
    paddingBottom: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: '#e5e7eb',
  },
  name: { fontSize: 12, fontWeight: 700 },
  row: { flexDirection: 'row', marginTop: 2 },
  label: { width: 70, color: '#6b7280', fontWeight: 500 },
  value: { flex: 1 },
  description: { marginTop: 4, color: '#374151' },
  empty: { marginTop: 40, textAlign: 'center', color: '#6b7280' },
  footer: {
    position: 'absolute',
    bottom: 28,
    left: 48,
    right: 48,
    textAlign: 'center',
    fontSize: 8,
    color: '#9ca3af',
  },
});

function localeOf(value: string): Locale {
  return value === 'th' || value === 'sv' ? value : 'en';
}

function locationText(loc: PublishedListing['location']): string | null {
  if (loc === undefined) return null;
  return [loc.city, loc.country].filter((p): p is string => p != null).join(', ') || null;
}

function contactText(
  contact: PublishedListing['contact'],
  L: LabelSet,
): string | null {
  if (contact === undefined) return null;
  if (contact.email !== undefined) {
    return contact.name !== undefined ? `${contact.name} — ${contact.email}` : contact.email;
  }
  if (contact.name !== undefined) return `${contact.name} (${L.contactForm})`;
  return L.contactForm;
}

export interface DirectoryEbookDocumentProps {
  readonly tenantName: string;
  readonly locale: string;
  readonly generatedAtIso: string;
  readonly listings: readonly PublishedListing[];
}

export function DirectoryEbookDocument(props: DirectoryEbookDocumentProps) {
  const L = LABELS[localeOf(props.locale)];
  return (
    <Document title={`${props.tenantName} — ${L.title}`}>
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.header} fixed>
          <Text style={styles.chamber}>{props.tenantName}</Text>
          <Text style={styles.title}>{L.title}</Text>
          <Text style={styles.meta}>
            {L.generated}: {props.generatedAtIso}
          </Text>
        </View>

        {props.listings.length === 0 ? (
          <Text style={styles.empty}>{L.empty}</Text>
        ) : (
          props.listings.map((listing, i) => {
            const location = locationText(listing.location);
            const contact = contactText(listing.contact, L);
            return (
              <View style={styles.listing} key={i} wrap={false}>
                <Text style={styles.name}>{listing.name ?? '—'}</Text>
                {listing.tier !== undefined && (
                  <View style={styles.row}>
                    <Text style={styles.label}>{L.tier}</Text>
                    <Text style={styles.value}>{listing.tier}</Text>
                  </View>
                )}
                {listing.industry !== undefined && (
                  <View style={styles.row}>
                    <Text style={styles.label}>{L.industry}</Text>
                    <Text style={styles.value}>{listing.industry}</Text>
                  </View>
                )}
                {location !== null && (
                  <View style={styles.row}>
                    <Text style={styles.label}>{L.location}</Text>
                    <Text style={styles.value}>{location}</Text>
                  </View>
                )}
                {listing.website !== undefined && (
                  <View style={styles.row}>
                    <Text style={styles.label}>{L.website}</Text>
                    <Text style={styles.value}>{listing.website}</Text>
                  </View>
                )}
                {contact !== null && (
                  <View style={styles.row}>
                    <Text style={styles.label}>{L.contact}</Text>
                    <Text style={styles.value}>{contact}</Text>
                  </View>
                )}
                {listing.description !== undefined && (
                  <Text style={styles.description}>{listing.description}</Text>
                )}
              </View>
            );
          })
        )}

        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`}
        />
      </Page>
    </Document>
  );
}
