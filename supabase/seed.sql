-- ============================================================================
-- LOCAL DEVELOPMENT DEMO DATA — never run against production.
--
-- `supabase db reset` applies this after the migrations. `supabase db push`
-- (production) does not. It is also applied by the PGlite test harness, so it
-- stays in sync with the schema.
--
-- Every demo account signs in with the password:  pepforum-demo-2026
--
-- Content is created through the real RPCs (acting as each user via the same
-- JWT claim that PostgREST sets), so the seed exercises the production code
-- paths: capability checks, rate limits, revisions, ledger.
-- ============================================================================

-- Moderator/admin MFA would block the local mod panel. LOCAL ONLY.
update public.app_config set value = 'false' where key = 'security.require_mfa_for_staff';

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
  u.username || '@pepforum.local',
  '$2a$10$ysvX4EPH8DUySEFg2cmd3e59ZK.JNQf4CCbOAlaSoNtsMn8ml9EaS',  -- pepforum-demo-2026
  now() - make_interval(days => u.age_days),
  '', '', '', '',
  '{"provider": "email", "providers": ["email"]}'::jsonb,
  jsonb_build_object('username', u.username, 'locale', u.locale, 'home_zone', u.zone),
  now() - make_interval(days => u.age_days), now()
from (values
  ('a0000000-0000-4000-8000-000000000001', 'ops_lead',        'en', 'on',       400),
  ('a0000000-0000-4000-8000-000000000002', 'maple_you',       'en', 'on',       240),
  ('a0000000-0000-4000-8000-000000000003', 'peptide_analyst', 'en', 'national', 600),
  ('a0000000-0000-4000-8000-000000000004', 'nurse_nova',      'en', 'on',       500),
  ('a0000000-0000-4000-8000-000000000005', 'bc_biohacker',    'en', 'bc',       450),
  ('a0000000-0000-4000-8000-000000000006', 'dr_leclerc',      'fr', 'qc',       700),
  ('a0000000-0000-4000-8000-000000000007', 'newbie_sask',     'en', 'prairies',   2),
  ('a0000000-0000-4000-8000-000000000008', 'island_rn',       'en', 'bc',       480),
  ('a0000000-0000-4000-8000-000000000009', 'to_runner',       'en', 'on',       520),
  ('a0000000-0000-4000-8000-000000000010', 'yyc_lifter',      'en', 'ab',       200)
) as u(id, username, locale, zone, age_days);

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select u.id::text, u.id,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       'email', now(), u.created_at, now()
from auth.users u
where u.email like '%@pepforum.local';

-- Standing. Karma goes through the ledger like everything else.
select private.reconcile('seed:' || p.username, p.id, 'karma', 'seed', 'seed', null, k.karma)
from public.profiles p
join (values
  ('ops_lead', 0), ('maple_you', 2480), ('peptide_analyst', 12400), ('nurse_nova', 7800),
  ('bc_biohacker', 3100), ('dr_leclerc', 15200), ('newbie_sask', 42), ('island_rn', 3900),
  ('to_runner', 5600), ('yyc_lifter', 1340)
) as k(username, karma) on k.username = p.username
where k.karma <> 0;

select private.reconcile('seed_xp:' || p.username, p.id, 'mod_xp', 'seed', 'seed', null, 180)
from public.profiles p where p.username in ('dr_leclerc', 'peptide_analyst');

update public.profiles set rater_status = 'founding', founding_until = now() + interval '180 days'
 where username in ('peptide_analyst', 'dr_leclerc');
update public.profiles set rater_status = 'active', rater_impact = 6
 where username in ('nurse_nova', 'bc_biohacker', 'island_rn', 'to_runner');
update public.profiles set bio = 'Reads trial registries for fun.' where username = 'peptide_analyst';
update public.profiles set bio = 'RN in Ottawa. Opinions are mine.', coi = 'Employed by an Ottawa hospital; no industry ties.'
 where username = 'nurse_nova';
update public.profiles set bio = 'MD, endocrinology. General information only.', coi = 'Consulting fees from a university research group.'
 where username = 'dr_leclerc';

insert into public.user_roles (user_id, role)
select id, 'admin' from public.profiles where username = 'ops_lead';

insert into public.zone_moderators (zone_id, user_id)
select z, p.id from public.profiles p
join (values ('on', 'nurse_nova'), ('bc', 'bc_biohacker'), ('qc', 'dr_leclerc')) as m(z, username) on m.username = p.username;

-- ---------------------------------------------------------------------------
-- Posts and comments, created as their authors
-- ---------------------------------------------------------------------------
-- Sites the demo links to, approved as an admin would on the Links page.
insert into public.approved_domains (domain, reason) values
  ('canada.ca', 'Government of Canada'), ('ramq.gouv.qc.ca', 'Régie de l’assurance maladie du Québec'),
  ('nejm.org', 'Peer-reviewed journal'), ('clinicaltrials.gov', 'Trial registry'), ('scc.ca', 'Standards Council of Canada');

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}', false);
select public.create_post('national', 'weight', 'claim',
  'New study claims GLP-1 peptides cut body weight by 25% in 12 weeks',
  'A chart is circulating showing dramatic weight loss from a recent peptide trial. Is this what people are seeing with their own clinicians?');
select public.create_post('on', 'recovery', 'experience',
  'Six months after knee surgery: what my physio said about the healing-peptide hype',
  'Personal experience: the physio protocol and sleep mattered most. Sharing what I tried and what I think was placebo.',
  null, 'toronto');

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000010","role":"authenticated"}', false);
select public.create_post('ab', 'regulation', 'question',
  'Is BPC-157 now legal to buy in Canada without a prescription?',
  'Heard from a friend that Health Canada loosened its stance on research peptides. Anyone have an official source?');
