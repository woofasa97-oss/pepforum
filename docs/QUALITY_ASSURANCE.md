# The Pepforums Standard — Quality Assurance Policy

**Version:** 0.9 (draft, not yet in force) · **Last changed:** 12 November 2026

This draft becomes v1.0 after two reviews:
- **Verified experts** check the numbers.
- **Counsel** checks the wording.

Until then, no grade is published.

## Contents
1. [What this standard is, and is not](#1-what-this-standard-is-and-is-not)
2. [Words used here](#2-words-used-here)
3. [Accepted laboratories](#3-accepted-laboratories)
4. [What a certificate of analysis must show](#4-what-a-certificate-of-analysis-must-show)
5. [The base panel: every peptide, every lot](#5-the-base-panel-every-peptide-every-lot)
6. [The yearly full panel](#6-the-yearly-full-panel)
7. [Extra requirements by category](#7-extra-requirements-by-category)
8. [How evidence is weighed and graded](#8-how-evidence-is-weighed-and-graded)
9. [Store levels and the Verified listing](#9-store-levels-and-the-verified-listing)
10. [Failures, notices and appeals](#10-failures-notices-and-appeals)
11. [Labelling, storage and records](#11-labelling-storage-and-records)
12. [Governance and changes](#12-governance-and-changes)
13. [References](#13-references)
14. [Open questions before v1.0](#14-open-questions-before-v10)

**How to read the numbers.** Every limit carries one of two tags:
- **[anchor]**: taken from a pharmacopoeia, ICH guideline, or FDA or EMA guidance (cited in §13).
- **[proposal]**: Pepforums' own choice, with the reason given.

Where a public pharmacopoeial limit exists we use it. The specifications for approved peptide medicines are paywalled or confidential, so the purity limits below are proposals.

---

## 1. What this standard is, and is not

**It is** a published, versioned rule for judging the *evidence* about a peptide product's quality:
- is it what the label says;
- how pure is it;
- how much is in the vial;
- is it free of endotoxin, metals and solvents.

It applies the same way to every store, and no payment changes a result.

**It is not:**
- A statement that any product is safe to use, approved, or legal to buy, sell or possess where you are. Many peptides are unapproved drugs in many countries.
- Medical advice. Pepforums publishes no doses, protocols or calculators.
- A test performed by Pepforums. Pepforums does not buy or test products. It grades results from laboratories.

"Meets the Standard" means: *the evidence we hold, under the rules below, supports the label claim for the products listed.* Nothing more.

## 2. Words used here

| Term | Meaning |
|---|---|
| **Lot** (batch) | Product made in one run, carrying one lot number on the vial. |
| **Certificate (COA)** | A laboratory's report on a sample from one lot. |
| **Blind purchase** | A sample bought at retail by someone the store cannot identify in advance: an independent testing service, or a member. |
| **Member purchase** | A sample a Pepforums member bought, had tested, and submitted with the report. |
| **Store-submitted sample** | A sample the store chose and sent to the lab. |
| **Store-published certificate** | A certificate the store posts on its own site, with no independent check that it matches what is sold. |
| **Verified result** | A result whose report Pepforums has confirmed is genuine, either through the lab's own portal ("key-verified") or by a verified expert's review ("expert-verified"). |
| **Category** | The group a compound belongs to (§7). It decides which extra tests apply. |

## 3. Accepted laboratories

| Tier | Requirement | Weight in grading |
|---|---|---|
| **Accredited** | ISO/IEC 17025:2017 by a signatory of the ILAC Mutual Recognition Arrangement (e.g. A2LA, ANAB, UKAS, DAkkS, SCC, NATA), **with the method used listed on the scope** | full |
| **Recognised** | Not accredited, but every report can be checked on the lab's own public portal by a key or QR code, and the lab names its methods | reduced (§8) |
| **Not accepted** | A lab owned by, or under common control with, the store or its supplier; a lab whose reports cannot be checked | none |

**Method validation.** Methods must be validated to ICH Q2(R2) [anchor] (specificity, accuracy, precision, linearity and range). The quantitation limit for related impurities must be at or below **0.1%** [anchor: Ph. Eur. reporting threshold].

Pepforums keeps a public list of labs with their tier, accreditation body, number and scope, and how to verify their reports.

## 4. What a certificate of analysis must show

A certificate counts only if it shows **all** of the following. The field list follows California's cannabis certificate rule (4 CCR §15726) [anchor, used as a model] and current independent-testing practice.

1. Laboratory name, address, and accreditation body and number (or "not accredited").
2. The **store's name** as the client, or "member submission" with the purchase date.
3. **Lot number, matching the vial label.** One certificate covers one lot.
4. A unique sample ID, the sample's description and a photo of the vial as received.
5. Dates: collected or purchased, received by the lab, and analysed.
6. For each test: the method, the limit of quantitation, the result with units, and pass or fail. "ND" (not detected) and "NT" (not tested) are stated, never left blank.
7. The label claim it was tested against (mg per vial, and whether that is net peptide or gross powder).
8. A signatory, and a link, key or QR code that verifies the report on the lab's site.

**Automatic rejection:**
- the same certificate shown for more than one lot or more than one store;
- a store name or lot that does not match;
- a verification key that does not resolve;
- signs of editing.

A forged certificate gets the store **delisted** (§10). For a member submission, it is a strike under the community rules.

## 5. The base panel: every peptide, every lot

Every lot of every listed peptide needs these results, from one or more certificates:

| Test | Method | Pass criterion | Basis |
|---|---|---|---|
| **Identity** | LC-MS or HRMS intact mass; MS/MS where the category requires it | Measured mass matches the declared sequence, modifications and salt form. On HRMS the error must be within 10 ppm | method [anchor]; 10 ppm [proposal]. Mass is the standard identity test and UV alone cannot prove identity. |
| **Purity** | Reversed-phase HPLC, UV 214–220 nm, area %; method able to quantify 0.1% | **≥ 98.0%** (Verified) · **≥ 99.0%** (Verified+) | [proposal]. Matches the strictest public independent-testing practice; approved-API specifications are not public. |
| **Largest single impurity** | Same run | **≤ 1.0%**; any impurity **≥ 0.5%** identified by mass | [anchor]: Ph. Eur. 2034 and the EMA guideline on synthetic peptides use report 0.1% / identify 0.5% / qualify 1.0%. FDA's 2021 synthetic-peptide guidance treats new impurities above 0.5% as a disqualifying difference. |
| **Content vs label** | Quantitative HPLC against a reference standard; net or gross basis stated; at least 3 vials when more than one is available | Mean **90–110%** of the label claim; no single vial outside **±15%** | [proposal], after the USP &lt;905&gt; uniformity pattern [anchor]. |
| **Endotoxin** | LAL or recombinant factor C / cascade reagent (USP &lt;85&gt; / &lt;86&gt;) | **≤ 40 EU per vial** | [proposal]. The USP &lt;85&gt; limit is K/M with K = 5 EU/kg/hour [anchor]. The per-vial figure follows current independent-testing practice until category maxima are set (§14). |
| **Counter-ion** | Ion chromatography or ¹⁹F NMR | Declared salt form confirmed; TFA % and acetate % reported | [anchor]: FDA treats different salt forms (e.g. semaglutide sodium vs acetate) as different active ingredients. TFA has no compendial limit (§14). |

**Purity is not identity, and neither is quantity.** HPLC purity cannot show a wrong sequence, a missing residue or an under-filled vial. All three tests are required.

## 6. The yearly full panel

Every store needs, at least once a year and rotating across its products:

| Test | Pass criterion | Basis |
|---|---|---|
| **Sterility**, for anything sold as sterile | Pass USP &lt;71&gt;: no growth after at least 14 days. Sample size: 10% or 4 containers (lots ≤100), 10 (101–500), 2% or 20 (over 500) | [anchor] USP &lt;71&gt; |
| **Elemental impurities** by ICP-MS | Pb, As, Cd, Hg per vial at or below **30%** of the ICH Q3D parenteral PDE. PDEs (µg/day): Pb 5 · As 15 · Cd 2 · Hg 3 | PDEs [anchor] ICH Q3D(R2); 30% is the Q3D control threshold [anchor] |
| **Residual solvents** by GC headspace | Within ICH Q3C. Class 2: acetonitrile ≤ 410 ppm, DMF ≤ 880 ppm, dichloromethane ≤ 600 ppm. Class 3 (e.g. acetic acid, ether, MTBE) ≤ 0.5% | [anchor] ICH Q3C |
| **Water** by Karl Fischer (USP &lt;921&gt;) | Reported. It closes the mass balance with net content and counter-ion | [anchor] method |

## 7. Extra requirements by category

Each compound in the Pepforums database carries exactly one category. The category adds tests to §5:

| Category | Examples | Additional requirement |
|---|---|---|
| **Lipidated incretin agonists** | semaglutide, tirzepatide, retatrutide, cagrilintide | An HPLC gradient able to separate side-chain variants (e.g. des-linker and α-Glu variants of semaglutide). Size-exclusion chromatography for aggregates. Salt form stated. **Investigational compounds with no pharmacopeial reference (e.g. retatrutide): HRMS plus MS/MS sequence confirmation.** |
| **Short linear peptides** | BPC-157, TB-500 fragment, KPV, epitalon, DSIP | The exact sequence named on the label and certificate. "TB-500" is sold as different sequences, so the name alone is not enough. For very short peptides that retain poorly on reversed-phase HPLC, HILIC or amino acid analysis is accepted for purity and content. |
| **Cyclic or modified peptides** | PT-141 (bremelanotide), melanotan II | Un-cyclised precursor (+18 Da) checked by mass. Chiral purity for D-amino-acid residues (e.g. D-Phe). |
| **GH secretagogues and GHRH analogues** | ipamorelin, GHRP-2, GHRP-6, CJC-1295 with / without DAC, sermorelin, tesamorelin | Configuration of intended D-residues confirmed (chiral analysis). The mass must tell CJC-1295 with DAC from without DAC, a known mislabelling. Tesamorelin: the N-terminal acyl group confirmed by mass. |
| **Copper complexes** | GHK-Cu | Copper by ICP-OES or ICP-MS, against the theoretical copper share of the declared formula (about 15.8% for the 1:1 complex), within ±10% of that share [proposal]. Stoichiometry stated. |
| **Other bioactive peptides** | MOTS-c, SS-31 (elamipretide), Semax, Selank | MOTS-c: methionine oxidation reported. SS-31: D-Arg and Dmt configuration confirmed. Multi-dose solutions (e.g. nasal): microbial limits (USP &lt;61&gt; / &lt;62&gt;), preservative effectiveness (USP &lt;51&gt;) and pH (USP &lt;791&gt;). |
| **Blends** | e.g. BPC-157 + TB-500 | **Every component** identified and quantified against its own reference standard. The content-vs-label rule (§5) applies to each component. A blend with an unstated recipe cannot meet the Standard. |
| **Companions** | bacteriostatic water, NAD+ | **Bacteriostatic water:** the full USP monograph for Bacteriostatic Water for Injection [anchor]: endotoxin < 0.5 EU/mL; pH 4.5–7.0; sterility (USP &lt;71&gt;); particulate matter (USP &lt;788&gt;); preservative content and effectiveness; containers ≤ 30 mL; labelled "not for use in newborns". **NAD+:** HPLC purity with nicotinamide and ADP-ribose reported as degradants; endotoxin. |

## 8. How evidence is weighed and graded

### 8.1 Weight of one result
A result's weight is the product of three factors [all proposal]:

| Factor | Values |
|---|---|
| **Sample source** | blind purchase 1.0 · member purchase 1.0 · store-submitted 0.5 · store-published certificate 0.25 |
| **Lab tier** (§3) | accredited 1.0 · recognised 0.7 |
| **Verification** | key-verified or expert-verified 1.0 · not verified 0.3 (store-published only) · rejected 0 |

**Age.** A result's weight halves every **365 days** [proposal; one independent tester uses 730]. Results older than 24 months no longer count toward coverage.

### 8.2 Product grade
For each product (one compound, one store), the weighted pass rate of the base panel and its category add-ons is shrunk toward the category average when evidence is thin. A single good result never outweighs a history of failures.

### 8.3 Levels shown on the site
Grades are shown as words, never as a "best store" ranking:

| Level | When |
|---|---|
| **Meets the Standard** | ≥ 80% of the store's listed products have a verified result under 12 months old; no unresolved identity or endotoxin failure in 12 months; a weighted base-panel pass rate ≥ 95%; at least one result from a sample the store did not choose in the last 90 days |
| **Failed a recent test** | An identity or endotoxin failure in the last 90 days not cleared under §10, or two confirmed failures in 12 months |
| **Partial evidence** | Some verified results, but not enough for "Meets the Standard" |
| **No evidence** | No verified result under 12 months old |

Each grade states the **Standard version** it was computed under and the date. Prices are compared separately and never adjusted by grade.

## 9. Store levels and the Verified listing

| Level | How a store gets there | What it can do |
|---|---|---|
| **Aggregated** | Pepforums lists it from public information (its own store pages). | Nothing; it is listed. Its grade comes from any results members submit. |
| **Claimed** | Proves it controls the domain: a DNS TXT record `pepforums-verify=<token>`, or the file `/.well-known/pepforums-verify.txt`. | Correct its profile; publish a price feed; upload certificates; reply in discussions with a "Store" label. |
| **Verified** | Meets **every** requirement below, checked by Pepforums staff. | Shows the Verified mark beside its listing. |

**Requirements for Verified:**
1. **Identity.** Legal or trading name, country of operation, contact address, and the countries it ships to.
2. **Certificates.** Every product it lists on Pepforums has a certificate under 12 months old for the lot currently sold, meeting §4, §5 and §7.
3. **Surveillance.** At least **one result per quarter** from a sample the store did not choose: a member purchase, or a blind purchase by an independent testing service the store may commission. Pepforums never buys samples.
4. **Full panel.** The §6 panel at least once a year.
5. **Labelling** as in §11.
6. **No human-use claims.** Its Pepforums listing carries no dosing, protocol, health or "for human use" claims, and no referral or discount codes.
7. **Lot notices and recalls.** A written process to notify buyers of a failed lot and stop selling it, and evidence it was used (§10).
8. **Records** as in §11.
9. **Conflicts of interest.** Store staff do not vote on, rate notes about, report or review their own store, and declare any ties to other listed stores.

Verified status **lapses by itself** when evidence ages out (requirements 2–4). The store returns to Claimed until it is current again.

## 10. Failures, notices and appeals

| Event | Consequence |
|---|---|
| **Identity failure** (wrong compound, wrong sequence or salt form) or **endotoxin failure** | The Verified mark is suspended at once. A public notice goes on the product and store pages, naming the lot. |
| **Any other failure** (purity, impurity, content, metals, solvents, sterility, category add-on) | A notice on the product. **Two more units from the same lot** must be tested by an accepted lab within **30 days**. If both pass, the notice is marked resolved; if either fails, the failure is confirmed. |
| **Two confirmed failures in 12 months** | Delisted from Verified for at least 6 months. Its listing stays, with its grade. |
| **Forged or reused certificate** | Delisted from Verified for at least 12 months, with a public notice. |
| **The store must** | Notify buyers of the affected lot and stop selling it, and show Pepforums how it did so. |

**Appeals.** A store may appeal within 30 days, with evidence (e.g. a retest of the same lot by an accredited lab). A different staff member decides, with a verified expert's written assessment. The decision and its reason are logged and shown with the notice.

## 11. Labelling, storage and records

**On the vial or its label:**
- lot number;
- amount in mg, and whether that is net peptide or gross powder;
- salt form;
- storage conditions;
- expiry or retest date;
- where to find the certificate for that lot.

Diluents containing benzyl alcohol carry "not for use in newborns".

**Storage and shipping** (guidance, not graded):
- Lyophilised products are kept cold.
- Solutions and reconstituted products ship at 2–8 °C with a temperature indicator.

**Records.** For at least **lot expiry plus 1 year** (3 years recommended), the store keeps:
- certificates and raw lab data;
- complaint records;
- lot-notice and recall records.

[proposal, modelled on 21 CFR 211.180; see §14]

## 12. Governance and changes

- The Standard is **versioned** (0.9, 1.0, 1.1, …) and every change is in the changelog below.
- Changes are announced **30 days** before they take effect, except where a change is needed for safety.
- **No payment, sponsorship or business relationship can change a grade or a result.** Pepforums earns nothing from links to stores.
- Verified experts may propose changes; staff decide, and the reasons are published.

### Changelog
| Version | Date | Change |
|---|---|---|
| 0.9 | 2026-11-12 | First draft, for expert and legal review. |

## 13. References

| Topic | Source |
|---|---|
| Synthetic peptide impurity thresholds (0.1 / 0.5 / 1.0%) | Ph. Eur. general monograph 2034; EMA Guideline on the development and manufacture of synthetic peptides (EMA/CHMP/CVMP/QWP/367182/2025), https://www.ema.europa.eu/system/files/documents/scientific-guideline/guideline-synthetic-peptides-en.pdf |
| New impurities in synthetic peptides vs reference products | FDA, *ANDAs for Certain Highly Purified Synthetic Peptide Drug Products That Refer to Listed Drugs of rDNA Origin* (May 2021) |
| Quality attributes of synthetic peptides | USP &lt;1503&gt;, &lt;1504&gt;, &lt;1052&gt; (amino acid analysis) |
| Endotoxin | USP &lt;85&gt; and &lt;86&gt;; FDA, https://www.fda.gov/media/183132/download |
| Sterility | USP &lt;71&gt;, https://www.drugfuture.com/Pharmacopoeia/usp35/data/v35300/usp35nf30s0_c71.html |
| Particulate matter; uniformity | USP &lt;788&gt;, &lt;790&gt;, &lt;905&gt; |
| Elemental impurities | ICH Q3D(R2) |
| Residual solvents | ICH Q3C, https://fda.gov/media/71737/download |
| Method validation | ICH Q2(R2) |
| Bacteriostatic water | USP monograph, Bacteriostatic Water for Injection, https://drugfuture.com/Pharmacopoeia/USP35/data/v35300/usp35nf30s0_m88830.html |
| Salt forms as different active ingredients | FDA, *Concerns with unapproved GLP-1 drugs used for weight loss* |
| Certificate field model | California Code of Regulations, 4 CCR §15726, https://www.law.cornell.edu/regulations/california/4-CCR-15726 |
| Independent testing practice | Finnrick, testing methodology, https://www.finnrick.com/about/testing-methodology |
| Laboratory accreditation | ISO/IEC 17025:2017; ILAC Mutual Recognition Arrangement |

## 14. Open questions before v1.0

1. **Primary texts.** Confirm the impurity thresholds against the full Ph. Eur. 2034, EMA and FDA texts. The current figures come from official summaries and presentations.
2. **Endotoxin by category.** Replace the flat 40 EU per vial with category limits derived from USP &lt;85&gt; (K/M). This needs a reference maximum amount per category from the clinical literature, kept internal so that no dosing is published.
3. **TFA.** There is no compendial limit for residual trifluoroacetate. Decide whether to keep "report only" or set a limit, with expert input.
4. **Copper.** Confirm whether ICH Q3D's scope excludes intentionally added copper (GHK-Cu), and the tolerance on the copper share.
5. **Record retention.** Confirm the retention period.
6. **Recognised labs.** Confirm the reduced weight (0.7) for non-accredited labs with a verifiable portal, and which labs qualify.
7. **Legal wording.** Counsel to review "Meets the Standard", "Verified" and §1 for every market where the site is visible.
