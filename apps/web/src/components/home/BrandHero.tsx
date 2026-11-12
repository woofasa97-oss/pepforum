import Link from 'next/link';

import { Icon, Leaf } from '@/components/ui/Icon';
import type { Translate } from '@/lib/i18n';

import { Leaf3D } from './Leaf3D';

// Pine silhouettes along the near ridge (deterministic, as in the prototype).
const TREES = Array.from({ length: 60 }, (_, i) => {
  const x = 300 + i * 19.2;
  const h = 14 + ((i * 37) % 11);
  const y = 392 - ((i * 53) % 14);
  return <path key={i} d={`M${x} ${y}l${h / 2.6} -${h} ${h / 2.6} ${h}z`} />;
});

/** Mountains, lake and forest at dusk: the prototype's hero backdrop. */
function Scene() {
  return (
    <svg className="scene" viewBox="0 0 1440 560" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="bh-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0b1f3b"/><stop offset=".55" stopColor="#1c3a66"/><stop offset="1" stopColor="#5b82b4"/></linearGradient>
        <linearGradient id="bh-far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#7a9cc8"/><stop offset="1" stopColor="#3f6294"/></linearGradient>
        <linearGradient id="bh-mid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4b6f9f"/><stop offset="1" stopColor="#22406f"/></linearGradient>
        <linearGradient id="bh-near" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#132b50"/><stop offset="1" stopColor="#0b1f3b"/></linearGradient>
        <linearGradient id="bh-snow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f4f7fb"/><stop offset="1" stopColor="#b8c9e0" stopOpacity=".4"/></linearGradient>
        <linearGradient id="bh-lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3b6396"/><stop offset=".5" stopColor="#23416e"/><stop offset="1" stopColor="#0f2443"/></linearGradient>
        <linearGradient id="bh-mist" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#9fb6d6" stopOpacity="0"/><stop offset=".5" stopColor="#9fb6d6" stopOpacity=".22"/><stop offset="1" stopColor="#9fb6d6" stopOpacity="0"/></linearGradient>
        <linearGradient id="bh-fade" x1="0" x2="1"><stop offset="0" stopColor="#0b1f3b" stopOpacity=".92"/><stop offset=".38" stopColor="#0b1f3b" stopOpacity=".45"/><stop offset=".6" stopColor="#0b1f3b" stopOpacity="0"/></linearGradient>
        <linearGradient id="bh-bottom" x1="0" y1="0" x2="0" y2="1"><stop offset=".7" stopColor="#0b1f3b" stopOpacity="0"/><stop offset="1" stopColor="#0b1f3b" stopOpacity=".35"/></linearGradient>
        <clipPath id="bh-lakeclip"><rect x="0" y="392" width="1440" height="168"/></clipPath>
      </defs>
      <rect width="1440" height="560" fill="url(#bh-sky)"/>
      <g fill="#fff" opacity=".45"><circle cx="980" cy="48" r="1.3"/><circle cx="1120" cy="90" r="1"/><circle cx="1240" cy="36" r="1.6"/><circle cx="1330" cy="120" r="1"/><circle cx="1400" cy="70" r="1.2"/><circle cx="860" cy="110" r="1"/><circle cx="1060" cy="140" r=".9"/></g>
      {/* far range */}
      <path d="M520 392 600 300 660 330 740 236 800 280 860 250 930 300 990 220 1050 262 1110 240 1180 300 1240 262 1300 310 1370 270 1440 320V392z" fill="url(#bh-far)" opacity=".85"/>
      <path d="M740 236l14 18 12-6 10 14 14-10 10 8-16 6-18 8-14-4-12 6-12-10zM990 220l12 16 10-2 12 14 12-12 8 10-18 8-16 4-12-2-10 6-10-12zM1370 270l10 12 10-4 8 10-12 6-14 2-10-6z" fill="url(#bh-snow)"/>
      {/* mid range (main peaks) */}
      <path d="M400 392 480 330 540 352 640 260 700 290 760 212 820 268 880 240 960 186 1020 236 1080 214 1150 290 1210 258 1280 318 1340 292 1440 360V392z" fill="url(#bh-mid)"/>
      <path d="M760 212l16 22 12-8 12 18 14-12 14 14-18 10-20 8-12-4-14 10-12-10-10-14zM960 186l18 24 10-6 14 20 14-10 12 16-20 10-18 6-12-6-14 10-12-12-10-16zM640 260l12 16 10-4 10 12 10-8 8 10-14 8-14 2-10-6-8 6-8-10zM1150 290l10 12 8-4 8 10-10 6-12 2-8-6z" fill="url(#bh-snow)"/>
      {/* near ridge, forested */}
      <path d="M300 392 380 352 440 368 520 322 600 348 680 318 760 346 840 326 920 356 1000 330 1080 362 1160 340 1240 372 1320 350 1440 384V392z" fill="url(#bh-near)"/>
      <g fill="#0d2347">{TREES}</g>
      {/* mist band */}
      <rect x="300" y="330" width="1140" height="70" fill="url(#bh-mist)"/>
      {/* lake */}
      <rect x="0" y="392" width="1440" height="168" fill="url(#bh-lake)"/>
      <g clipPath="url(#bh-lakeclip)" opacity=".35" transform="translate(0 784) scale(1 -1)">
        <path d="M400 392 480 330 540 352 640 260 700 290 760 212 820 268 880 240 960 186 1020 236 1080 214 1150 290 1210 258 1280 318 1340 292 1440 360V392z" fill="#5a7fae"/>
        <path d="M760 212l16 22 12-8 12 18 14-12 14 14-18 10-20 8-12-4-14 10-12-10-10-14zM960 186l18 24 10-6 14 20 14-10 12 16-20 10-18 6-12-6-14 10-12-12-10-16z" fill="#dfe8f5"/>
      </g>
      <g stroke="#a9c4ea" strokeOpacity=".28" strokeWidth="1.2"><line x1="560" y1="418" x2="760" y2="418"/><line x1="820" y1="438" x2="1120" y2="438"/><line x1="640" y1="462" x2="900" y2="462"/><line x1="980" y1="484" x2="1360" y2="484"/><line x1="720" y1="510" x2="1000" y2="510"/><line x1="1100" y1="528" x2="1420" y2="528"/></g>
      <rect width="1440" height="560" fill="url(#bh-fade)"/>
      <rect width="1440" height="560" fill="url(#bh-bottom)"/>
      <g fill="none" stroke="#fff" strokeOpacity=".07" strokeWidth="2"><path d="M120 440l40-24 40 24v48l-40 24-40-24z"/><path d="M200 416l40-24 40 24v48l-40 24-40-24z"/><circle cx="160" cy="440" r="4"/><circle cx="240" cy="416" r="4"/><circle cx="200" cy="488" r="4"/></g>
    </svg>
  );
}

