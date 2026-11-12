/**
 * One ladder product → one `offers` row, or a typed refusal. PURE. Every refusal is unit-tested;
 * the row is the schema's shape field for field. No FX here: the row stores the vendor's native
 * currency and minor units, and the site converts at read time with a dated rate.
 */
import { createHash } from "node:crypto";
import { getDomain } from "tldts";
import { quantityTextFor, statesVialMassInName, validateAgainstRawText } from "../ladder/ladder.ts";
import type { Product } from "../ladder/types.ts";
import { perMgMinorE4 } from "../money.ts";
import type { BlendIndex } from "../units/blend-match.ts";
import { readBlendRecipe } from "../units/blend-recipe.ts";
import { canonicalVialMg, isNonVialForm, packMultiplicity, parseSize, type ParsedSizeForm } from "../units/canonical-unit.ts";
import type { CompoundRow, OfferInsert, OfferRow, VendorRow } from "./repo.ts";

export type BuildRefusal = "missing_price_source" | "raw_text_mismatch" | "currency_unresolved" | "invalid_product_url" | "price_not_positive";

export type BuildResult =
  | { ok: true; row: OfferInsert; changed: boolean; isNew: boolean; urlRejected: "placeholder" | null }
  | { ok: false; reason: BuildRefusal; detail?: string };

// ── product URL hygiene ──────────────────────────────────────────────────────

const PLACEHOLDER_HOSTS = new Set(["example.com", "example.org", "example.net", "localhost"]);
const PLACEHOLDER_HOST_RE = /^(test\.|yourdomain\.)/i;
const TRACKING_PARAMS = new Set(["fbclid", "gclid", "ref"]);
const ASSET_PATH_RE = /\/wp-content\/uploads\/|\/assets\//i;
const ASSET_EXT_RE = /\.(webp|jpe?g|png|svg|gif)(\?|$)/i;

/** The first label of the registrable domain (eTLD+1) through a real Public Suffix List, so
 *  `vendor.co.uk` yields "vendor" and not "co". Null when the host has no registrable domain. */
function brandToken(hostname: string): string | null {
  const registrable = getDomain(String(hostname ?? "").toLowerCase().replace(/^www\./, ""));
  return registrable ? registrable.split(".")[0] : null;
}

/**
 * A product URL must be a real page on the vendor's own brand. The brand token, not the host:
 * legitimate vendors use alternate TLDs for the same brand (peptidetech.co / peptidetech.is).
 * A placeholder host (example.com, localhost) degrades to null — the row keys on name + fetch
 * URL instead; a foreign brand is a refusal.
 */
export function sanitizeProductUrl(url: string | null | undefined, vendorWebsiteUrl: string): { url: string | null; rejectedReason: "placeholder" | "foreign_brand" | null } {
  if (typeof url !== "string" || !url.trim() || !/^https?:\/\//i.test(url.trim())) return { url: null, rejectedReason: null };
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { url: null, rejectedReason: null };
  }
  const host = parsed.hostname.toLowerCase();
  const productBrand = brandToken(host);
  if (PLACEHOLDER_HOSTS.has(host) || PLACEHOLDER_HOST_RE.test(host) || productBrand === null) return { url: null, rejectedReason: "placeholder" };
  let vendorBrand: string | null = null;
  try {
    vendorBrand = brandToken(new URL(vendorWebsiteUrl).hostname);
  } catch {
    vendorBrand = null;
  }
  if (!vendorBrand || productBrand !== vendorBrand) return { url: null, rejectedReason: "foreign_brand" };
  return { url: url.trim().slice(0, 2000), rejectedReason: null };
}

