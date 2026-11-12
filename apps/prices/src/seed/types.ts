export interface CompoundSeed {
  slug: string;
  name: string;
  type: "Single compound" | "Copper complex" | "Blend";
  aliases: string[];
  known_sizes_mg: number[];
  /** A blend's ingredients (single-compound slugs), in the order the name lists them. A blend's identity is its ingredients, never one mix. */
  blend_components?: { slug: string }[];
}

export interface VendorSeed {
  slug: string;
  name: string;
  website_url: string;
  canonical_domain: string;
  origin_country: "US" | "CA" | "GB" | "AU";
  detected_platform: string | null;
  status: "pending";
}
