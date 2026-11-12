// pnpm --filter @pepforum/prices stores:brand --cache <dir> [--stores a,b] [--refresh]
//
// Each store's logo, for the directory's cards: read from its home page (PepforumsBot, robots.txt
// honoured), decoded and re-encoded as WebP by sharp (so no store file is ever served as-is, and an SVG
// becomes pixels), trimmed and sized, and written to apps/web/public/brands/<slug>.webp, served from our
// own origin (img-src 'self'). apps/web/src/lib/stores/brands.json records each logo's size and whether it
// needs a light or a dark tile.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createFetcher } from "../fetch/http.ts";
import { realSleep } from "../fetch/pacing.ts";
import { brandCandidates } from "./brand.ts";
import { validateStores } from "./directory.ts";

const say = (line: string) => process.stdout.write(`${line}\n`);
const OUT_DIR = "../web/public/brands";
const MANIFEST = "../web/src/lib/stores/brands.json";
const MAX_BYTES = 3_000_000;

type Brand = { w: number; h: number; kind: "logo" | "icon"; bg: "light" | "dark" | "image" };

/** A decoded, trimmed, sized WebP and the tile it needs; null when the image is unusable. */
async function convert(bytes: Uint8Array, kind: Brand["kind"], svg: boolean): Promise<{ webp: Buffer; brand: Brand } | null> {
  const input = sharp(Buffer.from(bytes), { density: svg ? 300 : 72, limitInputPixels: 40_000_000, animated: false, failOn: "error" });
  const meta = await input.metadata();
  if (!meta.width || !meta.height || meta.width < 24 || meta.height < 24) return null;
  const trimmed = await sharp(await input.png().toBuffer()).trim({ threshold: 12 }).toBuffer().catch(() => null);
  if (!trimmed) return null;
  const box = kind === "logo" ? { width: 360, height: 120 } : { width: 160, height: 160 };
  const resized = sharp(trimmed).resize({ ...box, fit: "inside", withoutEnlargement: true }).ensureAlpha();
  const { data, info } = await resized.clone().raw().toBuffer({ resolveWithObject: true });
  if (info.width < 16 || info.height < 16) return null;
  // Light marks on a transparent ground need a dark tile; an opaque image is shown as it is.
  let opaque = 0;
  let lum = 0;
  let transparent = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (a < 0.1) {
      transparent++;
      continue;
    }
    opaque++;
    lum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  }
  if (opaque === 0) return null;
  const share = transparent / (transparent + opaque);
  const bg: Brand["bg"] = share < 0.05 ? "image" : lum / opaque > 0.72 ? "dark" : "light";
  const webp = await resized.webp({ quality: 86, alphaQuality: 90 }).toBuffer();
  return { webp, brand: { w: info.width, h: info.height, kind, bg } };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const cacheDir = opt("cache");
  if (!cacheDir) throw new Error("usage: stores:brand --cache <dir> [--stores a,b] [--refresh]");
  const htmlDir = path.join(cacheDir, "home-html");
  mkdirSync(htmlDir, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const only = opt("stores")?.split(",");
  const refresh = args.includes("--refresh");

  const stores = validateStores(JSON.parse(readFileSync("seed/stores.json", "utf8")));
  const manifest: Record<string, Brand> = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};
  const fetchText = createFetcher();
  const queue = stores.filter((s) => (!only || only.includes(s.slug)) && (refresh || !manifest[s.slug]));
  let found = 0;
  let done = 0;
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const file = path.join(htmlDir, `${s.slug}.html`);
      let html: string | null = null;
      if (!refresh && existsSync(file)) html = readFileSync(file, "utf8");
      else {
        const r = await fetchText(s.website_url, { accept: "text/html, application/xhtml+xml;q=0.9, */*;q=0.5" });
        await realSleep(1000);
        if (r.state === "hit" && r.body) {
          html = r.body;
          writeFileSync(file, html);
        }
      }
      if (html) {
        for (const c of brandCandidates(html, s.website_url)) {
          const img = await fetchText(c.url, { binary: true, accept: "image/avif, image/webp, image/png, image/svg+xml, image/*;q=0.8" });
          await realSleep(1000);
          const bytes = img.bytes ?? (img.body ? new TextEncoder().encode(img.body) : null);
          if (img.state !== "hit" || !bytes || bytes.length > MAX_BYTES) continue;
          const out = await convert(bytes, c.kind, /\.svg(?:\?|$)/i.test(c.url) || /^\s*<(?:\?xml|svg)/.test(new TextDecoder().decode(bytes.slice(0, 200)))).catch(() => null);
          if (!out) continue;
          writeFileSync(path.join(OUT_DIR, `${s.slug}.webp`), out.webp);
          manifest[s.slug] = out.brand;
          found++;
          break;
        }
      }
      done++;
      if (done % 25 === 0) say(`${done}/${queue.length + done} stores`);
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(MANIFEST, `${JSON.stringify(sorted, null, 1)}\n`);
  say(`${found} logos written; ${Object.keys(sorted).length} stores have one`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exitCode = 1;
});