/** Home-page brand hero and the four-way shortcut strip under it (from the prototype). */
export function BrandHero({ t, signedIn, regions }: { t: Translate; signedIn: boolean; regions: boolean }) {
  return (
    <>
      <section className="bhero" aria-label={t('home.hero.label')}>
        <Scene />
        <Leaf className="leaf" />
        <div className="in">
          <Leaf3D />
          <h1>{t('home.hero.line1')}<br />{t('home.hero.line2')}<br />{t('home.hero.line3')}</h1>
          <p>{t('home.hero.sub')}</p>
          <div className="cta">
            {signedIn ? (
              <>
                <Link className="btn red" href="/submit">{t('nav.submit')} →</Link>
                {/* The zone bar is hidden while regions are off (…026), so "Explore zones" would go nowhere. */}
                {regions
                  ? <Link className="btn ghost" href="#zones">{t('home.hero.exploreZones')}</Link>
                  : <Link className="btn ghost" href="/legal/community-notes">{t('notes.whatIs')}</Link>}
              </>
            ) : (
              <>
                <Link className="btn red" href="/auth/sign-up">{t('home.hero.join')} →</Link>
                <Link className="btn ghost" href="/legal/community-notes">{t('notes.whatIs')}</Link>
              </>
            )}
          </div>
        </div>
      </section>
      <nav className="bstrip" aria-label={t('home.strip.label')}>
        <Link href="/?sort=new"><Icon name="comment" />{t('home.strip.discuss')}<small>{t('home.strip.discussSub')}</small></Link>
        <Link href="/category/research"><Icon name="flask" />{t('home.strip.research')}<small>{t('home.strip.researchSub')}</small></Link>
        <Link href="/notes"><Icon name="shield" />{t('home.strip.notes')}<small>{t('home.strip.notesSub')}</small></Link>
        <Link href="/transparency"><Icon name="globe" />{t('home.strip.canada')}<small>{t('home.strip.canadaSub')}</small></Link>
      </nav>
    </>
  );
}
