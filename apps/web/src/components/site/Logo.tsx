import Image from 'next/image';
import Link from 'next/link';

import logoMark from '@/assets/logo-mark.png';

/** The prototype's brand lockup: peptide-chain mark, PEP/FORUM wordmark and tagline. */
export function Logo({ tag, preload = false }: { tag: string; preload?: boolean }) {
  return (
    <Link className="logo" href="/" aria-label="Pepforums">
      <Image className="mark" src={logoMark} alt="" width={30} height={32} preload={preload} />
      <span className="wordmark">
        <span className="p">PEP</span><span className="lt">FORUMS</span>
        <span className="tag">{tag}</span>
      </span>
    </Link>
  );
}
