import Link from 'next/link';

import { getT } from '@/server/context';

export default async function NotFound() {
  const t = await getT();
  return (
    <div className="page">
      <main id="main" className="narrow">
        <div className="card empty">
          <b>{t('notFound.title')}</b>
          <p>{t('notFound.body')}</p>
          <Link className="btn dark mt16" href="/">{t('notFound.back')}</Link>
        </div>
      </main>
    </div>
  );
}
