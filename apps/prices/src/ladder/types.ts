/**
 * THE PRODUCT CONTRACT every rung emits. Declared once, here, because it is what the ingest
 * driver reads. Quantity is deliberately optional and set only by `withCanonicalQuantity` —
 * a second derivation of mg is the defect PeptideBase found five times over.
 */
import type { FetchState } from "../fetch/types.ts";
import type { CanonicalVial } from "../units/canonical-unit.ts";

export type { FetchState };

export const HIT = "hit" as const;
export const MISS = "miss" as const;
export const UNKNOWN = "unknown" as const;

/** `offers.source_system` */
export type SourceSystem = "woocommerce" | "shopify" | "jsonld";
/** `offers.price_source` */
export type PriceSource = "woo_store_api" | "woo_embedded_variations" | "shopify_products_json" | "shopify_product_js" | "jsonld";
/** `offers.availability` — `unknown` stays unknown; it is never read as out of stock. */
export type Availability = "in_stock" | "out_of_stock" | "backorder" | "preorder" | "discontinued" | "unknown";
/** `vendors.detected_platform` */
export type Platform =
  | "woocommerce"
  | "shopify"
  | "jsonld"
  | "custom"
  | "woocommerce_closed_api"
  | "shopify_closed_api"
  | "bigcommerce"
  | "squarespace"
  | "wix"
  | "blocked"
  | "unreachable";

export type CurrencyEvidence = "og_currency" | "jsonld_currency" | "og_and_jsonld" | "meta_json" | "og_pair" | "jsonld_pair" | "store_api";

export type QuantityResolution = CanonicalVial;

export interface Product {
  /** The PARENT product's name; a variation row carries the parent's name and its own label. */
  name: string;
  variantLabel: string | null;
  /** The parent product page, never a variant query string. */
  productUrl: string | null;
  /** The endpoint or page this row's data came from. */
  fetchUrl: string | null;
  sourceSystem: SourceSystem;
  priceSource: PriceSource;
  sourceProductId: string | null;
  sourceVariantId: string | null;
  /** Platform variation id, or a label slug, or '' for a simple product. */
  variantKey: string;
  options: unknown | null;
  /** ISO 4217, or null when the source states none — never a guess. */
  currency: string | null;
  currencyEvidence: CurrencyEvidence | null;
  /** Integer minor units of `currency`. null ONLY on a fallback range row — a range is not a price. */
  priceMinor: number | null;
  /** Only when strictly above `priceMinor`. */
  listPriceMinor: number | null;
  onSale: boolean;
  availability: Availability;
  /** The validation anchor: the vendor's own figure, with its scale when it declares one. */
  rawPriceText: string;
  /** Set ONLY on a variable-parent / AggregateOffer fallback row. */
  fallbackRange: { minMinor: number; maxMinor: number | null } | null;
  quantity?: QuantityResolution;
}

export interface RungResult {
  state: FetchState;
  products: Product[];
  reason: string | null;
  /** The UNFILTERED response length — the pagination continue-signal. */
  rawCount?: number;
  /** Shopify's since_id cursor: the last product id on the page. */
  lastId?: number | string | null;
}

export interface PageFetchResult extends RungResult {
  status: number | null;
  /** 404/410: the URL is gone and the caller may retire it. Never set on a block. */
  dead?: boolean;
}

export interface Attempt {
  rung: string;
  kind?: string;
  url: string;
  state: FetchState;
  status: number | null;
  reason: string | null;
  dead?: boolean;
  page?: number;
  parentId?: string | null;
}

export interface LadderResult {
  state: FetchState;
  rung: PriceSource | null;
  products: Product[];
  /** MEASURED: every request this call made. */
  fetches: number;
  variationFetches?: number;
  attempts: Attempt[];
  reason: string | null;
  /**
   * A FEED read that reached the end of the catalogue: every page and every variation list was
   * answered. False when a later page failed, a page was not the feed, a variation list was cut
   * short, or the page ceiling was hit — the vendor still HIT, but what the read did NOT return
   * says nothing about what the vendor no longer sells.
   */
  complete: boolean;
  /** Variable parents whose variation list was cut short: their unseen variants are unknown, not gone. */
  truncatedParentIds: string[];
  /**
   * Every variable parent the feed LISTED whose variants this read did not fully enumerate — the
   * list was cut short, answered "no", failed, or was never asked for. Stored rows of these
   * parents are kept whatever compound they are filed under: seen is not absent.
   */
  unenumeratedParentIds: string[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(body: unknown): unknown | undefined {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
