// Is an evidence quote still on its page? (spec 2026-10-08, part 1). Pure: quote-check-cli.ts fetches.
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: "-", mdash: "-", hellip: "..." };

/** Lower case, curly quotes straightened, dashes unified, whitespace collapsed. */
export function normalise(text: string): string {
  return text
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The visible text of an HTML page: scripts, styles, comments and tags removed, entities decoded. */
export function pageText(html: string): string {
  const stripped = html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  const decoded = stripped.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e.startsWith("#")) {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
  return normalise(decoded);
}

/** A quote's fragments: the parts between "…" or "...", normalised; empty ones dropped. */
export function quoteFragments(quote: string): string[] {
  return quote.split(/…|\.\.\./).map(normalise).filter((f) => f !== "");
}

/**
 * The words of a normalised text: letters, digits, "$", "%" and a decimal point between digits, in
 * order. The punctuation a reader puts between a heading and its paragraph is not the vendor's words.
 */
// NUL stands in for a decimal point while everything else that is not a word character is dropped.
// eslint-disable-next-line no-control-regex
const words = (text: string) => ` ${text.replace(/(\d)\.(?=\d)/g, "$1\u0000").replace(/[^a-z0-9$%\u0000]+/g, " ").replace(/\u0000/g, ".").trim()} `;

/** The fragments of `quote` whose words are not on `page` (a pageText result); empty when all are there. */
export function missingFragments(page: string, quote: string): string[] {
  const onPage = words(page);
  return quoteFragments(quote).filter((f) => !onPage.includes(words(f)));
}
