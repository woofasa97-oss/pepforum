import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { FeedPage } from '@/components/feed/FeedPage';
import { parseFeedParams } from '@/lib/params';
import { getLocale } from '@/server/context';
import { getTaxonomy } from '@/server/queries';

interface Props {
  params: Promise<{ categoryId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ categoryId }, taxonomy, locale] = await Promise.all([params, getTaxonomy(), getLocale()]);
  const category = taxonomy.categories.find((c) => c.id === categoryId);
  return { title: category ? (locale === 'fr' ? category.name_fr : category.name_en) : undefined };
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const [{ categoryId }, query, taxonomy, locale] = await Promise.all([params, searchParams, getTaxonomy(), getLocale()]);
  const category = taxonomy.categories.find((c) => c.id === categoryId);
  if (!category) notFound();
  const { sort, page } = parseFeedParams(query);
  const rules = locale === 'fr' ? category.rules_fr : category.rules_en;

  const rulesBox = (
    <div className="banner info mb16">
      <div>
        <b>{locale === 'fr' ? category.name_fr : category.name_en}</b>
        <ul style={{ listStyle: 'disc', paddingLeft: 18, marginTop: 4 }}>
          {rules.map((rule) => <li key={rule}>{rule}</li>)}
        </ul>
      </div>
    </div>
  );

  return (
    <FeedPage
      title={locale === 'fr' ? category.name_fr : category.name_en}
      subtitle={locale === 'fr' ? category.description_fr : category.description_en}
      basePath={`/category/${category.id}`}
      query={{ category: category.id, sort, page }}
      hero={rulesBox}
    />
  );
}
