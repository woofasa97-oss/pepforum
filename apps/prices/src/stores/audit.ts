// The public-information audit's rules (docs/QUALITY_ASSURANCE.md §9.1, ADR-0011). Pure: given the text
// of the pages our reader read, decide each check and quote the words it rests on. Every quote is a span of
// a page's visible text, so stores:check finds it again. audit-cli.ts does the reading.
import type { StoreAuditCriterion } from "@pepforum/database";
import { COUNTRIES, STORE_AUDIT_CRITERIA } from "@pepforum/database";
import type { CheckSeed, LabSeed } from "./directory.ts";

export interface Page {
  url: string;
  /** Visible text, case kept (visibleText). */
  text: string;
  /** Same-site links: address and label. */
  links: Array<{ href: string; label: string }>;
}

export interface Findings {
  checks: Record<StoreAuditCriterion, CheckSeed>;
  country: string | null;
  ships_to: string[];
  ships_worldwide: boolean;
  /** Windows that may be human-use claims, for a person to judge (reviewHumanUse). */
  human_use_candidates: Array<{ url: string; quote: string; term: string }>;
}

const QUOTE_MAX = 220;
const none = (): CheckSeed => ({ result: "not_found", value: null, source_url: null, quote: null, quote_verified_on: null });

/** The words around a match, cut at word boundaries, at most QUOTE_MAX characters. */
export function windowAround(text: string, index: number, length: number, before = 90): string {
  let start = Math.max(0, index - before);
  let end = Math.min(text.length, index + length + (QUOTE_MAX - before - length));
  if (start > 0) {
    const space = text.indexOf(" ", start);
    start = space === -1 || space > index ? start : space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    end = space > index + length ? space : end;
  }
  return text.slice(start, end).trim();
}

function firstMatch(pages: Page[], re: RegExp, accept: (m: RegExpExecArray, page: Page) => boolean = () => true): { page: Page; m: RegExpExecArray } | null {
  for (const page of pages) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (let m = g.exec(page.text); m; m = g.exec(page.text)) {
      if (accept(m, page)) return { page, m };
    }
  }
  return null;
}

const found = (hit: { page: Page; m: RegExpExecArray }, result: CheckSeed["result"] = "met", value: string | null = null): CheckSeed => ({
  result, value, source_url: hit.page.url, quote: windowAround(hit.page.text, hit.m.index, hit.m[0].length), quote_verified_on: null,
});

// ── Identity (§9.1) ─────────────────────────────────────────────────────────
const ENTITY = /\b[A-Z0-9][A-Za-z0-9&'’.-]*(?: [A-Z0-9&][A-Za-z0-9&'’.-]*){0,5},? (?:LLC|L\.L\.C\.|Inc\.?|Incorporated|Ltd\.?|Limited|GmbH|UG|s\.r\.o\.|sp\. z o\.o\.|Sp\. z o\.o\.|Pty\.? Ltd\.?|B\.V\.|S\.L\.|S\.L\.U\.|S\.A\.|SAS|SARL|S\.R\.L\.|SRL|AB|Oy|ApS|Corp\.?|Corporation|Co\., Ltd\.?|LLP|PLC|Pte\.? Ltd\.?|Kft\.|d\.o\.o\.|OÜ|Lda\.?)(?![A-Za-z])/;

const STREET = String.raw`\d{1,6}[A-Za-z]?,? [A-Z0-9][\w .'’-]{1,40}? (?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Lane|Ln\.?|Way|Suite|Ste\.?|Parkway|Pkwy\.?|Court|Ct\.?|Place|Pl\.?|Highway|Hwy\.?|Circle|Cir\.?|Square|Terrace|Close|Crescent|Row)\b`;
const ADDRESS = [
  new RegExp(`${STREET}[^.!?]{0,80}?\\b[A-Z]{2},? \\d{5}(?:-\\d{4})?\\b`), // US
  new RegExp(`${STREET}[^.!?]{0,80}?\\b[A-Z]\\d[A-Z] ?\\d[A-Z]\\d\\b`), // Canada
  new RegExp(`${STREET}[^.!?]{0,80}?\\b[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2}\\b`), // UK
  new RegExp(`${STREET}[^.!?]{0,80}?\\b(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT) \\d{4}\\b`), // Australia
  /\b[A-ZÄÖÜ][a-zäöüßéèàç]+(?:stra(?:ß|ss)e|str\.|weg|gasse|platz|allee|ring|laan|straat|gatan|vägen|ulica|ul\.|rue|via|calle|avenida|rua) ?\d{1,4}[a-z]?,? \d{4,5} [A-ZÄÖÜ][a-zäöüß-]+/, // Europe
  /\b(?:rue|avenue|boulevard|via|calle|avenida|rua|ul\.|ulica) [^,]{2,40} ?\d{1,4}[a-z]?,? \d{4,5} [A-ZÄÖÜ][a-zäöüß-]+/i,
];
const PO_BOX = /\b(?:P\.? ?O\.? Box|PO Box|Post Office Box) \d+[^.!?]{0,60}/i;

