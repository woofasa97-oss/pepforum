// Where a store's logo is, from its home page's HTML (brand-cli.ts fetches and converts it). Pure.
// Only the store's own logo or icon: never a social banner (og:image), which can carry marketing claims.

export interface BrandCandidate {
  url: string;
  kind: "logo" | "icon";
  /** Higher is better. */
  score: number;
}

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
};

/** The largest image in a srcset ("a.png 1x, b.png 2x" or "a.png 200w, b.png 400w"). */
export function largestFromSrcset(srcset: string): string | null {
  let best: { url: string; size: number } | null = null;
  for (const part of srcset.split(",")) {
    const [url, size = "1x"] = part.trim().split(/\s+/);
    if (!url) continue;
    const n = Number.parseFloat(size) * (size.endsWith("x") ? 1000 : 1);
    if (!best || n > best.size) best = { url, size: Number.isFinite(n) ? n : 0 };
  }
  return best?.url ?? null;
}

/** Ask a Shopify CDN for a larger rendition than the theme's thumbnail. */
function enlarge(url: string): string {
  try {
    const u = new URL(url);
    if (/cdn\.shopify\.com$|\/cdn\/shop\//.test(u.hostname + u.pathname) && u.searchParams.has("width")) {
      u.searchParams.set("width", "600");
      u.searchParams.delete("height");
      u.searchParams.delete("crop");
    }
    return u.href;
  } catch {
    return url;
  }
}

function resolve(raw: string | null, base: string): string | null {
  if (!raw || raw.startsWith("data:")) return null;
  try {
    const u = new URL(raw.replace(/&amp;/g, "&"), base);
    if (u.protocol === "http:") u.protocol = "https:";
    return u.protocol === "https:" ? enlarge(u.href) : null;
  } catch {
    return null;
  }
}

/** Logo candidates, best first: a header logo image, then touch and site icons of 120px or more. */
export function brandCandidates(html: string, base: string): BrandCandidate[] {
  const out: BrandCandidate[] = [];
  const add = (url: string | null, kind: BrandCandidate["kind"], score: number) => {
    if (url && !out.some((c) => c.url === url) && !/\.ico(?:\?|$)/i.test(url) && !/placeholder|woocommerce-placeholder|spinner|loading/i.test(url)) out.push({ url, kind, score });
  };
  const headerEnd = (() => {
    const i = html.search(/<\/header>/i);
    return i === -1 ? Math.min(html.length, 60_000) : i;
  })();
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const hint = `${attr(tag, "class") ?? ""} ${attr(tag, "id") ?? ""} ${attr(tag, "alt") ?? ""} ${attr(tag, "src") ?? ""}`;
    if (!/logo/i.test(hint) || /footer|payment|visa|mastercard|trust|badge|partner|lab-logo|janoshik/i.test(hint)) continue;
    const src = attr(tag, "srcset") ? largestFromSrcset(attr(tag, "srcset") as string) : null;
    const url = resolve(src ?? attr(tag, "data-src") ?? attr(tag, "src"), base);
    const inHeader = (m.index ?? 0) < headerEnd;
    add(url, "logo", (inHeader ? 100 : 60) + (/custom-logo|header__heading-logo|site-logo/i.test(hint) ? 20 : 0));
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    if (!/icon/.test(rel)) continue;
    const size = Number.parseInt((attr(tag, "sizes") ?? "").split("x")[0] ?? "", 10);
    const touch = /apple-touch-icon/.test(rel);
    const href = attr(tag, "href");
    const svg = /\.svg(?:\?|$)/i.test(href ?? "");
    if (!touch && !svg && !(size >= 120)) continue;
    add(resolve(href, base), "icon", 40 + (touch ? 10 : 0) + (svg ? 15 : 0) + Math.min(size || 0, 512) / 100);
  }
  const tile = html.match(/<meta\b[^>]*name\s*=\s*["']msapplication-TileImage["'][^>]*>/i);
  if (tile) add(resolve(attr(tile[0], "content"), base), "icon", 35);
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}
