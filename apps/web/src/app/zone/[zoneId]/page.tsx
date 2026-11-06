import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { FeedPage } from '@/components/feed/FeedPage';
import { parseFeedParams } from '@/lib/params';
import { getLocale } from '@/server/context';
import { getTaxonomy } from '@/server/queries';

interface Props {
  params: Promise<{ zoneId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ zoneId }, taxonomy, locale] = await Promise.all([params, getTaxonomy(), getLocale()]);
  const zone = taxonomy.zones.find((z) => z.id === zoneId);
  return { title: zone ? (locale === 'fr' ? zone.name_fr : zone.name_en) : undefined };
}

export default async function ZonePage({ params, searchParams }: Props) {
  const [{ zoneId }, query, taxonomy, locale] = await Promise.all([params, searchParams, getTaxonomy(), getLocale()]);
  const zone = taxonomy.zones.find((z) => z.id === zoneId);
  if (!taxonomy.regions) redirect('/');
  if (!zone || zone.id === 'national') notFound();
  const { sort, page, city } = parseFeedParams(query);
  const cities = taxonomy.cities.filter((c) => c.zone_id === zone.id);
  const activeCity = cities.find((c) => c.id === city);

  const cityBar = cities.length ? (
    <nav className="row wrap mb16" aria-label="City">
      <Link className={`chip sm ${activeCity ? '' : 'active'}`} href={`/zone/${zone.id}`}>{locale === 'fr' ? zone.name_fr : zone.name_en}</Link>
      {cities.map((c) => (
        <Link key={c.id} className={`chip sm ${activeCity?.id === c.id ? 'active' : ''}`} href={`/zone/${zone.id}?city=${c.id}`}>{c.name}</Link>
      ))}
    </nav>
  ) : undefined;

  return (
    <FeedPage
      title={`${locale === 'fr' ? zone.name_fr : zone.name_en}${activeCity ? ` · ${activeCity.name}` : ''}`}
      subtitle={locale === 'fr' ? zone.description_fr : zone.description_en}
      basePath={`/zone/${zone.id}`}
      query={{ zone: zone.id, city: activeCity?.id, sort, page }}
      hero={cityBar}
    />
  );
}
