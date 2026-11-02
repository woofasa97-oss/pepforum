import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getLocale } from '@/server/context';

import { LEGAL_DOCS } from './content';

interface Props {
  params: Promise<{ doc: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ doc }, locale] = await Promise.all([params, getLocale()]);
  const content = LEGAL_DOCS[doc]?.[locale];
  return content ? { title: content.title, description: content.lead } : {};
}

export default async function LegalPage({ params }: Props) {
  const [{ doc }, locale] = await Promise.all([params, getLocale()]);
  const content = LEGAL_DOCS[doc]?.[locale];
  if (!content) notFound();
  return (
    <div className="page">
      <main id="main" className="prose narrow">
        <h1 tabIndex={-1}>{content.title}</h1>
        <p className="muted" style={{ fontSize: 17 }}>{content.lead}</p>
        {content.sections.map((section) => (
          <section key={section.h}>
            <h2>{section.h}</h2>
            {section.p.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </section>
        ))}
      </main>
    </div>
  );
}