const BASED = /\b(?:based in|located in|headquartered in|operat(?:e|es|ing) (?:from|out of|in)|registered in|incorporated in|a company registered in|we are an? [A-Za-z -]{0,30}(?:company|business|supplier|store|vendor) (?:based )?in|proudly) (?:the )?([A-Z][A-Za-z .'-]{2,40})/;

/** Country names in English, longest first, with a few common short forms. */
const NAMES: Array<[string, string]> = (() => {
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const out: Array<[string, string]> = COUNTRIES.map((c) => [names.of(c) ?? c, c]);
  out.push(["USA", "US"], ["U.S.A.", "US"], ["U.S.", "US"], ["America", "US"], ["UK", "GB"], ["U.K.", "GB"], ["Britain", "GB"], ["Great Britain", "GB"],
    ["England", "GB"], ["Scotland", "GB"], ["Wales", "GB"], ["Northern Ireland", "GB"], ["Czechia", "CZ"], ["Holland", "NL"], ["Deutschland", "DE"]);
  return out.sort((a, b) => b[0].length - a[0].length);
})();

/** The countries named in a span of text. */
export function countriesIn(text: string): string[] {
  const out = new Set<string>();
  let rest = ` ${text} `;
  for (const [name, code] of NAMES) {
    const re = new RegExp(`(?<![A-Za-z])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "g");
    if (re.test(rest)) {
      out.add(code);
      rest = rest.replace(re, " ");
    }
  }
  return [...out];
}

/** Hosts, processors, platforms and labs whose names and addresses appear on store pages. */
const THIRD_PARTY = /\b(?:h[ée]bergement|h[ée]bergeur|hosted by|hosting|hoster|Hetzner|OVH|Shopify|Stripe|PayPal|Wix|Squarespace|GoDaddy|Amazon Web Services|Amazon\.com|Google|Cloudflare|DigitalOcean|Sendinblue|Brevo|Klaviyo|Mailchimp|Automattic|WooCommerce|Meta Platforms|registered agent|Analytical Services|Laboratories|Laboratory)\b/i;
const LEGAL_CONTEXT = /(?:©|\(c\)|copyright|operated by|owned by|a trading name of|trading as|t\/a|company name|legal name|registered (?:in|office|company)|company (?:no|number|registration)|the company|firma|raison sociale|soci[ée]t[ée]|empresa|razón social|impressum|seller|vendor|we are|is a)\s*[:\-–]?\s*[^.!?]{0,30}$/i;
const GENERIC = new Set(["the", "and", "peptide", "peptides", "labs", "lab", "research", "sciences", "science", "bio", "biotech", "pharma", "health", "llc", "inc", "ltd", "limited", "gmbh", "corp", "company", "group", "supply", "supplies", "store", "shop", "com", "net", "org", "usa", "canada"]);

/** The distinctive words of a store's name and domain. */
function storeWords(store: { name: string; domain: string }): Set<string> {
  const words = `${store.name} ${store.domain.split(".")[0].replace(/-/g, " ")}`.toLowerCase().split(/[^a-z0-9]+/);
  // "maplepeptides" also yields "maple".
  const out = new Set(words.filter((w) => w.length >= 3 && !GENERIC.has(w)));
  for (const w of [...out]) for (const g of GENERIC) if (w.length > g.length + 2 && w.endsWith(g)) out.add(w.slice(0, -g.length));
  return out;
}

// ── Certificates (§3, §4, §5) ───────────────────────────────────────────────
const COA_WORDS = /\b(?:certificates? of analysis|COAs?|CoAs?|lab(?:oratory)? (?:reports?|results?|tests?)|third[- ]party (?:tested|testing|lab|analysis)|test results?|analytical reports?)\b/;
const COA_DOC = /(?:coa|certificate|lab[-_ ]?report|test[-_ ]?result|analysis|janoshik|hplc)/i;
const DOC_EXT = /\.(?:pdf|png|jpe?g|webp)(?:\?|#|$)/i;
const COA_PATH = /\/(?:coa|coas|lab|labs|lab-results|lab-tests?|testing|tests?|certificates?|quality|results|third-party|analysis)(?:[/-]|$)/i;
const PER_LOT = /\b(?:batch|lot|lots|batches)\b/i;
const VERIFY = /\b(?:verification (?:key|code|link|number|id|portal)|verif(?:y|ication) key|unique (?:key|code)|accession (?:number|no\.?|#)|scan the QR|QR code|verify (?:it |each |every |this |the |any |our )?(?:report |COA |certificate |result |test )?(?:yourself )?(?:on|at|via) (?:janoshik|the lab|the laboratory|the lab's|lab's)|check (?:it|them|each report|the report) yourself on [a-z]+\.(?:com|org|net))/i;
const VERIFY_LINK = /janoshik\.com\/(?:tests|verify)|verify\.janoshik|freedomdiagnosticstesting\.com|trustpointe|\/verify/i;
const MASS_SPEC = /\b(?:mass spectrometry|mass spectrometer|mass spec|LC[- ]?MS(?:\/MS)?|HRMS|MALDI(?:-TOF)?|ESI[- ]MS|molecular (?:weight|mass) (?:confirm|verif)\w*|mass (?:confirm|verif)\w*)\b/i;
const ENDOTOXIN = /\b(?:endotoxins?|LAL test|limulus|bacterial endotoxin)\b/i;
const DATE = /\b(?:(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])|(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](20\d{2})|(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.? (?:(?:0?[1-9]|[12]\d|3[01]),? )?(20\d{2}))\b/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function dateOf(m: RegExpExecArray): Date | null {
  if (m[1]) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (m[6]) return new Date(Date.UTC(Number(m[6]), Number(m[5]) - 1, Number(m[4])));
  if (m[7]) return new Date(Date.UTC(Number(m[8]), MONTHS.indexOf(m[7].slice(0, 3).toLowerCase()), 1));
  return null;
}

// ── Conduct (§9.6, §9.7) ────────────────────────────────────────────────────
const HUMAN_USE = /\b(?:dosage|dosing|doses?|dosed|(?:dosing|dosage|injection|peptide|cycle|stack|weight[- ]loss|fat[- ]loss|healing|recovery) protocols?|protocols? (?:for|to) (?:weight|fat|healing|recovery|muscle|injury)|(?:peptide |reconstitution |dosage |dose |dosing |research )?calculators?|subcutaneous(?:ly)?|sub-?q|intramuscular(?:ly)?|inject(?:ion|ions|ing|ed)?|(?:mg|mcg|iu|units?) (?:per|\/|a|each) (?:day|week)|weekly dose|for human (?:use|consumption)|human use|weight[- ]loss|lose weight|fat loss|anti-?aging benefits|muscle (?:growth|gain))\b/gi;
// A denial before the term, in the languages the stores write in.
const NEGATED = /\b(?:not|no|never|n't|nor|without|prohibited|forbidden|strictly|solely|only for (?:research|laboratory)|exclusively|ne|pas|jamais|nicht|kein|keine|niemals|nunca|nie|niet|nooit|inte|ikke|non|mai)\b[^.!?]{0,40}$/i;
const BAC_WATER = /water for injection|sodium chloride injection|pharmaceuticals for human use/i;
const RECALL = /\b(?:(?:product|lot|batch) recalls?|recall (?:policy|procedure|process|notice)s?|recalls? (?:of|affecting) (?:a |the |any )?(?:lot|batch|product)|initiates? a recall|lot (?:notice|notification)s?|batch (?:notice|notification)s?|notify (?:all )?(?:affected )?(?:customers|buyers|purchasers)|pulled from (?:inventory|sale)|withdrawn? from sale|quarantined? (?:the )?(?:lot|batch)|batch is (?:sealed|quarantined|pulled))\b/i;

const SHIPS = /\b(?:we (?:ship|deliver) (?!from)|ship(?:s|ped|ping)? (?:to|within|across|throughout|worldwide|internationally|globally|is available)|deliver(?:y|ies|s|ed)? (?:to|within|across|throughout|worldwide)|(?:international|worldwide|global|domestic) (?:shipping|delivery))/i;
const WORLDWIDE = /\b(?:worldwide|internationally|globally|international shipping|ship(?:ping)? (?:to )?(?:all|most) countries|anywhere in the world)\b/i;

/**
 * Decides the fourteen checks from the pages read. `discoveryCountry` is a country a researcher read on the
 * site, with its words; it counts only when those words are on one of our pages. `labs` gives each named
 * lab's tier; `independent` is a tester's page about this store, when one exists.
 */
export function auditPages(input: {
  /** The store's name and domain, to tell its own legal name from a supplier's. */
  store: { name: string; domain: string };
  pages: Page[];
  labs: LabSeed[];
  labAliases?: Record<string, string[]>;
  discoveryCountry?: { code: string; quote: string } | null;
  independent?: Page | null;
  today: Date;
}): Findings {
  const { pages, labs, today } = input;
  const checks = Object.fromEntries(STORE_AUDIT_CRITERIA.map((c) => [c, none()])) as Record<StoreAuditCriterion, CheckSeed>;
  const text = (p: Page) => p.text;

  // Legal or trading name: a legal-entity form, preferring the footer-style "©" or "operated by" lines.
  const own = storeWords(input.store);
  const entity = firstMatch(pages, ENTITY, (m, p) => {
    if (/^(?:The|A|An|Our|We|All|This|Copyright|Rights)\b/.test(m[0]) || THIRD_PARTY.test(m[0])) return false;
    const words = m[0].toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC.has(w));
    const before = p.text.slice(Math.max(0, m.index - 50), m.index);
    return words.some((w) => own.has(w)) || LEGAL_CONTEXT.test(before);
  });
  if (entity) checks.identity_name = found(entity, "met", entity.m[0].replace(/,$/, ""));

  // Address: a street address with a postcode; a P.O. box alone is partly.
  let address: { page: Page; m: RegExpExecArray } | null = null;
  const notThirdParty = (m: RegExpExecArray, p: Page) => !THIRD_PARTY.test(p.text.slice(Math.max(0, m.index - 120), m.index + m[0].length));
  for (const re of ADDRESS) {
    address = firstMatch(pages, re, notThirdParty);
    if (address) break;
  }
  if (address) checks.identity_address = found(address, "met");
  else {
    const box = firstMatch(pages, PO_BOX, notThirdParty);
    if (box) checks.identity_address = found(box, "partly");
  }

  // Country of operation: a "based in" statement, the researcher's words found again, or the address's country.
  let country: string | null = null;
  const based = firstMatch(pages, BASED, (m) => countriesIn(m[1]).length === 1);
  if (based) {
    country = countriesIn(based.m[1])[0];
    checks.identity_country = found(based, "met", country);
  } else if (input.discoveryCountry) {
    const words = input.discoveryCountry.quote.toLowerCase().replace(/\s+/g, " ").trim();
    for (const page of pages) {
      const i = page.text.toLowerCase().indexOf(words);
      if (words.length >= 6 && i !== -1) {
        country = input.discoveryCountry.code;
        checks.identity_country = { result: "met", value: country, source_url: page.url, quote: windowAround(page.text, i, words.length), quote_verified_on: null };
        break;
      }
    }
  }
  if (!country && address && checks.identity_address.quote) {
    const named = countriesIn(checks.identity_address.quote);
    const fromPostcode = ADDRESS.indexOf(ADDRESS.find((re) => re.test(checks.identity_address.quote ?? "")) as RegExp);
    const implied = named.length === 1 ? named[0] : fromPostcode === 0 ? "US" : fromPostcode === 1 ? "CA" : fromPostcode === 2 ? "GB" : fromPostcode === 3 ? "AU" : null;
    if (implied) {
      country = implied;
      checks.identity_country = { ...checks.identity_address, result: "met", value: implied };
    }
  }

  // Where it ships.
  let ships_to: string[] = [];
  let ships_worldwide = false;
  const ships = firstMatch(pages, SHIPS);
  if (ships) {
    const quote = windowAround(ships.page.text, ships.m.index, ships.m[0].length);
    const negatedWorld = /\b(?:not|no|don't|do not|cannot|can't|only)\b[^.!?]{0,30}\b(?:worldwide|internationally|international)\b/i.test(quote);
    ships_worldwide = WORLDWIDE.test(quote) && !negatedWorld;
    ships_to = countriesIn(quote).filter((c) => c !== country || /\b(?:within|across|to|throughout)\b/i.test(quote));
    checks.ships_to = { ...found(ships, "met"), quote, value: ships_worldwide ? "Worldwide" : ships_to.length ? ships_to.join(", ") : null };
  }

  // Certificates: documents or a certificates page; per lot when lots or batches are named beside them.
  const docs = pages.flatMap((p) => p.links.filter((l) => DOC_EXT.test(l.href) && (COA_DOC.test(l.href) || COA_DOC.test(l.label))).map((l) => ({ page: p, link: l })));
  const coaPage = pages.find((p) => COA_PATH.test(new URL(p.url).pathname) && /\b(?:HPLC|purity|certificate|COA|lab)\b/i.test(p.text));
  const coaWords = firstMatch(coaPage ? [coaPage, ...pages] : pages, COA_WORDS);
  if (docs.length > 0 || coaPage) {
    const perLot = coaWords ? PER_LOT.test(windowAround(coaWords.page.text, coaWords.m.index, coaWords.m[0].length)) : false;
    const where = coaWords ?? null;
    checks.coa_published = where
      ? found(where, perLot ? "met" : "partly", docs.length ? `${docs.length} certificate document${docs.length === 1 ? "" : "s"} linked` : null)
      : { result: "partly", value: `${docs.length} certificate document${docs.length === 1 ? "" : "s"} linked`, source_url: docs[0]?.page.url ?? coaPage?.url ?? null, quote: null, quote_verified_on: null };
  }

  // Laboratories named, and the best tier among them.
  const named: Array<{ lab: LabSeed; hit: { page: Page; m: RegExpExecArray } }> = [];
  for (const lab of labs) {
    // The lab's full name, or the distinctive names in seed/lab-aliases.json ("Janoshik"), never a bare common word.
    const names = (input.labAliases?.[lab.slug] ?? [lab.name]).filter((n) => n.length >= 4).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const hit = firstMatch(pages, new RegExp(`\\b(?:${names.join("|")})\\b`, "i"));
    if (hit) named.push({ lab, hit });
  }
  if (named.length) {
    checks.coa_lab_named = found(named[0].hit, "met", named.map((n) => n.lab.name).join(", "));
    const rank = { accredited: 3, recognised: 2, unknown: 1, not_accepted: 0 } as const;
    const best = [...named].sort((a, b) => rank[b.lab.tier] - rank[a.lab.tier])[0];
    checks.coa_lab_tier = {
      result: best.lab.tier === "accredited" ? "met" : best.lab.tier === "recognised" ? "partly" : best.lab.tier === "not_accepted" ? "not_met" : "unchecked",
      value: best.lab.name, source_url: null, quote: null, quote_verified_on: null,
    };
  }

  // Reports checkable on the lab's own site: a verification link, or words saying how.
  const verifyLink = pages.flatMap((p) => p.links.filter((l) => VERIFY_LINK.test(l.href)).map((l) => ({ page: p, link: l })))[0];
  const verifyWords = firstMatch(pages, VERIFY, (m, p) => /\b(?:lab|COA|certificate|report|janoshik|test)\w*/i.test(windowAround(p.text, m.index, m[0].length)));
  if (verifyWords) checks.coa_verifiable = found(verifyWords, "met");
  else if (verifyLink) checks.coa_verifiable = { result: "met", value: verifyLink.link.label || null, source_url: verifyLink.page.url, quote: verifyLink.link.label.length >= 6 ? verifyLink.link.label : null, quote_verified_on: null };

  const ms = firstMatch(pages, MASS_SPEC);
  if (ms) checks.coa_identity_ms = found(ms, "met");
  const endo = firstMatch(pages, ENDOTOXIN, (m, p) => !/\b(?:silent on|omit|omits|not|no|without|never|don't|do not|lack)\b[^.!?]{0,30}$/i.test(p.text.slice(Math.max(0, m.index - 40), m.index)));
  if (endo) {
    const onRequest = /\b(?:on|upon) request\b/i.test(endo.page.text.slice(endo.m.index, endo.m.index + 120));
    checks.coa_endotoxin = found(endo, onRequest ? "partly" : "met");
  }

  // A certificate dated in the last 12 months, on a certificates page.
  if (coaPage) {
    const year = 365 * 24 * 3600 * 1000;
    const recent = firstMatch([coaPage], DATE, (m) => {
      const d = dateOf(m);
      return d !== null && d.getTime() <= today.getTime() + 24 * 3600 * 1000 && today.getTime() - d.getTime() <= year;
    });
    if (recent) checks.coa_current = found(recent, "met");
  }

  // Independent results: a tester's page about this store that shows results.
  if (input.independent) {
    const hit = firstMatch([input.independent], /\b([1-9]\d*) (?:tests?|samples?(?: tested)?)(?: · \d+ peptides?)?(?: · latest [A-Za-z0-9 ]{3,20}?\d{4})?/i);
    // The count and date only: a tester's own ratings are its work, not ours to republish.
    if (hit) checks.independent_results = { ...found(hit, "met", new URL(input.independent.url).hostname.replace(/^www\./, "")), quote: hit.m[0] };
  }

  // Human-use claims: candidates only; reviewHumanUse decides.
  const human_use_candidates: Findings["human_use_candidates"] = [];
  for (const page of pages) {
    for (const m of text(page).matchAll(HUMAN_USE)) {
      const before = page.text.slice(Math.max(0, (m.index ?? 0) - 60), m.index);
      const quote = windowAround(page.text, m.index ?? 0, m[0].length);
      // A question ("Is this for human use?") is not a claim, and neither is a denial.
      const after = page.text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 80);
      const question = /^[^.!?]*\?/.test(after);
      if (NEGATED.test(before) || question || BAC_WATER.test(quote)) continue;
      if (human_use_candidates.some((c) => c.quote === quote)) continue;
      human_use_candidates.push({ url: page.url, quote, term: m[0] });
      if (human_use_candidates.length >= 8) break;
    }
  }
  checks.no_human_use_claims = human_use_candidates.length === 0
    ? { result: "met", value: null, source_url: null, quote: null, quote_verified_on: null }
    : { result: "unchecked", value: null, source_url: null, quote: null, quote_verified_on: null };

  const recall = firstMatch(pages, RECALL);
  if (recall) checks.lot_notice_process = found(recall, "met");

  return { checks, country, ships_to, ships_worldwide, human_use_candidates };
}

/** A person's (or a reviewing model's) verdict on the candidates: the first real claim makes the check "not met". */
export function reviewHumanUse(findings: Findings, verdicts: Array<{ quote: string; claim: boolean }>): CheckSeed {
  const claim = findings.human_use_candidates.find((c) => verdicts.some((v) => v.claim && v.quote === c.quote));
  if (claim) return { result: "not_met", value: claim.term, source_url: claim.url, quote: claim.quote, quote_verified_on: null };
  const allJudged = findings.human_use_candidates.every((c) => verdicts.some((v) => v.quote === c.quote));
  return allJudged ? { result: "met", value: null, source_url: null, quote: null, quote_verified_on: null } : findings.checks.no_human_use_claims;
}

// ── Which pages to read ─────────────────────────────────────────────────────
const MAX_PAGES = 8;

const PRIORITY: Array<[RegExp, number]> = [
  [/\b(?:coa|coas|lab[- ]?(?:results?|tests?|reports?)|certificates?|third[- ]party|testing|test[- ]results?|quality|analysis|purity)\b/i, 10],
  [/\b(?:about|about[- ]us|who[- ]we[- ]are|our[- ]story|company)\b/i, 8],
  [/\b(?:contact|contact[- ]us|imprint|impressum|legal[- ]notice|mentions[- ]l[ée]gales|aviso[- ]legal)\b/i, 8],
  [/\b(?:shipping|delivery|livraison|versand|env[ií]os?)\b/i, 7],
  [/\b(?:faq|faqs|questions)\b/i, 6],
  [/\b(?:terms|conditions|tos|agb|cgv)\b/i, 5],
  [/\b(?:privacy|datenschutz)\b/i, 3],
  [/\b(?:refund|returns?|recall)\b/i, 3],
];

/** The store's own pages most worth reading for the checks, best first. */
export function pickLinks(home: string, links: Array<{ href: string; label: string }>): string[] {
  const seen = new Set<string>([home.replace(/\/$/, "")]);
  const scored: Array<{ href: string; score: number }> = [];
  for (const l of links) {
    const href = l.href.split("#")[0].replace(/\/$/, "");
    if (seen.has(href) || /\.(?:pdf|png|jpe?g|webp|gif|svg|zip)(?:\?|$)/i.test(href) || /[?&](?:add-to-cart|orderby|filter_)/i.test(href)) continue;
    if (/\/(?:product|products|shop|cart|checkout|my-account|account|login|collections|product-category|tag|category|blog|wp-json)\//i.test(new URL(href).pathname + "/")) continue;
    const words = `${new URL(href).pathname.replace(/[/_-]+/g, " ")} ${l.label}`;
    const score = PRIORITY.reduce((s, [re, w]) => (re.test(words) ? Math.max(s, w) : s), 0);
    if (score > 0) {
      seen.add(href);
      scored.push({ href, score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_PAGES).map((s) => s.href);
}