select public.create_post('ab', 'research', 'claim',
  'Got a purity report back on a research compound: 98.7% means it is safe, right?',
  'Posting the certificate I was sent. No lab name on it, but 98.7% sounds great.');

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000004","role":"authenticated"}', false);
select public.create_post('national', 'access', 'resource',
  'Pharmacare coverage expands: will peptide-based prescriptions be included?',
  'Breaking down the newly announced list of covered medications and which provinces are opting in first.',
  'https://www.canada.ca/en/health-canada/services/pharmacare.html');

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000006","role":"authenticated"}', false);
select public.create_post('qc', 'weight', 'resource',
  'RAMQ et les GLP-1 : ce qui est couvert, ce qui ne l’est pas (mise à jour 2026)',
  'Résumé en français de la couverture actuelle au Québec. Information générale, pas un avis médical.',
  'https://www.ramq.gouv.qc.ca/fr/citoyens/assurance-medicaments', null, 'fr');

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000006","role":"authenticated"}', false);
select public.create_comment(p.id,
  'The 25% number is from a small open-label trial with intensive lifestyle support. Larger placebo-controlled trials land around 15% at 68 weeks.')
from public.posts p where p.title like 'New study claims GLP-1%';

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000007","role":"authenticated"}', false);
select public.create_comment(p.id, 'So is it worth it or not??')
from public.posts p where p.title like 'New study claims GLP-1%';

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000004","role":"authenticated"}', false);
select public.create_comment(c.post_id,
  'That is a conversation for you and a clinician. What this thread can tell you is what the evidence says about averages.', c.id)
from public.comments c where c.body = 'So is it worth it or not??';

-- A few votes from established accounts.
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000009","role":"authenticated"}', false);
select public.cast_vote('post', p.id, 1::smallint) from public.posts p where p.title like 'New study claims GLP-1%';
select public.cast_vote('post', p.id, 1::smallint) from public.posts p where p.title like 'Pharmacare coverage%';
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000008","role":"authenticated"}', false);
select public.cast_vote('post', p.id, 1::smallint) from public.posts p where p.title like 'New study claims GLP-1%';

-- ---------------------------------------------------------------------------
-- Community notes
-- ---------------------------------------------------------------------------
-- n1: missing-context note on the GLP-1 claim, rated helpful by five raters.
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000003","role":"authenticated"}', false);
select public.propose_note(p.id, 'missing_context',
  'The 25% figure comes from a 40-person open-label trial with a strict diet protocol. Larger peer-reviewed trials report about 15% over 68 weeks.',
  '[{"url": "https://www.nejm.org/doi/10.1056/NEJMoa2032183", "kind": "journal"},
    {"url": "https://clinicaltrials.gov/study/NCT03548935", "kind": "registry"}]'::jsonb)
from public.posts p where p.title like 'New study claims GLP-1%';

-- n2: misleading note on the BPC-157 question, split ratings so far.
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000008","role":"authenticated"}', false);
select public.propose_note(p.id, 'misleading',
  'Health Canada still lists BPC-157 as an unapproved substance. No official change in its status has been announced.',
  '[{"url": "https://health-products.canada.ca/dpd-bdpp/index-eng.jsp", "kind": "gov"}]'::jsonb)
from public.posts p where p.title like 'Is BPC-157%';

-- n3: unverifiable-source note on the purity report.
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000004","role":"authenticated"}', false);
select public.propose_note(p.id, 'unverifiable',
  'The certificate has no lab name, accreditation number or batch ID, so it cannot be verified. Accredited labs print all three.',
  '[{"url": "https://www.scc.ca/en/accreditation/laboratories", "kind": "gov"}]'::jsonb)
from public.posts p where p.title like 'Got a purity report%';

-- Raters receive queue assignments, then rate as themselves.
insert into public.rating_assignments (rater_id, note_id)
select r.id, n.id
from public.notes n
cross join public.profiles r
where r.username in ('dr_leclerc', 'nurse_nova', 'bc_biohacker', 'island_rn', 'to_runner', 'peptide_analyst')
  and r.id <> n.author_id
on conflict do nothing;

-- Each rating is cast as its rater (a DO block guarantees the claim is set
-- before the RPC runs).
do $$
declare
  v record;
begin
  for v in
    select p.id as rater, n.id as note, x.value, x.reasons
    from (values
      ('New study claims GLP-1%', 'dr_leclerc',   'helpful',     array['cites_sources', 'addresses_claim']),
      ('New study claims GLP-1%', 'nurse_nova',   'helpful',     array['cites_sources']),
      ('New study claims GLP-1%', 'bc_biohacker', 'helpful',     array['clear']),
      ('New study claims GLP-1%', 'island_rn',    'helpful',     array['important_context']),
      ('New study claims GLP-1%', 'to_runner',    'helpful',     array['neutral']),
      ('Is BPC-157%',             'dr_leclerc',   'helpful',     array['cites_sources']),
      ('Is BPC-157%',             'nurse_nova',   'helpful',     array['clear']),
      ('Is BPC-157%',             'bc_biohacker', 'not_helpful', array['source_mismatch']),
      ('Is BPC-157%',             'to_runner',    'somewhat',    array['partial'])
    ) as x(post_title, username, value, reasons)
    join public.profiles p on p.username = x.username
    join public.posts post on post.title like x.post_title
    join public.notes n on n.post_id = post.id
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', v.rater, 'role', 'authenticated')::text, false);
    perform public.rate_note(v.note, v.value, v.reasons);
  end loop;
end;
$$;

select set_config('request.jwt.claims', '', false);
