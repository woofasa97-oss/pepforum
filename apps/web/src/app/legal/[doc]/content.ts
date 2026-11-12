/**
 * Policy pages. Plain-language summaries for launch; have them reviewed by
 * Canadian counsel before public launch (docs/DATA_PRIVACY.md checklist).
 */
export interface LegalDoc {
  readonly title: string;
  readonly lead: string;
  readonly sections: ReadonlyArray<{ readonly h: string; readonly p: readonly string[] }>;
}

type Bilingual = Record<'en' | 'fr', LegalDoc>;

export const LEGAL_DOCS: Record<string, Bilingual> = {
  'community-notes': {
    en: {
      title: 'How community notes work',
      lead: 'Context from the community, shown only when people who usually disagree agree it’s helpful.',
      sections: [
        { h: 'The idea', p: ['A post makes a claim. A contributor writes a short note with sources. Other members rate it. A note is shown on the post only when raters with different track records both find it helpful, so a majority can’t force a note through and a minority can’t block a fair one.'] },
        { h: 'Who can rate and write', p: [
          'Rating opens at Trusted (1,000 karma) for accounts at least 30 days old with integrity 70+. New raters start on probation: their ratings don’t count yet, but they build “rater impact” every time they agree with a note’s final outcome.',
          'Writing notes needs Contributor (3,000 karma) and a graduated rater record. Writers are shown publicly under a pseudonym.',
        ] },
        { h: 'What it means for authors', p: [
          'Most notes simply add context and cost nobody anything. Only a note classified “Misleading claim” that raters across perspectives agree on, on a post that isn’t a first-hand Experience, and that the author doesn’t correct within 72 hours, leads to a strike (lower integrity for 90 days) and a small, capped karma loss.',
          'Correcting your post is always the best response.',
        ] },
        { h: 'Rewards', p: ['Moderation XP is paid only when a note becomes final, and only for accuracy: matching the cross-perspective outcome earns XP, and blind guessing earns nothing on average. Moderation XP is how you reach note-writing and Steward powers.'] },
        { h: 'What notes are not', p: ['Not a downvote, not a moderator action, not medical advice. Sponsored content can’t receive notes.'] },
      ],
    },
    fr: {
      title: 'Fonctionnement des notes communautaires',
      lead: 'Du contexte de la communauté, affiché seulement quand des gens qui divergent d’habitude s’entendent sur son utilité.',
      sections: [
        { h: 'Le principe', p: ['Une publication fait une affirmation. Un contributeur rédige une courte note avec des sources. D’autres membres l’évaluent. La note s’affiche seulement si des évaluateurs aux historiques différents la jugent utile : une majorité ne peut pas imposer une note, et une minorité ne peut pas bloquer une note juste.'] },
        { h: 'Qui peut évaluer et rédiger', p: [
          'L’évaluation s’ouvre au niveau De confiance (1 000 karma), pour les comptes d’au moins 30 jours avec une intégrité de 70+. Les nouveaux évaluateurs sont en probation : leurs évaluations ne comptent pas encore, mais bâtissent leur « impact » chaque fois qu’ils concordent avec le résultat final.',
          'Rédiger exige le niveau Contributeur (3 000 karma) et une probation réussie. Les rédacteurs apparaissent publiquement sous un pseudonyme.',
        ] },
        { h: 'Pour les auteurs', p: [
          'La plupart des notes ajoutent simplement du contexte, sans coût pour personne. Seule une note « Affirmation trompeuse » approuvée par des évaluateurs de perspectives diverses, sur une publication qui n’est pas une Expérience vécue, et que l’auteur ne corrige pas dans les 72 heures, entraîne une pénalité (intégrité réduite pendant 90 jours) et une petite perte de karma plafonnée.',
          'Corriger sa publication est toujours la meilleure réponse.',
        ] },
        { h: 'Récompenses', p: ['L’XP de modération n’est versée qu’une fois la note finale, et seulement pour la justesse : concorder avec le résultat multi-perspectives rapporte de l’XP; deviner ne rapporte rien en moyenne. L’XP de modération mène à la rédaction de notes et aux pouvoirs de Gardien.'] },
        { h: 'Ce que les notes ne sont pas', p: ['Ni un vote négatif, ni une action de modération, ni un avis médical. Le contenu commandité ne peut pas recevoir de notes.'] },
      ],
    },
  },
  'content-policy': {
    en: {
      title: 'Content policy',
      lead: 'What belongs on Pepforum, what gets a note, and what gets removed.',
      sections: [
        { h: 'Welcome', p: ['Questions, first-hand experiences (posted as Experience), research discussion with sources, coverage and regulation by province, respectful disagreement.'] },
        { h: 'Gets a community note', p: ['Misleading or cherry-picked figures, missing context (small trial, animal data, preprint), outdated regulatory information, unverifiable certificates.'] },
        { h: 'Removed by moderators', p: ['Sourcing (vendors, prices, “DM me”, group buys, import tips), dosing instructions, impersonating clinicians, harassment, before/after bodies and shaming, affiliate links. Sourcing costs 100 karma and a strike.'] },
        { h: 'Appeals', p: ['Every removal and sanction can be appealed once from your Standing page, within 30 days. A different moderator decides, and an upheld appeal reverses the penalty on the record.'] },
      ],
    },
    fr: {
      title: 'Politique de contenu',
      lead: 'Ce qui a sa place sur Pepforum, ce qui reçoit une note et ce qui est retiré.',
      sections: [
        { h: 'Bienvenu', p: ['Questions, expériences vécues (publiées comme Expérience), discussion de recherche sourcée, couverture et réglementation par province, désaccords respectueux.'] },
        { h: 'Reçoit une note communautaire', p: ['Chiffres trompeurs ou choisis, contexte manquant (petit essai, données animales, prépublication), information réglementaire périmée, certificats invérifiables.'] },
        { h: 'Retiré par les modérateurs', p: ['Approvisionnement (vendeurs, prix, « écris-moi », achats groupés, conseils d’importation), instructions de dosage, usurpation de cliniciens, harcèlement, photos avant/après et humiliation, liens d’affiliation. L’approvisionnement coûte 100 karma et une pénalité.'] },
        { h: 'Appels', p: ['Chaque retrait ou sanction peut faire l’objet d’un appel depuis votre page Réputation, dans les 30 jours. Un autre modérateur tranche, et un appel accueilli annule la pénalité au dossier.'] },
      ],
    },
  },
  terms: {
    en: {
      title: 'Terms of use',
      lead: 'Be an adult, don’t sell, don’t pretend to be a clinician, and remember nothing here is medical advice.',
      sections: [
        { h: 'Eligibility', p: ['You must be 18 or older. Accounts are personal.'] },
        { h: 'Not medical advice', p: ['Everything on Pepforum, including clinician posts and community notes, is general information. Talk to a licensed clinician who knows your history.'] },
        { h: 'Your content', p: ['You own what you post and license Pepforum to display it. Notes and ratings are part of the community record.'] },
        { h: 'Karma and privileges', p: ['Karma, moderation XP and privileges have no monetary value and may be adjusted to correct abuse. Every adjustment is recorded in your ledger.'] },
        { h: 'Governing law', p: ['These terms are governed by the laws of Ontario and the federal laws of Canada applicable therein.'] },
      ],
    },
    fr: {
      title: 'Conditions d’utilisation',
      lead: 'Soyez adulte, ne vendez rien, ne vous faites pas passer pour un clinicien, et rappelez-vous que rien ici n’est un avis médical.',
      sections: [
        { h: 'Admissibilité', p: ['Vous devez avoir 18 ans ou plus. Les comptes sont personnels.'] },
        { h: 'Pas un avis médical', p: ['Tout sur Pepforum, y compris les publications de cliniciens et les notes, est de l’information générale. Consultez un clinicien autorisé qui connaît votre dossier.'] },
        { h: 'Votre contenu', p: ['Vous êtes propriétaire de vos publications et accordez à Pepforum une licence pour les afficher. Les notes et évaluations font partie du dossier communautaire.'] },
        { h: 'Karma et privilèges', p: ['Le karma, l’XP de modération et les privilèges n’ont aucune valeur monétaire et peuvent être ajustés pour corriger un abus. Chaque ajustement est consigné dans votre registre.'] },
        { h: 'Droit applicable', p: ['Ces conditions sont régies par les lois de l’Ontario et les lois fédérales du Canada qui s’y appliquent.'] },
      ],
    },
  },
  privacy: {
    en: {
      title: 'Privacy policy',
      lead: 'What we collect, why, where it’s stored, and your rights under PIPEDA and Québec’s Loi 25.',
      sections: [
        { h: 'What we collect', p: ['Email, username, password hash (held by our authentication provider), province, the content you post, your votes, ratings and reports, the messages you send the team from Contact the team (deleted with your account), the name, ID and public follower counts of any social account you choose to verify, and security logs. We do not ask for or infer health information.', 'If you sign in with Google, Apple or another provider, it shares your email (and usually your name and photo) with our authentication provider. We use them only to sign you in and never show them: you choose a username instead. The provider knows you use Pepforum.'] },
        { h: 'Where it lives', p: ['Our database is hosted in Canada (Montréal region). Our web servers run in the United States (Ohio); your requests pass through them. This cross-border processing is disclosed in our Loi 25 notice.'] },
        { h: 'Your rights', p: ['Download all your data from Settings › Privacy. Correct your profile anytime. Delete your account from Settings: your profile is anonymised immediately and your login removed within minutes. Your karma history remains as an anonymous record so other members’ standing stays correct.'] },
        { h: 'What we never do', p: ['Sell data, or target ads by profile or inferred health status.', 'Members can’t post vendors or sourcing. The separate Prices section is run by the site: it lists stores and what they charge, counts clicks to a store per vendor per day without recording who clicked, and labels every affiliate relationship (see the affiliate disclosure).'] },
        { h: 'Contact', p: ['Privacy officer: privacy@pepforum.ca'] },
      ],
    },
    fr: {
      title: 'Politique de confidentialité',
      lead: 'Ce que nous recueillons, pourquoi, où c’est stocké, et vos droits en vertu de la LPRPDE et de la Loi 25.',
      sections: [
        { h: 'Ce que nous recueillons', p: ['Courriel, nom d’utilisateur, empreinte du mot de passe (détenue par notre fournisseur d’authentification), province, vos publications, vos votes, évaluations et signalements, les messages que vous envoyez à l’équipe par « Écrire à l’équipe » (supprimés avec votre compte), le nom, l’identifiant et le nombre public d’abonnés de tout compte social que vous choisissez de vérifier, et des journaux de sécurité. Nous ne demandons ni ne déduisons aucune information de santé.', 'Si vous vous connectez avec Google, Apple ou un autre fournisseur, celui-ci transmet votre courriel (et habituellement votre nom et votre photo) à notre fournisseur d’authentification. Nous les utilisons uniquement pour vous connecter et ne les affichons jamais : vous choisissez plutôt un nom d’utilisateur. Le fournisseur sait que vous utilisez Pepforum.'] },
        { h: 'Où elles sont stockées', p: ['Notre base de données est hébergée au Canada (région de Montréal). Nos serveurs web sont aux États-Unis (Ohio); vos requêtes y transitent. Ce traitement transfrontalier est déclaré dans notre avis Loi 25.'] },
        { h: 'Vos droits', p: ['Téléchargez toutes vos données dans Paramètres › Confidentialité. Corrigez votre profil en tout temps. Supprimez votre compte dans Paramètres : votre profil est anonymisé immédiatement et votre identifiant supprimé en quelques minutes. Votre historique de karma demeure sous forme anonyme pour que la réputation des autres membres reste exacte.'] },
        { h: 'Ce que nous ne faisons jamais', p: ['Vendre des données ou cibler des publicités selon le profil ou un état de santé déduit.', 'Les membres ne peuvent pas publier de vendeurs ni d’approvisionnement. La section Prix, distincte, est gérée par le site : elle liste des boutiques et leurs prix, compte les clics vers une boutique par vendeur et par jour sans consigner qui a cliqué, et signale chaque lien d’affiliation (voir la divulgation d’affiliation).'] },
        { h: 'Contact', p: ['Responsable de la protection des renseignements personnels : privacy@pepforum.ca'] },
      ],
    },
  },
  'loi-25': {
    en: {
      title: 'Loi 25 notice',
      lead: 'Information for Québec residents under the Act respecting the protection of personal information in the private sector.',
      sections: [
        { h: 'Person in charge', p: ['Pepforum’s person in charge of the protection of personal information can be reached at privacy@pepforum.ca.'] },
        { h: 'Privacy by default', p: ['No analytics or advertising profiles are created. Optional features are off by default.'] },
        { h: 'Transfers outside Québec', p: ['Data is stored in Canada. Web requests are processed by servers in the United States. A privacy impact assessment covers this transfer.'] },
        { h: 'Automated decisions', p: ['Community-note status, karma and privilege tiers are computed automatically from community activity. The rules are published on the community-notes page, every change to your standing is listed in your ledger, and you can ask for human review through an appeal or by writing to the privacy officer.'] },
        { h: 'Confidentiality incidents', p: ['Incidents presenting a risk of serious injury are reported to the Commission d’accès à l’information and to affected people.'] },
      ],
    },
    fr: {
      title: 'Avis Loi 25',
      lead: 'Information pour les résidents du Québec en vertu de la Loi sur la protection des renseignements personnels dans le secteur privé.',
      sections: [
        { h: 'Responsable', p: ['La personne responsable de la protection des renseignements personnels de Pepforum est joignable à privacy@pepforum.ca.'] },
        { h: 'Confidentialité par défaut', p: ['Aucun profil analytique ou publicitaire n’est créé. Les fonctions facultatives sont désactivées par défaut.'] },
        { h: 'Transferts hors Québec', p: ['Les données sont stockées au Canada. Les requêtes web sont traitées par des serveurs aux États-Unis. Une évaluation des facteurs relatifs à la vie privée couvre ce transfert.'] },
        { h: 'Décisions automatisées', p: ['Le statut des notes, le karma et les niveaux de privilèges sont calculés automatiquement à partir de l’activité de la communauté. Les règles sont publiées sur la page des notes, chaque changement est inscrit à votre registre, et vous pouvez demander une révision humaine par un appel ou en écrivant au responsable.'] },
        { h: 'Incidents de confidentialité', p: ['Les incidents présentant un risque de préjudice sérieux sont déclarés à la Commission d’accès à l’information et aux personnes concernées.'] },
      ],
    },
  },
  'price-methodology': {
    en: {
      title: 'How prices are tracked',
      lead: 'Where the numbers in the Prices section come from, what keeps wrong ones out, and what they do not tell you.',
      sections: [
        { h: 'What we read', p: ['Twice a day an automated reader, PepforumBot, reads each tracked vendor’s own store: its public product feed or, for shops without one, its product pages. It identifies itself, obeys robots.txt, reads slowly, never guesses addresses and stops asking a store anything once the store says “too many requests”.', 'A price is stored only if that exact amount appears in what the store sent. Nothing is estimated and nothing is read by a language model.'] },
        { h: 'What is compared', p: ['Each product is matched to exactly one compound; anything ambiguous is left out. Single compounds are compared per milligram for one vial strength at a time. Blends are compared per vial and only against the same exact mix; a blend that does not state its mix is listed but never ranked.', 'An order of several vials is that many single vials less the vendor’s own automatic multi-vial discount, or the vendor’s real kit of that size when it is cheaper.'] },
        { h: 'What keeps bad data out', p: ['Every run is checked against the last good one before anything is shown. A run that lost too many products or vendors, or has too many improbable prices, is held: the site keeps the last checked prices instead.', 'A price that has not been rechecked within the time shown on each page is marked and no longer ranked. A store that refuses our reader keeps its last checked prices, marked as not rechecked.'] },
        { h: 'Currency', p: ['Prices are stored in the vendor’s own currency. US-dollar prices are converted to Canadian dollars only for display, at one dated European Central Bank reference rate, which each page names.'] },
        { h: 'What is not included', p: ['Shipping, tax, payment fees and discount codes are never part of a price or a ranking. A vendor-confirmed code may be shown beside a price; it is never applied.'] },
        { h: 'Certificates of analysis', p: ['Where a vendor publishes a certificate of analysis, a person on our team opens it and records what it states: the lab named, the method, the batch, the test date and the purity figure. We show it as the vendor’s own document with the date we read it.', 'We do not test products, we do not confirm that a certificate matches what a vendor ships, and we do not check a lab’s accreditation. “None on file” means only that we have not recorded one.'] },
        { h: 'What this is not', p: ['The Prices section reports what stores list for products sold for laboratory research. It is not a recommendation of any vendor or product, and nothing in it is a statement about quality, safety, legality or use. Nothing on Pepforum is medical advice.'] },
        { h: 'Vendors', p: ['A vendor can ask to be removed, to correct a fact about it, or to tell us how it would prefer to be read: write to prices@pepforum.ca. Removal takes effect at once.'] },
      ],
    },
    fr: {
      title: 'Comment les prix sont suivis',
      lead: 'D’où viennent les chiffres de la section Prix, ce qui écarte les erreurs, et ce qu’ils ne vous disent pas.',
      sections: [
        { h: 'Ce que nous lisons', p: ['Deux fois par jour, un lecteur automatisé, PepforumBot, lit la boutique de chaque vendeur suivi : son flux de produits public ou, pour les boutiques qui n’en ont pas, ses pages de produits. Il s’identifie, respecte le fichier robots.txt, lit lentement, ne devine jamais d’adresses et cesse d’interroger une boutique dès qu’elle répond « trop de requêtes ».', 'Un prix n’est enregistré que si ce montant exact figure dans ce que la boutique a envoyé. Rien n’est estimé et rien n’est lu par un modèle de langage.'] },
        { h: 'Ce qui est comparé', p: ['Chaque produit est associé à un seul composé; tout ce qui est ambigu est écarté. Les composés simples sont comparés au milligramme, un dosage de fiole à la fois. Les mélanges sont comparés à la fiole et seulement à composition identique; un mélange dont la composition n’est pas précisée est listé, mais jamais classé.', 'Une commande de plusieurs fioles correspond à autant de fioles à l’unité, moins le rabais multi-fioles automatique du vendeur, ou à la trousse réelle de cette taille lorsqu’elle coûte moins cher.'] },
        { h: 'Ce qui écarte les mauvaises données', p: ['Chaque exécution est comparée à la dernière qui était bonne avant tout affichage. Une exécution qui a perdu trop de produits ou de vendeurs, ou qui contient trop de prix improbables, est retenue : le site conserve alors les derniers prix vérifiés.', 'Un prix qui n’a pas été revérifié dans le délai indiqué sur chaque page est signalé et n’est plus classé. Une boutique qui refuse notre lecteur conserve ses derniers prix vérifiés, signalés comme non revérifiés.'] },
        { h: 'Devise', p: ['Les prix sont enregistrés dans la devise du vendeur. Les prix en dollars américains sont convertis en dollars canadiens pour l’affichage seulement, à un taux de référence daté de la Banque centrale européenne, que chaque page nomme.'] },
        { h: 'Ce qui n’est pas inclus', p: ['La livraison, les taxes, les frais de paiement et les codes de rabais ne font jamais partie d’un prix ni d’un classement. Un code confirmé par le vendeur peut être affiché à côté d’un prix; il n’est jamais appliqué.'] },
        { h: 'Certificats d’analyse', p: ['Lorsqu’un vendeur publie un certificat d’analyse, une personne de notre équipe l’ouvre et consigne ce qu’il indique : le laboratoire nommé, la méthode, le lot, la date du test et le chiffre de pureté. Nous le présentons comme le document du vendeur, avec la date à laquelle nous l’avons lu.', 'Nous ne testons pas les produits, nous ne confirmons pas qu’un certificat correspond à ce qu’un vendeur expédie, et nous ne vérifions pas l’accréditation d’un laboratoire. « Aucun au dossier » signifie seulement que nous n’en avons consigné aucun.'] },
        { h: 'Ce que ce n’est pas', p: ['La section Prix rapporte ce que les boutiques affichent pour des produits vendus à des fins de recherche en laboratoire. Ce n’est pas une recommandation d’un vendeur ou d’un produit, et rien de ce qui s’y trouve n’est une affirmation sur la qualité, l’innocuité, la légalité ou l’usage. Rien sur Pepforum n’est un avis médical.'] },
        { h: 'Vendeurs', p: ['Un vendeur peut demander son retrait, la correction d’un fait le concernant ou nous indiquer comment il préfère être lu : écrivez à prices@pepforum.ca. Le retrait prend effet immédiatement.'] },
      ],
    },
  },
  'affiliate-disclosure': {
    en: {
      title: 'Affiliate disclosure',
      lead: 'How Pepforum may earn money from the Prices section, and what that money cannot buy.',
      sections: [
        { h: 'What an affiliate link is', p: ['Some vendors pay a commission when a visitor arrives from Pepforum and buys something. Where we have such an arrangement, the vendor is marked “Affiliate” wherever it appears, and it is named in the list on the Vendors tracked page.'] },
        { h: 'What it never changes', p: ['An affiliate vendor is read, priced and ranked exactly like every other vendor. The order of a comparison and the “Lowest” label depend on price alone. Vendors without an arrangement are listed in full, and no vendor can pay to be listed, to rank higher or to have a competitor removed.'] },
        { h: 'Links and tracking', p: ['Every link from a price page to a store is marked as sponsored, whether or not it earns anything. We count clicks per vendor per day and nothing else: no account, no address and no cookie is recorded for a click. What a store does once you are on its site is covered by its own policies.'] },
        { h: 'Codes', p: ['A discount code is shown only when the vendor has confirmed it to us in writing. A code is never applied to a price shown here.'] },
        { h: 'The forum', p: ['Affiliate arrangements buy nothing in the community: they do not affect karma, community notes or moderation, and members still may not post vendors, prices or affiliate links.'] },
      ],
    },
    fr: {
      title: 'Divulgation d’affiliation',
      lead: 'Comment Pepforum peut tirer un revenu de la section Prix, et ce que cet argent ne peut pas acheter.',
      sections: [
        { h: 'Ce qu’est un lien d’affiliation', p: ['Certains vendeurs versent une commission lorsqu’un visiteur arrive de Pepforum et achète quelque chose. Lorsqu’une telle entente existe, le vendeur porte la mention « Affilié » partout où il apparaît, et il est nommé dans la liste de la page Vendeurs suivis.'] },
        { h: 'Ce que cela ne change jamais', p: ['Un vendeur affilié est lu, tarifé et classé exactement comme tous les autres. L’ordre d’une comparaison et la mention « Le plus bas » dépendent du prix seulement. Les vendeurs sans entente sont listés au complet, et aucun vendeur ne peut payer pour être listé, pour être mieux classé ou pour faire retirer un concurrent.'] },
        { h: 'Liens et suivi', p: ['Chaque lien d’une page de prix vers une boutique est marqué comme commandité, qu’il rapporte quelque chose ou non. Nous comptons les clics par vendeur et par jour, rien d’autre : aucun compte, aucune adresse et aucun témoin n’est enregistré pour un clic. Ce qu’une boutique fait une fois que vous êtes sur son site relève de ses propres politiques.'] },
        { h: 'Codes', p: ['Un code de rabais n’est affiché que si le vendeur nous l’a confirmé par écrit. Un code n’est jamais appliqué à un prix affiché ici.'] },
        { h: 'Le forum', p: ['Les ententes d’affiliation n’achètent rien dans la communauté : elles n’influencent ni le karma, ni les notes de la communauté, ni la modération, et les membres ne peuvent toujours pas publier de vendeurs, de prix ou de liens d’affiliation.'] },
      ],
    },
  },
};
