import { jsonLd } from '@/lib/seo';

/**
 * Structured data for search engines (…021). Data blocks are not executed, so
 * CSP script-src does not apply; React renders script text raw, and jsonLd()
 * escapes "<" so content can never close the tag.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return <script type="application/ld+json">{jsonLd(data)}</script>;
}
