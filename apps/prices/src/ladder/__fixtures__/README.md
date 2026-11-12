# price-v2 recorded fixtures

Real vendor responses recorded 2026-09-26 (UTC ~22:05) with the pipeline's own UA, trimmed
of description/image/link fields only — every field the parsers read is verbatim. Tests run
against these files, never against live vendors (brief §4L; CI must not depend on a vendor
being up).

| file | source | what it shows |
|---|---|---|
| `woo-store-products-variable.json` | `GET blankpeptides.com/wp-json/wc/store/v1/products?per_page=3&type=variable` (first 2) | `type:"variable"`, `prices.price_range` (min/max) on one, `null` range on a single-variation product, `variations[]` = `{id, attributes:[{name,value}]}`, `is_in_stock`, `is_on_backorder` |
| `woo-store-variations-parent-181.json` | `GET …/products?type=variation&parent=181&per_page=100` | **path A works**: variation objects with `parent`, `type:"variation"`, `variation:"Size: 15mg"`, `sku`, `permalink` carrying `?attribute_size=`, `is_in_stock` (one is `false`), `prices.{price,regular_price,sale_price,currency_code,currency_minor_unit}`, `on_sale`, `stock_availability`; `attributes` is `[]` on this store |
| `woo-store-variation-182.json` | `GET …/products/182` | the per-id fallback returns the same shape |
| `woo-store-products-simple.json` | `GET …/products?per_page=3&type=simple` | simple products with `price:"0"` and `is_in_stock:false` — a "no price" negative |
| `shopify-products.json` | `GET orosresearch.com/products.json?limit=2` | `variants[]` with `available:false`, `compare_at_price:null`, `option1:"Default Title"`, `grams` |
| `shopify-product.js.json` | `GET orosresearch.com/products/elora-5mg.js` | the closed-feed per-handle shape: `price` in MINOR units (5999), `price_min/max`, `compare_at_price*`, `available`, `variants[]` |
| `shopify-meta.json` | `GET orosresearch.com/meta.json` | `currency:"USD"` — the §4C currency source #1 |

Not yet recorded: a Woo product page carrying `form.variations_form[data-product_variations]`
(blankpeptides' blocks theme does not embed it — the page has 0 occurrences), and a Shopify
catalogue with multi-variant products (the two Shopify vendors in the DB with the most rows
returned only `Default Title` variants or have left Shopify). Add them when found; until then
the embedded-variations parser is tested on a hand-built page that mirrors WooCommerce's
`variations_form` markup and is marked as such in the test.