/** Strip the fragment and tracking params. A variant selector is identity and stays. */
export function stripTrackingParams(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (k.startsWith("utm_") || TRACKING_PARAMS.has(k)) parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

/** Strip query/fragment and a trailing slash, lowercase: URL variants of one page collapse. */
function normalizeUrlPath(url: string): string | null {
  try {
    const u = new URL(url);
    let path = u.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `${u.hostname.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** `vendor:compound:<host/path>`, or a hashed fallback on the fetch URL + name when there is no product page. */
export function computeProductKey(args: { vendorId: string; compoundId: string; productUrl: string | null; fetchUrl: string | null; name: string }): string {
  if (args.productUrl) return `${args.vendorId}:${args.compoundId}:${normalizeUrlPath(args.productUrl) ?? args.productUrl.toLowerCase()}`;
  const source = args.fetchUrl ? (normalizeUrlPath(args.fetchUrl) ?? args.fetchUrl.toLowerCase()) : "";
  const nameKey = String(args.name ?? "").toLowerCase().trim().replace(/\s+/g, " ");
  const hash = createHash("sha256").update(`${source}|${nameKey}`).digest("hex").slice(0, 16);
  return `${args.vendorId}:${args.compoundId}:fallback:${hash}`;
}

/**
 * The product page and key the builder gives a product. Shared with the driver, which needs the
 * key of a product it saw but could not price (a range fallback) to keep its stored rows.
 */
export function resolveProductIdentity(
  product: Product,
  ctx: { vendor: VendorRow; compound: CompoundRow },
): { ok: true; productUrl: string | null; productKey: string; urlRejected: "placeholder" | null } | { ok: false; detail: string } {
  const sanitized = sanitizeProductUrl(product.productUrl, ctx.vendor.website_url);
  if (sanitized.rejectedReason === "foreign_brand") return { ok: false, detail: `off_domain: ${product.productUrl}` };
  if (sanitized.url && (ASSET_PATH_RE.test(sanitized.url) || ASSET_EXT_RE.test(sanitized.url))) return { ok: false, detail: "asset_url" };
  const productUrl = sanitized.url ? stripTrackingParams(sanitized.url) : null;
  const name = product.name || product.variantLabel || "(unnamed)";
  return {
    ok: true,
    productUrl,
    productKey: computeProductKey({ vendorId: ctx.vendor.id, compoundId: ctx.compound.id, productUrl, fetchUrl: product.fetchUrl, name }),
    urlRejected: sanitized.rejectedReason === "placeholder" ? "placeholder" : null,
  };
}

// ── the row ──────────────────────────────────────────────────────────────────

type OfferForm = OfferRow["form"];
const LABEL_FORM_TO_OFFER: Record<ParsedSizeForm, OfferForm> = { vial_lyophilized: "vial", pen: "pen", nasal: "nasal", capsule: "capsule", tablet: "tablet", topical: "topical" };

export function buildOfferRow(
  product: Product,
  ctx: { vendor: VendorRow; compound: CompoundRow; runId: string | null; now: Date; previous: OfferRow | null; blends?: BlendIndex },
): BuildResult {
  if (!product.priceSource || !product.sourceSystem) return { ok: false, reason: "missing_price_source" };
  // A range is not a price. The fallback row exists so the product is not lost; it is never written as an offer.
  if (product.priceMinor === null || !(product.priceMinor > 0)) return { ok: false, reason: "price_not_positive" };
  const validation = validateAgainstRawText(product);
  if (!validation.ok) return { ok: false, reason: "raw_text_mismatch", detail: validation.reason };
  if (!product.currency) return { ok: false, reason: "currency_unresolved" };

  const identity = resolveProductIdentity(product, ctx);
  if (!identity.ok) return { ok: false, reason: "invalid_product_url", detail: identity.detail };
  const { productUrl } = identity;

  const iso = ctx.now.toISOString();
  const text = quantityTextFor(product);
  // THE COMPARABLE GATE and THE LABEL READ, kept separate on purpose: the gate refuses, the label describes.
  const quantity = product.quantity ?? canonicalVialMg(text);
  const parsed = parseSize(text);

  let form: OfferForm = parsed.form ? LABEL_FORM_TO_OFFER[parsed.form] : quantity.reason === null ? "vial" : "unknown";
  if (quantity.reason === "bulk_over_max") form = "bulk";
  let quantityReason: string | null = quantity.reason;
  if (quantityReason === null && parsed.multi_size) quantityReason = "multi_size";
  // A row filed under a BLEND compound is a blend whatever its name looks like.
  const isBlend = parsed.is_blend || ctx.compound.type === "Blend";
  if (quantityReason === null && isBlend) quantityReason = "blend";
  if (quantityReason === null && form !== "vial") quantityReason = "non_vial_form";
  const comparable = quantityReason === null && quantity.reason === null;

  // A row filed under a BLEND compound: its mix, its vial's total and its pack are read by the
  // blend reader. It is never comparable per mg; whether it is LISTED is the publish rule's call
  // (a vial, with a known pack count).
  const blendParts = ctx.compound.type === "Blend" ? ctx.blends?.ingredients.get(ctx.compound.id) : undefined;
  let blendRow: { mg: number | null; pack: number | null; recipeKey: string | null } | null = null;
  if (blendParts) {
    const pack = packMultiplicity(text);
    const packCount = pack.ambiguous || pack.count === null ? null : pack.count;
    // "Combo Vial: BPC-157/TB-500 (20mg vials)" / "QUANTITY (MG): 100 mg": the rewritten text states the vial.
    const rewritten = product.variantLabel !== null && statesVialMassInName(product.name);
    const recipe = readBlendRecipe(rewritten ? text : product.name, rewritten ? null : product.variantLabel, blendParts, ctx.blends as BlendIndex, packCount ?? 1);
    blendRow = { mg: recipe.totalMg, pack: packCount, recipeKey: recipe.kind === "exact" ? recipe.key : null };
    if (isNonVialForm(text)) {
      // A cream, spray or capsule blend is stored as what it is, and is never listed as a vial.
      if (form === "vial") form = parsed.form && parsed.form !== "vial_lyophilized" ? LABEL_FORM_TO_OFFER[parsed.form] : /\btopical\b/i.test(text) ? "topical" : "unknown";
    } else if (parsed.form === null || parsed.form === "vial_lyophilized") form = "vial";
  }

  const name = product.name || product.variantLabel || "(unnamed)";
  const row: OfferInsert = {
    vendor_id: ctx.vendor.id,
    compound_id: ctx.compound.id,
    product_key: identity.productKey,
    variant_key: product.variantKey ?? "",
    product_url: productUrl,
    product_name: name,
    variant_label: product.variantLabel,
    source_system: product.sourceSystem,
    source_product_id: product.sourceProductId,
    source_variant_id: product.sourceVariantId,
    price_source: product.priceSource,
    native_currency: product.currency,
    price_minor: product.priceMinor,
    list_price_minor: product.listPriceMinor !== null && product.listPriceMinor > product.priceMinor ? product.listPriceMinor : null,
    on_sale: product.onSale && product.listPriceMinor !== null && product.listPriceMinor > product.priceMinor,
    price_kind: blendRow ? ((blendRow.pack ?? 1) > 1 ? "fixed_kit" : "per_pack") : comparable && quantity.reason === null && quantity.packCount > 1 ? "fixed_kit" : "per_pack",
    mg_per_vial: blendRow ? blendRow.mg : comparable && quantity.reason === null ? quantity.mg : parsed.mg_per_vial,
    vials_per_pack: blendRow ? blendRow.pack : comparable && quantity.reason === null ? quantity.packCount : parsed.vials_per_kit !== null && parsed.vials_per_kit > 1 ? parsed.vials_per_kit : null,
    total_mg: comparable && quantity.reason === null ? quantity.totalMg : null,
    form,
    is_blend: isBlend,
    comparable,
    quantity_reason: quantityReason,
    per_mg_minor_e4: comparable && quantity.reason === null ? perMgMinorE4(product.priceMinor, quantity.totalMg) : null,
    availability: product.availability,
    availability_checked_at: product.availability !== "unknown" ? iso : null,
    raw_price_text: product.rawPriceText,
    extraction_confidence: parsed.confidence === "low" && !comparable ? "low" : "high",
    observed_at: iso,
    price_changed_at: iso,
    run_id: ctx.runId,
    recipe_key: blendRow?.recipeKey ?? null,
  };

  // A re-read that finds the same price must NOT reset price_changed_at: the column is how
  // "verified again, unchanged" is told apart from "changed". FX is irrelevant to it.
  const prev = ctx.previous;
  const isNew = prev === null;
  const changed = isNew || prev.price_minor !== row.price_minor || (prev.list_price_minor ?? null) !== (row.list_price_minor ?? null) || prev.availability !== row.availability;
  if (!changed && prev) row.price_changed_at = prev.price_changed_at;

  return { ok: true, row, changed, isNew, urlRejected: identity.urlRejected };
}
