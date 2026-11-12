import Link from 'next/link';

/**
 * The brand mark: a peptide chain on the navy tile, its last residue in red. Inline, so it is
 * crisp at any size and costs no request. apps/web/src/assets/logo-mark.svg is the same drawing
 * (it renders app/icon.png); change both together.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 104" width={30} height={32} aria-hidden="true" focusable="false">
      <rect width="100" height="104" rx="21" fill="#0b1f3b" />
      <g stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeOpacity=".92">
        <line x1="20" y1="55" x2="39.8" y2="45" />
        <line x1="39.8" y1="45" x2="63" y2="27" />
        <line x1="63" y1="27" x2="68" y2="61" />
        <line x1="20" y1="55" x2="39.8" y2="78.5" />
      </g>
      <g fill="#fff">
        <circle cx="63" cy="27" r="9.4" />
        <circle cx="39.8" cy="45" r="7.2" />
        <circle cx="20" cy="55" r="6.2" />
        <circle cx="39.8" cy="78.5" r="7.2" />
      </g>
      <circle cx="68" cy="61" r="15.6" fill="#e31e24" />
      <circle cx="68" cy="61" r="15.6" fill="none" stroke="#fff" strokeOpacity=".22" strokeWidth="1.6" />
      <circle cx="68" cy="61" r="5.6" fill="none" stroke="#fff" strokeWidth="2.8" />
    </svg>
  );
}

/** The brand lockup: the mark, the PEP/FORUMS wordmark and the tagline. */
export function Logo({ tag }: { tag: string }) {
  return (
    <Link className="logo" href="/" aria-label="Pepforums">
      <LogoMark className="mark" />
      <span className="wordmark">
        <span className="p">PEP</span><span className="lt">FORUMS</span>
        <span className="tag">{tag}</span>
      </span>
    </Link>
  );
}
