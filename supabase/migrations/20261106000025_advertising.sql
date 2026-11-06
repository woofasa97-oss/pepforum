-- ============================================================================
-- 0025 · Advertising: prepaid, reviewed, reserved-then-charged
--
-- Ported from the pepforum-ca prototype build (src/modules/advertising.ts,
-- src/lib/payments.ts, migrations 004/006/008/011/015/019) onto the Supabase
-- model. The money rules are the prototype's; the mechanics follow ADR-0001
-- and ADR-0002 (an append-only ledger is the only source of truth).
--
--   Money  · Integer microCAD (1 CAD = 1,000,000). Credits are recorded by an
--            admin against an external payment (invoice, e-transfer, hosted
--            crypto checkout — the provider adapter is deliberately outside
--            the database). Nothing here ever contacts a payment provider.
--          · `ad_ledger` is append-only; `advertisers.balance_microcad` is a
--            cached sum maintained by trigger and can never go negative.
--          · Submitting a campaign reserves its whole budget from available
--            credit (balance − reserved). Each settled day charges
--            impressions × CPM ÷ 1000 against the reservation; whatever is
--            left when the flight ends returns to available credit.
--   Review · An advertiser organisation is approved by an admin before it can
--            book. Every campaign (copy, landing page, optional image) is
--            reviewed by an admin before it runs; every decision is in the
--            moderation log and notifies the owner. Landing pages that match
--            the sourcing shield are rejected outright — "no vendors, no
--            sales" applies to ads too (docs/ADMIN.md "Ads").
--   Serving· get_ad() picks one running campaign for a slot and records a
--            delivery; a visitor is counted once per campaign per hour, and a
--            campaign is never charged more than its budget. Clicks go
--            through /ads/go/<id> so landing URLs are never rendered raw.
--   Worker · settle_ads() (service_role) charges finished days, completes
--            ended flights and releases reservations; idempotent per day.
--
-- Members can report an ad; admins resolve reports and can suspend a campaign
-- or an advertiser at any time. See docs/ADMIN.md ("Ads") and ADR-0007.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Vocabulary
-- ---------------------------------------------------------------------------
alter table public.mod_actions drop constraint mod_actions_action_check;
alter table public.mod_actions add constraint mod_actions_action_check check (action in (
  'remove', 'restore', 'auto_collapse', 'auto_uncollapse', 'dismiss_reports',
  'sanction', 'revoke_sanction', 'grant_founding_rater', 'appoint_moderator',
  'remove_moderator', 'appeal_upheld', 'appeal_denied', 'config_change',
  'grant_admin', 'revoke_admin', 'end_founding_rater', 'rename_user', 'revoke_strike', 'clear_writing_lock',
  'hide_note', 'unhide_note', 'pin', 'unpin', 'lock_comments', 'unlock_comments',
  'shield_rule_added', 'shield_rule_removed', 'shield_hold', 'taxonomy_change',
  'lookup_email', 'reveal_email',
  'link_hold', 'link_approved', 'link_declined', 'site_approved', 'site_unapproved',
  'member_reports_actioned', 'member_reports_dismissed',
  'redirect_set', 'redirect_removed',
  'media_removed',
  'clinician_approved', 'clinician_rejected', 'clinician_revoked',
  'advertiser_approved', 'advertiser_suspended', 'ad_approved', 'ad_rejected', 'ad_suspended',
  'ad_payment_recorded', 'ad_adjustment', 'ad_report_resolved'));

alter table public.mod_actions drop constraint mod_actions_target_kind_check;
alter table public.mod_actions add constraint mod_actions_target_kind_check check (target_kind in (
  'post', 'comment', 'user', 'config', 'appeal', 'sanction', 'note', 'strike', 'shield', 'taxonomy', 'redirect', 'media',
  'advertiser', 'campaign', 'ad_report'));

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'reply_post', 'reply_comment', 'note_outcome', 'note_on_post', 'mod_action', 'team_reply', 'clinician_review', 'ad_review'));

alter table public.media drop constraint media_kind_check;
alter table public.media add constraint media_kind_check check (kind in ('post_image', 'credential', 'ad_image'));

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.advertisers (
  id                uuid        primary key default gen_random_uuid(),
  owner_id          uuid        not null unique references public.profiles (id),
  name              text        not null check (char_length(name) between 2 and 80),
  website           text        not null check (website ~ '^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(/\S*)?$' and char_length(website) <= 500),
  billing_email     text        not null check (billing_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(billing_email) <= 254),
  billing_address   text        not null default '' check (char_length(billing_address) <= 300),
  billing_province  text        not null check (billing_province in ('AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT')),
  status            text        not null default 'pending' check (status in ('pending', 'active', 'suspended')),
  -- Cached from ad_ledger by trigger; never written directly.
  balance_microcad  bigint      not null default 0 check (balance_microcad >= 0),
  -- Sum of reservations on campaigns in review/approved/active/paused.
  reserved_microcad bigint      not null default 0 check (reserved_microcad >= 0),
  review_note       text        not null default '',
  reviewed_by       uuid        references public.profiles (id),
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (reserved_microcad <= balance_microcad)
);
create trigger advertisers_touch before update on public.advertisers
  for each row execute function private.touch_updated_at();

create table public.ad_campaigns (
  id                 uuid        primary key default gen_random_uuid(),
  advertiser_id      uuid        not null references public.advertisers (id),
  name               text        not null check (char_length(name) between 2 and 80),
  package            text        not null check (package in ('zone', 'category', 'national')),
  zone_id            text        references public.zones (id),
  category_id        text        references public.categories (id),
  budget_microcad    bigint      not null check (budget_microcad > 0),
  cpm_microcad       bigint      not null default 0 check (cpm_microcad >= 0),
  reserved_microcad  bigint      not null default 0 check (reserved_microcad >= 0),
  spent_microcad     bigint      not null default 0 check (spent_microcad >= 0),
  status             text        not null default 'draft'
                       check (status in ('draft', 'review', 'approved', 'active', 'paused', 'rejected', 'completed', 'suspended')),
  -- The creative. One per campaign; editing a rejected campaign returns it to draft.
  headline           text        not null check (char_length(headline) between 3 and 60),
  body               text        not null check (char_length(body) between 10 and 160),
  cta                text        not null check (char_length(cta) between 2 and 24),
  headline_fr        text        not null default '' check (char_length(headline_fr) <= 60),
  body_fr            text        not null default '' check (char_length(body_fr) <= 160),
  cta_fr             text        not null default '' check (char_length(cta_fr) <= 24),
  landing_url        text        not null check (landing_url ~ '^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(/\S*)?$' and char_length(landing_url) <= 1000),
  image_id           uuid        references public.media (id),
  starts_on          date,
  ends_on            date,
  review_note        text        not null default '',
  reviewed_by        uuid        references public.profiles (id),
  reviewed_at        timestamptz,
  submitted_at       timestamptz,
  impressions        bigint      not null default 0,
  clicks             bigint      not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (spent_microcad + reserved_microcad <= budget_microcad),
  check ((package = 'zone'     and zone_id is not null and category_id is null)
      or (package = 'category' and zone_id is null and category_id is not null)
      or (package = 'national' and zone_id is null and category_id is null)),
  check (status not in ('active', 'paused', 'completed') or (starts_on is not null and ends_on is not null))
);
create index ad_campaigns_advertiser on public.ad_campaigns (advertiser_id, created_at desc);
create index ad_campaigns_serving    on public.ad_campaigns (status, package, zone_id, category_id) where status = 'active';
create trigger ad_campaigns_touch before update on public.ad_campaigns
  for each row execute function private.touch_updated_at();

create table public.ad_ledger (
  id              bigint      generated always as identity primary key,
  advertiser_id   uuid        not null references public.advertisers (id),
  kind            text        not null check (kind in ('payment', 'charge', 'refund', 'adjustment')),
  -- Positive = credit to the advertiser, negative = debit.
  amount_microcad bigint      not null check (amount_microcad <> 0),
  campaign_id     uuid        references public.ad_campaigns (id),
  -- Idempotency: an external payment reference, or charge:<campaign>:<day>.
  reference       text        not null unique check (char_length(reference) between 3 and 120),
  note            text        not null default '' check (char_length(note) <= 500),
  actor_id        uuid        references public.profiles (id),
  created_at      timestamptz not null default now()
);
create index ad_ledger_advertiser on public.ad_ledger (advertiser_id, id desc);
create trigger ad_ledger_append_only
  before update or delete on public.ad_ledger
  for each row execute function private.forbid_mutation();

create table public.ad_daily_stats (
  campaign_id      uuid    not null references public.ad_campaigns (id),
  day              date    not null,
  impressions      integer not null default 0,
  clicks           integer not null default 0,
  charged_microcad bigint  not null default 0,
  settled_at       timestamptz,
  primary key (campaign_id, day)
);

-- A visitor counts once per campaign per hour. Rows are purged after two days.
create table public.ad_deliveries (
  campaign_id  uuid        not null references public.ad_campaigns (id),
  visitor_hash text        not null check (char_length(visitor_hash) between 8 and 128),
  hour_bucket  timestamptz not null,
  primary key (campaign_id, visitor_hash, hour_bucket)
);
create index ad_deliveries_age on public.ad_deliveries (hour_bucket);

create table public.ad_reports (
  id          uuid        primary key default gen_random_uuid(),
  campaign_id uuid        not null references public.ad_campaigns (id),
  reporter_id uuid        not null references public.profiles (id),
  reason      text        not null check (reason in ('vendor', 'medical_claim', 'misleading', 'offensive', 'other')),
  details     text        not null default '' check (char_length(details) <= 500),
  status      text        not null default 'open' check (status in ('open', 'resolved')),
  resolution  text        not null default '',
  resolved_by uuid        references public.profiles (id),
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (campaign_id, reporter_id)
);
create index ad_reports_open on public.ad_reports (created_at) where status = 'open';

-- Read through the RPCs below; nobody gets table access.
alter table public.advertisers    enable row level security;
alter table public.ad_campaigns   enable row level security;
alter table public.ad_ledger      enable row level security;
alter table public.ad_daily_stats enable row level security;
alter table public.ad_deliveries  enable row level security;
alter table public.ad_reports     enable row level security;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
insert into public.app_config (key, value, is_public, description) values
  ('ads.enabled',               'false',      true,  'Serve approved campaigns on the site. Off hides every ad slot.'),
  ('ads.cpm.zone',              '14000000',   true,  'CPM for a regional-zone package, in microCAD (14000000 = CAD 14).'),
  ('ads.cpm.category',          '22000000',   true,  'CPM for a category package, in microCAD.'),
  ('ads.cpm.national',          '18000000',   true,  'CPM for the national package, in microCAD.'),
  ('ads.min_booking_microcad',  '2000000000', true,  'Smallest campaign budget, in microCAD (2000000000 = CAD 2,000).'),
  ('ads.flight_days',           '30',         true,  'How many days an approved campaign runs.'),
  ('rate_limit.ad_write',       '{"limit": 60, "window_seconds": 3600}',  false, 'Advertiser changes (organisation, campaigns) per member per hour.'),
  ('rate_limit.ad_report',      '{"limit": 10, "window_seconds": 86400}', false, 'Ad reports one member can file per day.');
update public.app_config c set bounds = b.bounds
  from (values ('ads.cpm.zone', '{"min": 0, "max": 1000000000}'::jsonb),
               ('ads.cpm.category', '{"min": 0, "max": 1000000000}'::jsonb),
               ('ads.cpm.national', '{"min": 0, "max": 1000000000}'::jsonb),
               ('ads.min_booking_microcad', '{"min": 1000000, "max": 1000000000000}'::jsonb),
               ('ads.flight_days', '{"min": 1, "max": 365}'::jsonb)) as b (key, bounds)
 where c.key = b.key;

-- ---------------------------------------------------------------------------
-- Ledger → balance (the only way a balance changes)
-- ---------------------------------------------------------------------------
create function private.apply_ad_ledger_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.advertisers
     set balance_microcad = balance_microcad + new.amount_microcad
   where id = new.advertiser_id;
  return new;
end;
$$;
create trigger ad_ledger_apply after insert on public.ad_ledger
  for each row execute function private.apply_ad_ledger_entry();

-- Credit not tied up in a campaign.
create function private.ad_available(p_advertiser uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select a.balance_microcad - a.reserved_microcad from public.advertisers a where a.id = p_advertiser;
$$;

create function private.ad_french_required(p_package text, p_zone text)
returns boolean
language sql
immutable
set search_path = ''
as $$ select p_package <> 'zone' or p_zone = 'qc' $$;

-- The caller's advertiser organisation, locked for update; PF404 if none.
create function private.my_advertiser_for_update(p_user uuid)
returns public.advertisers
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.advertisers;
begin
  select * into a from public.advertisers x where x.owner_id = p_user for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'advertiser');
  end if;
  return a;
end;
$$;

-- Team notifications include advertising decisions (from …024).
create or replace function private.notification_wanted(p_user uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_kind
           when 'reply_post'       then coalesce(s.replies, true)
           when 'reply_comment'    then coalesce(s.replies, true)
           when 'note_outcome'     then coalesce(s.notes, true)
           when 'note_on_post'     then coalesce(s.notes, true)
           when 'mod_action'       then coalesce(s.moderation, true)
           when 'team_reply'       then coalesce(s.team, true)
           when 'clinician_review' then coalesce(s.team, true)   -- …024
           when 'ad_review'        then coalesce(s.team, true)   -- …025
           else false
         end
  from (select 1) x
  left join public.notification_settings s on s.user_id = p_user;
$$;

-- ---------------------------------------------------------------------------
-- Public: the rate card
-- ---------------------------------------------------------------------------
create function public.ad_rate_card()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'enabled',      private.cfg_bool('ads.enabled'),
    'cpm',          jsonb_build_object('zone', private.cfg_int('ads.cpm.zone')::bigint,
                                       'category', private.cfg_int('ads.cpm.category')::bigint,
                                       'national', private.cfg_int('ads.cpm.national')::bigint),
    'min_booking',  (private.cfg('ads.min_booking_microcad') #>> '{}')::bigint,
    'flight_days',  private.cfg_int('ads.flight_days'));
$$;
grant execute on function public.ad_rate_card() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Advertisers: organisation
-- ---------------------------------------------------------------------------
create function public.create_advertiser(
  p_name text, p_website text, p_billing_email text, p_billing_address text, p_billing_province text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_user();
  v_name text := btrim(coalesce(p_name, ''));
  v_id   uuid;
begin
  perform private.require_capability(v_uid, 'report');
  perform private.enforce_rate_limit(v_uid, 'ad_write');
  if char_length(v_name) not between 2 and 80 then
    perform private.raise_error('PF422', 'invalid_name');
  end if;
  if coalesce(p_website, '') !~ '^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(/\S*)?$' or char_length(p_website) > 500 then
    perform private.raise_error('PF422', 'invalid_url');
  end if;
  if exists (select 1 from private.shield_matches(p_website) m where m.action = 'block') then
    perform private.raise_error('PF422', 'blocked_by_shield');
  end if;
  if coalesce(p_billing_email, '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform private.raise_error('PF422', 'invalid_email');
  end if;
  if p_billing_province is null or p_billing_province not in ('AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT') then
    perform private.raise_error('PF422', 'invalid_province');
  end if;
  if exists (select 1 from public.advertisers a where a.owner_id = v_uid) then
    perform private.raise_error('PF409', 'already_advertiser');
  end if;

  insert into public.advertisers (owner_id, name, website, billing_email, billing_address, billing_province)
  values (v_uid, v_name, p_website, lower(btrim(p_billing_email)), left(btrim(coalesce(p_billing_address, '')), 300), p_billing_province)
  returning id into v_id;
  return v_id;
end;
$$;

-- Everything the advertiser workspace shows. Null when the caller has no organisation.
create function public.my_advertiser()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  a     public.advertisers;
begin
  select * into a from public.advertisers x where x.owner_id = v_uid;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'id', a.id, 'name', a.name, 'website', a.website, 'billing_email', a.billing_email,
    'billing_address', a.billing_address, 'billing_province', a.billing_province,
    'status', a.status, 'review_note', a.review_note, 'created_at', a.created_at,
    'balance', a.balance_microcad, 'reserved', a.reserved_microcad, 'available', a.balance_microcad - a.reserved_microcad,
    'campaigns', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'name', c.name, 'package', c.package, 'zone_id', c.zone_id, 'category_id', c.category_id,
               'budget', c.budget_microcad, 'cpm', c.cpm_microcad, 'reserved', c.reserved_microcad, 'spent', c.spent_microcad,
               'status', c.status, 'headline', c.headline, 'body', c.body, 'cta', c.cta,
               'headline_fr', c.headline_fr, 'body_fr', c.body_fr, 'cta_fr', c.cta_fr,
               'landing_url', c.landing_url, 'image_id', c.image_id,
               'starts_on', c.starts_on, 'ends_on', c.ends_on, 'review_note', c.review_note, 'reviewed_at', c.reviewed_at,
               'submitted_at', c.submitted_at, 'impressions', c.impressions, 'clicks', c.clicks,
               'created_at', c.created_at, 'updated_at', c.updated_at,
               'days', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'impressions', d.impressions, 'clicks', d.clicks,
                                                                      'charged', d.charged_microcad, 'settled', d.settled_at is not null)
                                                   order by d.day desc)
                                 from (select * from public.ad_daily_stats s where s.campaign_id = c.id order by s.day desc limit 60) d), '[]'::jsonb))
             order by c.created_at desc)
      from public.ad_campaigns c where c.advertiser_id = a.id), '[]'::jsonb),
    'ledger', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'kind', l.kind, 'amount', l.amount_microcad, 'campaign_id', l.campaign_id,
                                          'reference', l.reference, 'note', l.note, 'created_at', l.created_at)
                       order by l.id desc)
      from (select * from public.ad_ledger x where x.advertiser_id = a.id order by x.id desc limit 100) l), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.create_advertiser(text, text, text, text, text) to authenticated;
grant execute on function public.my_advertiser()                                  to authenticated;

-- ---------------------------------------------------------------------------
-- Advertisers: campaigns
-- ---------------------------------------------------------------------------
-- Create (p_id null) or edit a draft/rejected campaign. Editing a rejected
-- campaign returns it to draft; nothing else is editable.
create function public.upsert_campaign(
  p_id uuid, p_name text, p_package text, p_zone text, p_category text, p_budget_microcad bigint,
  p_headline text, p_body text, p_cta text, p_headline_fr text, p_body_fr text, p_cta_fr text,
  p_landing_url text, p_image_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_user();
  a        public.advertisers;
  c        public.ad_campaigns;
  v_zone   text := nullif(btrim(coalesce(p_zone, '')), '');
  v_cat    text := nullif(btrim(coalesce(p_category, '')), '');
  v_french boolean;
  v_id     uuid;
begin
  perform private.require_capability(v_uid, 'report');
  perform private.enforce_rate_limit(v_uid, 'ad_write');
  a := private.my_advertiser_for_update(v_uid);
  if a.status = 'suspended' then
    perform private.raise_error('PF403', 'advertiser_suspended');
  end if;

  if p_package not in ('zone', 'category', 'national') then
    perform private.raise_error('PF422', 'invalid_package');
  end if;
  if p_package = 'zone' then
    v_cat := null;
    if v_zone is null or v_zone = 'national' or not exists (select 1 from public.zones z where z.id = v_zone) then
      perform private.raise_error('PF422', 'invalid_zone');
    end if;
  elsif p_package = 'category' then
    v_zone := null;
    if v_cat is null or not exists (select 1 from public.categories x where x.id = v_cat and x.archived_at is null) then
      perform private.raise_error('PF422', 'invalid_category');
    end if;
  else
    v_zone := null; v_cat := null;
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 2 and 80 then
    perform private.raise_error('PF422', 'invalid_name');
  end if;
  if p_budget_microcad is null or p_budget_microcad < (private.cfg('ads.min_booking_microcad') #>> '{}')::bigint
     or p_budget_microcad > 1000000000000 then
    perform private.raise_error('PF422', 'budget_below_minimum');
  end if;
  if char_length(btrim(coalesce(p_headline, ''))) not between 3 and 60
     or char_length(btrim(coalesce(p_body, ''))) not between 10 and 160
     or char_length(btrim(coalesce(p_cta, ''))) not between 2 and 24 then
    perform private.raise_error('PF422', 'invalid_creative');
  end if;
  v_french := private.ad_french_required(p_package, v_zone);
  if v_french and (char_length(btrim(coalesce(p_headline_fr, ''))) not between 3 and 60
                   or char_length(btrim(coalesce(p_body_fr, ''))) not between 10 and 160
                   or char_length(btrim(coalesce(p_cta_fr, ''))) not between 2 and 24) then
    perform private.raise_error('PF422', 'french_required');
  end if;
  if char_length(coalesce(p_headline_fr, '')) > 60 or char_length(coalesce(p_body_fr, '')) > 160 or char_length(coalesce(p_cta_fr, '')) > 24 then
    perform private.raise_error('PF422', 'invalid_creative');
  end if;
  if coalesce(p_landing_url, '') !~ '^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(/\S*)?$' or char_length(p_landing_url) > 1000 then
    perform private.raise_error('PF422', 'invalid_url');
  end if;
  -- No vendors, no sales: a landing page on a blocked domain is refused here, not in review.
  if exists (select 1 from private.shield_matches(p_landing_url) m where m.action = 'block')
     or exists (select 1 from private.shield_matches(p_headline || ' ' || p_body || ' ' || coalesce(p_headline_fr, '') || ' ' || coalesce(p_body_fr, '')) m where m.action = 'block') then
    perform private.raise_error('PF422', 'blocked_by_shield');
  end if;
  if p_image_id is not null and not exists (
       select 1 from public.media m where m.id = p_image_id and m.owner_id = v_uid and m.kind = 'ad_image' and m.status = 'ready') then
    perform private.raise_error('PF404', 'not_found', 'image');
  end if;

  if p_id is null then
    insert into public.ad_campaigns (advertiser_id, name, package, zone_id, category_id, budget_microcad,
                                     headline, body, cta, headline_fr, body_fr, cta_fr, landing_url, image_id)
    values (a.id, btrim(p_name), p_package, v_zone, v_cat, p_budget_microcad,
            btrim(p_headline), btrim(p_body), btrim(p_cta), btrim(coalesce(p_headline_fr, '')), btrim(coalesce(p_body_fr, '')), btrim(coalesce(p_cta_fr, '')),
            p_landing_url, p_image_id)
    returning id into v_id;
    return v_id;
  end if;

  select * into c from public.ad_campaigns x where x.id = p_id and x.advertiser_id = a.id for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'campaign');
  end if;
  if c.status not in ('draft', 'rejected') then
    perform private.raise_error('PF409', 'campaign_locked');
  end if;
  update public.ad_campaigns
     set name = btrim(p_name), package = p_package, zone_id = v_zone, category_id = v_cat, budget_microcad = p_budget_microcad,
         headline = btrim(p_headline), body = btrim(p_body), cta = btrim(p_cta),
         headline_fr = btrim(coalesce(p_headline_fr, '')), body_fr = btrim(coalesce(p_body_fr, '')), cta_fr = btrim(coalesce(p_cta_fr, '')),
         landing_url = p_landing_url, image_id = p_image_id,
         status = 'draft', review_note = '', reviewed_by = null, reviewed_at = null
   where id = c.id;
  return c.id;
end;
$$;

-- Reserve the budget from available credit and send the campaign to review.
create function public.submit_campaign(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  a     public.advertisers;
  c     public.ad_campaigns;
begin
  perform private.require_capability(v_uid, 'report');
  perform private.enforce_rate_limit(v_uid, 'ad_write');
  a := private.my_advertiser_for_update(v_uid);
  if a.status <> 'active' then
    perform private.raise_error('PF403', 'advertiser_not_approved');
  end if;
  select * into c from public.ad_campaigns x where x.id = p_id and x.advertiser_id = a.id for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'campaign');
  end if;
  if c.status not in ('draft', 'rejected') then
    perform private.raise_error('PF409', 'campaign_locked');
  end if;
  if a.balance_microcad - a.reserved_microcad < c.budget_microcad then
    perform private.raise_error('PF422', 'insufficient_credit', (c.budget_microcad - (a.balance_microcad - a.reserved_microcad))::text);
  end if;

  update public.advertisers set reserved_microcad = reserved_microcad + c.budget_microcad where id = a.id;
  update public.ad_campaigns
     set status = 'review', reserved_microcad = budget_microcad, submitted_at = now(),
         cpm_microcad = case package when 'zone' then private.cfg_int('ads.cpm.zone')
                                     when 'category' then private.cfg_int('ads.cpm.category')
                                     else private.cfg_int('ads.cpm.national') end,
         review_note = '', reviewed_by = null, reviewed_at = null
   where id = c.id;
end;
$$;

-- Owners pause and resume a running campaign (days paused still count towards the flight).
create function public.set_campaign_paused(p_id uuid, p_paused boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  a     public.advertisers;
  c     public.ad_campaigns;
begin
  perform private.enforce_rate_limit(v_uid, 'ad_write');
  a := private.my_advertiser_for_update(v_uid);
  select * into c from public.ad_campaigns x where x.id = p_id and x.advertiser_id = a.id for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'campaign');
  end if;
  if coalesce(p_paused, false) and c.status = 'active' then
    update public.ad_campaigns set status = 'paused' where id = c.id;
  elsif not coalesce(p_paused, false) and c.status = 'paused' then
    update public.ad_campaigns set status = 'active' where id = c.id;
  else
    perform private.raise_error('PF409', 'campaign_locked');
  end if;
end;
$$;

-- Withdraw a campaign in review (releases the reservation) or discard a draft.
create function public.withdraw_campaign(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  a     public.advertisers;
  c     public.ad_campaigns;
begin
  perform private.enforce_rate_limit(v_uid, 'ad_write');
  a := private.my_advertiser_for_update(v_uid);
  select * into c from public.ad_campaigns x where x.id = p_id and x.advertiser_id = a.id for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'campaign');
  end if;
  if c.status not in ('draft', 'review', 'rejected') then
    perform private.raise_error('PF409', 'campaign_locked');
  end if;
  update public.advertisers set reserved_microcad = reserved_microcad - c.reserved_microcad where id = a.id;
  delete from public.ad_daily_stats where campaign_id = c.id;
  delete from public.ad_reports     where campaign_id = c.id;
  delete from public.ad_campaigns   where id = c.id;
end;
$$;

grant execute on function public.upsert_campaign(uuid, text, text, text, text, bigint, text, text, text, text, text, text, text, uuid) to authenticated;
grant execute on function public.submit_campaign(uuid)              to authenticated;
grant execute on function public.set_campaign_paused(uuid, boolean) to authenticated;
grant execute on function public.withdraw_campaign(uuid)            to authenticated;

-- ---------------------------------------------------------------------------
-- Serving
-- ---------------------------------------------------------------------------
-- One running campaign for a slot, or null. Records the delivery (once per
-- visitor per campaign per hour) so settlement can charge it. p_visitor is an
-- opaque hash the web app derives from the request; it is never stored with
-- anything identifying.
create function public.get_ad(p_package text, p_target text, p_visitor text, p_locale text default 'en')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c        public.ad_campaigns;
  v_hour   timestamptz := date_trunc('hour', now());
  v_counts boolean;
begin
  if not private.cfg_bool('ads.enabled') then
    return null;
  end if;
  select x.* into c
  from public.ad_campaigns x
  join public.advertisers a on a.id = x.advertiser_id and a.status = 'active'
  where x.status = 'active'
    and current_date between x.starts_on and x.ends_on
    and x.spent_microcad < x.budget_microcad
    and ((p_package = 'national' and x.package = 'national')
      or (p_package = 'zone' and x.package = 'zone' and x.zone_id = p_target)
      or (p_package = 'category' and x.package = 'category' and x.category_id = p_target))
    -- Today's unsettled impressions must still fit in the budget.
    and coalesce((select s.impressions from public.ad_daily_stats s where s.campaign_id = x.id and s.day = current_date), 0) * x.cpm_microcad / 1000
        < x.budget_microcad - x.spent_microcad
  order by random()
  limit 1;
  if not found then
    return null;
  end if;

  if coalesce(p_visitor, '') ~ '^[A-Za-z0-9_-]{8,128}$' then
    insert into public.ad_deliveries (campaign_id, visitor_hash, hour_bucket)
    values (c.id, p_visitor, v_hour)
    on conflict do nothing;
    v_counts := found;
    if v_counts then
      insert into public.ad_daily_stats (campaign_id, day, impressions) values (c.id, current_date, 1)
      on conflict (campaign_id, day) do update set impressions = public.ad_daily_stats.impressions + 1;
      update public.ad_campaigns set impressions = impressions + 1 where id = c.id;
    end if;
  end if;

  return jsonb_build_object(
    'id', c.id,
    'advertiser', (select a.name from public.advertisers a where a.id = c.advertiser_id),
    'headline', case when p_locale = 'fr' and c.headline_fr <> '' then c.headline_fr else c.headline end,
    'body',     case when p_locale = 'fr' and c.body_fr <> '' then c.body_fr else c.body end,
    'cta',      case when p_locale = 'fr' and c.cta_fr <> '' then c.cta_fr else c.cta end,
    'image_id', c.image_id);
end;
$$;

-- The landing page of a running campaign, for /ads/go/<id>; counts the click. Null when not servable.
create function public.ad_click(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.ad_campaigns;
begin
  select * into c from public.ad_campaigns x where x.id = p_id and x.status in ('active', 'paused', 'completed');
  if not found then
    return null;
  end if;
  if c.status = 'active' then
    insert into public.ad_daily_stats (campaign_id, day, clicks) values (c.id, current_date, 1)
    on conflict (campaign_id, day) do update set clicks = public.ad_daily_stats.clicks + 1;
    update public.ad_campaigns set clicks = clicks + 1 where id = c.id;
  end if;
  return c.landing_url;
end;
$$;

-- Members report an ad; the team reviews it.
create function public.report_ad(p_id uuid, p_reason text, p_details text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_capability(v_uid, 'report');
  perform private.enforce_rate_limit(v_uid, 'ad_report');
  if p_reason not in ('vendor', 'medical_claim', 'misleading', 'offensive', 'other') then
    perform private.raise_error('PF422', 'invalid_reason');
  end if;
  if not exists (select 1 from public.ad_campaigns c where c.id = p_id and c.status in ('active', 'paused', 'completed')) then
    perform private.raise_error('PF404', 'not_found', 'campaign');
  end if;
  insert into public.ad_reports (campaign_id, reporter_id, reason, details)
  values (p_id, v_uid, p_reason, left(btrim(coalesce(p_details, '')), 500))
  on conflict (campaign_id, reporter_id) do nothing;
  if not found then
    perform private.raise_error('PF409', 'already_reported');
  end if;
end;
$$;

grant execute on function public.get_ad(text, text, text, text) to anon, authenticated;
grant execute on function public.ad_click(uuid)                 to anon, authenticated;
grant execute on function public.report_ad(uuid, text, text)    to authenticated;

-- ---------------------------------------------------------------------------
-- Admins
-- ---------------------------------------------------------------------------
create function public.admin_ads()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_admin(v_uid);
  return jsonb_build_object(
    'rate_card', public.ad_rate_card(),
    'advertisers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'name', a.name, 'website', a.website, 'billing_email', a.billing_email,
               'billing_province', a.billing_province, 'status', a.status, 'review_note', a.review_note,
               'owner', p.username, 'owner_tier', p.tier, 'created_at', a.created_at,
               'balance', a.balance_microcad, 'reserved', a.reserved_microcad,
               'campaigns', (select count(*) from public.ad_campaigns c where c.advertiser_id = a.id),
               'in_review', (select count(*) from public.ad_campaigns c where c.advertiser_id = a.id and c.status = 'review'))
             order by case a.status when 'pending' then 0 when 'active' then 1 else 2 end, a.created_at)
      from public.advertisers a join public.profiles p on p.id = a.owner_id), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'advertiser_id', c.advertiser_id, 'advertiser', a.name, 'owner', p.username,
               'name', c.name, 'package', c.package, 'zone_id', c.zone_id, 'category_id', c.category_id,
               'budget', c.budget_microcad, 'cpm', c.cpm_microcad, 'spent', c.spent_microcad, 'reserved', c.reserved_microcad,
               'status', c.status, 'headline', c.headline, 'body', c.body, 'cta', c.cta,
               'headline_fr', c.headline_fr, 'body_fr', c.body_fr, 'cta_fr', c.cta_fr,
               'landing_url', c.landing_url, 'image_id', c.image_id,
               'starts_on', c.starts_on, 'ends_on', c.ends_on, 'submitted_at', c.submitted_at,
               'review_note', c.review_note, 'reviewed_by', (select r.username from public.profiles r where r.id = c.reviewed_by),
               'impressions', c.impressions, 'clicks', c.clicks,
               'open_reports', (select count(*) from public.ad_reports r where r.campaign_id = c.id and r.status = 'open'))
             order by case c.status when 'review' then 0 when 'active' then 1 when 'paused' then 2 else 3 end, c.submitted_at, c.created_at desc)
      from public.ad_campaigns c
      join public.advertisers a on a.id = c.advertiser_id
      join public.profiles p on p.id = a.owner_id
      where c.status <> 'draft'), '[]'::jsonb),
    'reports', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'campaign_id', r.campaign_id, 'campaign', c.name, 'advertiser', a.name,
                                          'reason', r.reason, 'details', r.details, 'reporter', p.username, 'created_at', r.created_at)
                       order by r.created_at)
      from public.ad_reports r
      join public.ad_campaigns c on c.id = r.campaign_id
      join public.advertisers a on a.id = c.advertiser_id
      join public.profiles p on p.id = r.reporter_id
      where r.status = 'open'), '[]'::jsonb),
    'ledger', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'advertiser', a.name, 'kind', l.kind, 'amount', l.amount_microcad,
                                          'reference', l.reference, 'note', l.note, 'by', (select x.username from public.profiles x where x.id = l.actor_id),
                                          'created_at', l.created_at)
                       order by l.id desc)
      from (select * from public.ad_ledger order by id desc limit 100) l
      join public.advertisers a on a.id = l.advertiser_id), '[]'::jsonb),
    'totals', jsonb_build_object(
      'balance',  (select coalesce(sum(a.balance_microcad), 0) from public.advertisers a),
      'reserved', (select coalesce(sum(a.reserved_microcad), 0) from public.advertisers a),
      'charged_30d', (select coalesce(-sum(l.amount_microcad), 0) from public.ad_ledger l where l.kind = 'charge' and l.created_at > now() - interval '30 days'),
      'pending_advertisers', (select count(*) from public.advertisers a where a.status = 'pending'),
      'campaigns_in_review', (select count(*) from public.ad_campaigns c where c.status = 'review'),
      'open_reports', (select count(*) from public.ad_reports r where r.status = 'open'))
  );
end;
$$;

create function public.admin_review_advertiser(p_id uuid, p_decision text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  a     public.advertisers;
begin
  if p_decision not in ('approve', 'suspend') then
    perform private.raise_error('PF422', 'invalid_decision');
  end if;
  select * into a from public.advertisers x where x.id = p_id for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'advertiser');
  end if;
  if a.owner_id = v_uid then
    perform private.raise_error('PF403', 'conflict_of_interest');
  end if;
  update public.advertisers
     set status = case when p_decision = 'approve' then 'active' else 'suspended' end,
         review_note = btrim(p_reason), reviewed_by = v_uid, reviewed_at = now()
   where id = a.id;
  if p_decision = 'suspend' then
    update public.ad_campaigns set status = 'suspended' where advertiser_id = a.id and status in ('review', 'approved', 'active', 'paused');
  end if;
  perform private.log_mod_action(v_uid, case when p_decision = 'approve' then 'advertiser_approved' else 'advertiser_suspended' end,
                                 'advertiser', a.id, a.owner_id, null, p_reason, jsonb_build_object('name', a.name));
  perform private.notify(a.owner_id, 'ad_review', 'advertiser:' || a.id || ':' || p_decision || ':' || extract(epoch from now())::bigint,
                         null, null, null, null, null, null,
                         jsonb_build_object('action', case when p_decision = 'approve' then 'advertiser_approved' else 'advertiser_suspended' end, 'reason', btrim(p_reason)));
end;
$$;

-- Approve (starts today for `ads.flight_days`) or reject (releases the reservation).
create function public.admin_review_campaign(p_id uuid, p_decision text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  c     public.ad_campaigns;
  a     public.advertisers;
begin
  if p_decision not in ('approve', 'reject') then
    perform private.raise_error('PF422', 'invalid_decision');
  end if;
  select * into c from public.ad_campaigns x where x.id = p_id for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'campaign');
  end if;
  select * into a from public.advertisers x where x.id = c.advertiser_id for update;
  if a.owner_id = v_uid then
    perform private.raise_error('PF403', 'conflict_of_interest');
  end if;
  if c.status <> 'review' then
    perform private.raise_error('PF409', 'not_pending');
  end if;

  if p_decision = 'approve' then
    update public.ad_campaigns
       set status = 'active', starts_on = current_date, ends_on = current_date + (private.cfg_int('ads.flight_days') - 1),
           review_note = btrim(p_reason), reviewed_by = v_uid, reviewed_at = now()
     where id = c.id;
  else
    update public.advertisers set reserved_microcad = reserved_microcad - c.reserved_microcad where id = a.id;
    update public.ad_campaigns
       set status = 'rejected', reserved_microcad = 0, review_note = btrim(p_reason), reviewed_by = v_uid, reviewed_at = now()
     where id = c.id;
  end if;
  perform private.log_mod_action(v_uid, case when p_decision = 'approve' then 'ad_approved' else 'ad_rejected' end,
                                 'campaign', c.id, a.owner_id, c.zone_id, p_reason,
                                 jsonb_build_object('name', c.name, 'package', c.package, 'budget', c.budget_microcad));
  perform private.notify(a.owner_id, 'ad_review', 'campaign:' || c.id || ':' || p_decision || ':' || extract(epoch from now())::bigint,
                         null, null, null, null, null, null,
                         jsonb_build_object('action', case when p_decision = 'approve' then 'ad_approved' else 'ad_rejected' end,
                                            'reason', btrim(p_reason), 'campaign', c.name));
end;
$$;

-- Stop a running campaign (reports, policy). The unspent reservation is released.
create function public.admin_suspend_campaign(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  c     public.ad_campaigns;
  a     public.advertisers;
begin
  select * into c from public.ad_campaigns x where x.id = p_id for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'campaign');
  end if;
  if c.status not in ('review', 'approved', 'active', 'paused') then
    perform private.raise_error('PF409', 'campaign_locked');
  end if;
  select * into a from public.advertisers x where x.id = c.advertiser_id for update;
  update public.advertisers set reserved_microcad = reserved_microcad - c.reserved_microcad where id = a.id;
  update public.ad_campaigns
     set status = 'suspended', reserved_microcad = 0, review_note = btrim(p_reason), reviewed_by = v_uid, reviewed_at = now()
   where id = c.id;
  update public.ad_reports set status = 'resolved', resolution = 'suspended', resolved_by = v_uid, resolved_at = now()
   where campaign_id = c.id and status = 'open';
  perform private.log_mod_action(v_uid, 'ad_suspended', 'campaign', c.id, a.owner_id, c.zone_id, p_reason, jsonb_build_object('name', c.name));
  perform private.notify(a.owner_id, 'ad_review', 'campaign:' || c.id || ':suspended:' || extract(epoch from now())::bigint,
                         null, null, null, null, null, null,
                         jsonb_build_object('action', 'ad_suspended', 'reason', btrim(p_reason), 'campaign', c.name));
end;
$$;

-- Credit an advertiser for a payment received outside the site. The reference
-- (invoice or transaction id) makes it idempotent.
create function public.admin_record_ad_payment(p_advertiser uuid, p_amount_microcad bigint, p_reference text, p_reason text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  v_ref text := btrim(coalesce(p_reference, ''));
  v_id  bigint;
begin
  if p_amount_microcad is null or p_amount_microcad <= 0 or p_amount_microcad > 1000000000000 then
    perform private.raise_error('PF422', 'invalid_amount');
  end if;
  if char_length(v_ref) not between 3 and 120 then
    perform private.raise_error('PF422', 'reference_required');
  end if;
  if not exists (select 1 from public.advertisers a where a.id = p_advertiser) then
    perform private.raise_error('PF404', 'not_found', 'advertiser');
  end if;
  if exists (select 1 from public.ad_ledger l where l.reference = v_ref) then
    perform private.raise_error('PF409', 'duplicate_reference');
  end if;
  insert into public.ad_ledger (advertiser_id, kind, amount_microcad, reference, note, actor_id)
  values (p_advertiser, 'payment', p_amount_microcad, v_ref, btrim(p_reason), v_uid)
  returning id into v_id;
  perform private.log_mod_action(v_uid, 'ad_payment_recorded', 'advertiser', p_advertiser,
                                 (select a.owner_id from public.advertisers a where a.id = p_advertiser), null, p_reason,
                                 jsonb_build_object('amount', p_amount_microcad, 'reference', v_ref));
  return v_id;
end;
$$;

-- Refund or correct a balance. A debit can't take available credit below zero.
create function public.admin_ad_adjustment(p_advertiser uuid, p_amount_microcad bigint, p_reference text, p_reason text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  v_ref text := btrim(coalesce(p_reference, ''));
  a     public.advertisers;
  v_id  bigint;
begin
  if p_amount_microcad is null or p_amount_microcad = 0 or abs(p_amount_microcad) > 1000000000000 then
    perform private.raise_error('PF422', 'invalid_amount');
  end if;
  if char_length(v_ref) not between 3 and 120 then
    perform private.raise_error('PF422', 'reference_required');
  end if;
  select * into a from public.advertisers x where x.id = p_advertiser for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'advertiser');
  end if;
  if p_amount_microcad < 0 and a.balance_microcad - a.reserved_microcad + p_amount_microcad < 0 then
    perform private.raise_error('PF422', 'insufficient_credit');
  end if;
  if exists (select 1 from public.ad_ledger l where l.reference = v_ref) then
    perform private.raise_error('PF409', 'duplicate_reference');
  end if;
  insert into public.ad_ledger (advertiser_id, kind, amount_microcad, reference, note, actor_id)
  values (a.id, case when p_amount_microcad < 0 then 'refund' else 'adjustment' end, p_amount_microcad, v_ref, btrim(p_reason), v_uid)
  returning id into v_id;
  perform private.log_mod_action(v_uid, 'ad_adjustment', 'advertiser', a.id, a.owner_id, null, p_reason,
                                 jsonb_build_object('amount', p_amount_microcad, 'reference', v_ref));
  return v_id;
end;
$$;

create function public.admin_resolve_ad_report(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  r     public.ad_reports;
begin
  select * into r from public.ad_reports x where x.id = p_id for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'report');
  end if;
  if r.status <> 'open' then
    perform private.raise_error('PF409', 'not_pending');
  end if;
  update public.ad_reports set status = 'resolved', resolution = btrim(p_reason), resolved_by = v_uid, resolved_at = now() where id = r.id;
  perform private.log_mod_action(v_uid, 'ad_report_resolved', 'ad_report', r.id, null, null, p_reason, jsonb_build_object('campaign_id', r.campaign_id));
end;
$$;

grant execute on function public.admin_ads()                                              to authenticated;
grant execute on function public.admin_review_advertiser(uuid, text, text)                to authenticated;
grant execute on function public.admin_review_campaign(uuid, text, text)                  to authenticated;
grant execute on function public.admin_suspend_campaign(uuid, text)                       to authenticated;
grant execute on function public.admin_record_ad_payment(uuid, bigint, text, text)        to authenticated;
grant execute on function public.admin_ad_adjustment(uuid, bigint, text, text)            to authenticated;
grant execute on function public.admin_resolve_ad_report(uuid, text)                      to authenticated;

-- ---------------------------------------------------------------------------
-- Worker: daily settlement (service_role only)
-- ---------------------------------------------------------------------------
-- Charges every finished, unsettled day of every running/paused/ended
-- campaign (impressions × CPM ÷ 1000, capped at what the budget still
-- allows), completes campaigns past their end date, releases what is left of
-- their reservation, and purges old delivery rows. Safe to run any number of
-- times: a day is charged once (ledger reference charge:<campaign>:<day>).
create function public.settle_ads(p_until date default current_date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r          record;
  v_charge   bigint;
  v_days     integer := 0;
  v_charged  bigint := 0;
  v_done     integer := 0;
  v_purged   integer;
begin
  -- Days before p_until that haven't been settled.
  for r in
    select s.campaign_id, s.day, s.impressions, c.cpm_microcad, c.budget_microcad, c.spent_microcad, c.advertiser_id
    from public.ad_daily_stats s
    join public.ad_campaigns c on c.id = s.campaign_id
    where s.settled_at is null and s.day < p_until
      and c.status in ('active', 'paused', 'completed', 'suspended')
    order by s.day, s.campaign_id
    for update of s, c
  loop
    v_charge := least(r.impressions::bigint * r.cpm_microcad / 1000, r.budget_microcad - r.spent_microcad);
    if v_charge > 0 then
      insert into public.ad_ledger (advertiser_id, kind, amount_microcad, campaign_id, reference, note)
      values (r.advertiser_id, 'charge', -v_charge, r.campaign_id, 'charge:' || r.campaign_id || ':' || r.day,
              r.impressions || ' impressions × CPM')
      on conflict (reference) do nothing;
      if found then
        update public.ad_campaigns
           set spent_microcad = spent_microcad + v_charge, reserved_microcad = greatest(reserved_microcad - v_charge, 0)
         where id = r.campaign_id;
        update public.advertisers set reserved_microcad = greatest(reserved_microcad - v_charge, 0) where id = r.advertiser_id;
        v_charged := v_charged + v_charge;
      end if;
    end if;
    update public.ad_daily_stats set charged_microcad = v_charge, settled_at = now()
     where campaign_id = r.campaign_id and day = r.day;
    v_days := v_days + 1;
  end loop;

  -- Flights that ended: complete and release the rest of the reservation.
  for r in
    select c.id, c.advertiser_id, c.reserved_microcad
    from public.ad_campaigns c
    where c.status in ('active', 'paused') and c.ends_on < p_until
    for update
  loop
    update public.advertisers set reserved_microcad = greatest(reserved_microcad - r.reserved_microcad, 0) where id = r.advertiser_id;
    update public.ad_campaigns set status = 'completed', reserved_microcad = 0 where id = r.id;
    v_done := v_done + 1;
  end loop;

  delete from public.ad_deliveries where hour_bucket < now() - interval '2 days';
  get diagnostics v_purged = row_count;

  return jsonb_build_object('days_settled', v_days, 'charged_microcad', v_charged, 'completed', v_done, 'deliveries_purged', v_purged);
end;
$$;
grant execute on function public.settle_ads(date) to service_role;

-- ---------------------------------------------------------------------------
-- Recreated from earlier migrations (verbatim, plus the lines marked …025)
-- ---------------------------------------------------------------------------
-- Ad images: uploaded by advertisers, public once their campaign runs (from …023).
create or replace function private.media_visible(m public.media)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select m.status = 'ready' and (
    -- Your own uploads, always (a pending one too, so you can check it).
    coalesce(m.owner_id = auth.uid(), false)
    or (m.kind = 'post_image' and m.post_id is not null and exists (
          select 1 from public.posts p
          where p.id = m.post_id
            and (p.status in ('visible', 'collapsed')
                 or coalesce(p.author_id = auth.uid(), false)
                 or coalesce(private.is_zone_mod(auth.uid(), p.zone_id) and private.staff_session(), false))))
    or (m.kind = 'post_image' and coalesce(private.is_admin(auth.uid()) and private.staff_session(), false))
    or (m.kind = 'credential' and coalesce(private.is_admin(auth.uid()) and private.staff_session(), false))
    -- …025
    or (m.kind = 'ad_image' and (coalesce(private.is_admin(auth.uid()) and private.staff_session(), false)
                                 or exists (select 1 from public.ad_campaigns c where c.image_id = m.id and c.status in ('active', 'paused', 'completed'))))
  ) or (m.status = 'pending' and coalesce(m.owner_id = auth.uid(), false));
$$;

create or replace function public.register_upload(p_kind text, p_content_type text, p_bytes integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_user();
  v_id   uuid := gen_random_uuid();
  v_ext  text;
  v_path text;
begin
  if p_kind = 'post_image' then
    perform private.require_capability(v_uid, 'upload_image');
  elsif p_kind = 'credential' then
    perform private.require_capability(v_uid, 'report');
  elsif p_kind = 'ad_image' then   -- …025: advertisers only
    perform private.require_capability(v_uid, 'report');
    if not exists (select 1 from public.advertisers a where a.owner_id = v_uid and a.status <> 'suspended') then
      perform private.raise_error('PF404', 'not_found', 'advertiser');
    end if;
  else
    perform private.raise_error('PF422', 'invalid_kind');
  end if;
  perform private.enforce_rate_limit(v_uid, 'upload');

  v_ext := case p_content_type
             when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp'
             when 'application/pdf' then 'pdf' end;
  if v_ext is null or (p_content_type = 'application/pdf' and p_kind <> 'credential') then
    perform private.raise_error('PF422', 'unsupported_file_type');
  end if;
  if p_bytes is null or p_bytes <= 0 or p_bytes > private.cfg_int('uploads.max_bytes') then
    perform private.raise_error('PF422', 'file_too_large', private.cfg_int('uploads.max_bytes')::text);
  end if;

  v_path := p_kind || '/' || v_uid || '/' || v_id || '.' || v_ext;
  insert into public.media (id, owner_id, kind, object_path, content_type, bytes)
  values (v_id, v_uid, p_kind, v_path, p_content_type, p_bytes);
  return jsonb_build_object('id', v_id, 'bucket', 'media', 'path', v_path);
end;
$$;

-- Abandoned ad images are purged like post images (from …023).
create or replace function public.media_to_purge(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.media m
     set status = 'removed', removed_reason = 'abandoned'
   where m.status in ('pending', 'ready') and m.created_at < now() - interval '1 day'
     and ((m.kind = 'post_image' and m.post_id is null)
       or (m.kind = 'ad_image' and not exists (select 1 from public.ad_campaigns c where c.image_id = m.id)));   -- …025
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'bucket', m.bucket, 'path', m.object_path) order by m.created_at)
    from (select * from public.media x where x.status = 'removed' and x.purged_at is null
           order by x.created_at limit least(greatest(coalesce(p_limit, 100), 1), 1000)) m), '[]'::jsonb);
end;
$$;

-- A deleted account's advertiser is suspended; financial records are kept (from …024).
create or replace function private.tombstone_profile(p_user uuid, p_erase_content boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_adv uuid;
begin
  update public.profiles
     set username             = 'deleted_' || substr(md5(id::text), 1, 10),
         bio                  = '',
         coi                  = '',
         home_zone_id         = null,
         rater_status         = 'none',
         founding_until       = null,
         deleted_at           = coalesce(deleted_at, now())
   where id = p_user;

  delete from public.user_roles      where user_id = p_user;
  delete from public.zone_moderators where user_id = p_user;
  -- Tickets are private correspondence with the team: they go with the account (…020).
  delete from public.support_tickets  where member_id = p_user;
  -- So do notifications, preferences and push browsers (…022).
  delete from public.notifications         where user_id = p_user;
  delete from public.notification_settings where user_id = p_user;
  delete from public.push_subscriptions    where user_id = p_user;
  -- Registration numbers and credential documents go with the account (…024).
  delete from public.clinician_verifications where user_id = p_user;
  -- Advertising: campaigns stop, reservations are released, the ledger stays (…025).
  select a.id into v_adv from public.advertisers a where a.owner_id = p_user;
  if v_adv is not null then
    update public.ad_campaigns set status = 'suspended', reserved_microcad = 0
     where advertiser_id = v_adv and status in ('draft', 'review', 'approved', 'active', 'paused');
    update public.advertisers set status = 'suspended', reserved_microcad = 0, review_note = 'Account deleted' where id = v_adv;
  end if;
  -- Uploads are removed; the worker deletes the bytes (…023). Ad images on finished campaigns stay with the record.
  update public.media set status = 'removed', removed_reason = 'account_deleted', post_id = null
   where owner_id = p_user and status <> 'removed' and kind <> 'ad_image';

  if p_erase_content then
    update public.posts
       set status = 'deleted', status_changed_at = now(), title = '[deleted post]', body = '', link_url = null
     where author_id = p_user;
    update public.post_revisions r
       set title = '[deleted post]', body = '', link_url = null
      from public.posts p
     where p.id = r.post_id and p.author_id = p_user;
    update public.comments
       set status = 'deleted', status_changed_at = now(), body = '[deleted]'
     where author_id = p_user;
  end if;
end;
$$;

-- Your data export includes your advertiser account and its ledger (from …024).
create or replace function public.export_my_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.enforce_rate_limit(v_uid, 'export');
  return jsonb_build_object(
    'exported_at', now(),
    'account', (select jsonb_build_object('id', u.id, 'email', u.email, 'created_at', u.created_at,
                                          'email_confirmed_at', u.email_confirmed_at)
                from auth.users u where u.id = v_uid),
    'profile',        (select to_jsonb(p) from public.profiles p where p.id = v_uid),
    'posts',          coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at) from public.posts p where p.author_id = v_uid), '[]'),
    'comments',       coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at) from public.comments c where c.author_id = v_uid), '[]'),
    'post_votes',     coalesce((select jsonb_agg(to_jsonb(v)) from public.post_votes v where v.voter_id = v_uid), '[]'),
    'comment_votes',  coalesce((select jsonb_agg(to_jsonb(v)) from public.comment_votes v where v.voter_id = v_uid), '[]'),
    'notes',          coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at) from public.notes n where n.author_id = v_uid), '[]'),
    'note_ratings',   coalesce((select jsonb_agg(to_jsonb(r)) from public.note_ratings r where r.rater_id = v_uid), '[]'),
    'reports_filed',  coalesce((select jsonb_agg(to_jsonb(r)) from public.reports r where r.reporter_id = v_uid), '[]'),
    'member_reports_filed',
                      coalesce((select jsonb_agg(to_jsonb(r) - 'resolved_by' order by r.created_at)
                                from public.member_reports r where r.reporter_id = v_uid), '[]'),
    'support_tickets',
                      coalesce((select jsonb_agg((to_jsonb(t) - 'closed_by') || jsonb_build_object('messages', coalesce((
                                  select jsonb_agg(jsonb_build_object('body', m.body, 'from_team', m.from_staff, 'created_at', m.created_at)
                                                   order by m.created_at)
                                  from public.support_messages m where m.ticket_id = t.id), '[]'::jsonb))
                                  order by t.created_at)
                                from public.support_tickets t where t.member_id = v_uid), '[]'),
    -- …022: notifications never name a note writer or a moderator, so nothing to withhold.
    'notifications',  coalesce((select jsonb_agg(to_jsonb(n) - 'actor_id' order by n.created_at) from public.notifications n where n.user_id = v_uid), '[]'),
    'notification_settings', (select to_jsonb(s) from public.notification_settings s where s.user_id = v_uid),
    'push_subscriptions', coalesce((select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'user_agent', s.user_agent, 'created_at', s.created_at))
                                    from public.push_subscriptions s where s.user_id = v_uid), '[]'),
    -- …023 / …024: uploads and verification requests (reviewer withheld).
    'media',          coalesce((select jsonb_agg(to_jsonb(m) - 'removed_by' order by m.created_at) from public.media m where m.owner_id = v_uid), '[]'),
    'clinician_verifications',
                      coalesce((select jsonb_agg(to_jsonb(v) - 'reviewed_by' order by v.submitted_at)
                                from public.clinician_verifications v where v.user_id = v_uid), '[]'),
    -- …025: advertiser account, campaigns and ledger (reviewer and recording admin withheld).
    'advertiser',     (select to_jsonb(a) - 'reviewed_by' from public.advertisers a where a.owner_id = v_uid),
    'ad_campaigns',   coalesce((select jsonb_agg(to_jsonb(c) - 'reviewed_by' order by c.created_at)
                                from public.ad_campaigns c join public.advertisers a on a.id = c.advertiser_id where a.owner_id = v_uid), '[]'),
    'ad_ledger',      coalesce((select jsonb_agg(to_jsonb(l) - 'actor_id' order by l.id)
                                from public.ad_ledger l join public.advertisers a on a.id = l.advertiser_id where a.owner_id = v_uid), '[]'),
    'ad_reports_filed', coalesce((select jsonb_agg(to_jsonb(r) - 'resolved_by' order by r.created_at) from public.ad_reports r where r.reporter_id = v_uid), '[]'),
    'ledger',         coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.ledger_events e where e.user_id = v_uid), '[]'),
    'strikes',        coalesce((select jsonb_agg(to_jsonb(s)) from public.strikes s where s.user_id = v_uid), '[]'),
    'sanctions',      coalesce((select jsonb_agg(to_jsonb(s)) from public.sanctions s where s.user_id = v_uid), '[]'),
    'moderation_actions_on_me',
                      coalesce((select jsonb_agg(to_jsonb(a) - 'actor_id') from public.mod_actions a where a.target_user_id = v_uid), '[]')
  );
end;
$$;

-- The admin home counts advertising work waiting for the team (from …020).
create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_last_run public.scoring_runs;
begin
  perform private.require_admin(v_uid);
  select * into v_last_run from public.scoring_runs order by created_at desc limit 1;

  return jsonb_build_object(
    'reports_open', (select count(distinct coalesce(r.post_id, r.comment_id)) from public.reports r where r.status = 'open'),
    'reports_oldest', (select min(r.created_at) from public.reports r where r.status = 'open'),
    'appeals_open', (select count(*) from public.appeals a where a.status = 'open'),
    'appeals_admin_only', (select count(*) from public.appeals a join public.mod_actions m on m.id = a.mod_action_id
                           where a.status = 'open' and m.zone_id is null),
    'collapsed', (select count(*) from public.posts p where p.status = 'collapsed')
               + (select count(*) from public.comments c where c.status = 'collapsed'),
    'collapsed_next_reopen', (
      select min(x.at) + make_interval(hours => private.cfg_int('reports.collapse_review_hours')) from (
        select p.status_changed_at as at from public.posts p where p.status = 'collapsed'
        union all select c.status_changed_at from public.comments c where c.status = 'collapsed') x),
    'held', (select count(*) from public.posts p where p.status = 'held' and p.held_reason is not null)
          + (select count(*) from public.comments c where c.status = 'held' and c.held_reason is not null),
    'links_pending', (select count(*) from public.posts p where p.status = 'held' and p.links_pending is not null)
                   + (select count(*) from public.comments c where c.status = 'held' and c.links_pending is not null),
    'links_oldest', (select min(x.at) from (
                       select p.status_changed_at as at from public.posts p where p.status = 'held' and p.links_pending is not null
                       union all
                       select c.status_changed_at from public.comments c where c.status = 'held' and c.links_pending is not null) x),
    'member_reports_open', (select count(distinct r.reported_id) from public.member_reports r where r.status = 'open'),
    'member_reports_oldest', (select min(r.created_at) from public.member_reports r where r.status = 'open'),
    'tickets_open', (select count(*) from public.support_tickets t where t.status = 'open'),
    'tickets_oldest', (select min(t.last_message_at) from public.support_tickets t where t.status = 'open'),
    -- …024 / …025: verification requests and advertising waiting for review.
    'clinicians_pending', (select count(*) from public.clinician_verifications v where v.status = 'pending'),
    'ads_pending', (select count(*) from public.advertisers a where a.status = 'pending')
                 + (select count(*) from public.ad_campaigns c where c.status = 'review')
                 + (select count(*) from public.ad_reports r where r.status = 'open'),
    'owner', (select p.username from public.user_roles r join public.profiles p on p.id = r.user_id
              where r.role = 'owner' and private.is_admin(r.user_id)),
    'is_owner', private.is_owner(v_uid),
    'jobs', coalesce((
      select jsonb_object_agg(j.job, jsonb_build_object('at', j.finished_at, 'ok', j.ok))
      from (select distinct on (r.job) r.job, r.finished_at, r.ok from public.job_runs r
            order by r.job, r.finished_at desc) j), '{}'::jsonb),
    'last_scoring_run', v_last_run.created_at,
    'security_problems', (select count(*) from private.security_audit()),
    'staff_without_mfa', (select count(*) from private.staff_without_mfa()),
    'founding_expiring', (select count(*) from public.profiles p
                          where p.rater_status = 'founding' and p.founding_until between now() and now() + interval '14 days'),
    'deletions_pending', (select count(*) from public.account_deletions d where d.processed_at is null),
    'deletions_oldest', (select min(d.requested_at) from public.account_deletions d where d.processed_at is null),
    'scoring_mode', private.cfg('scoring.mode') #>> '{}',
    'bridging_ready', private.cfg('scoring.mode') #>> '{}' = 'bootstrap'
                      and coalesce((v_last_run.shadow ->> 'established_raters')::integer, 0)
                          >= private.cfg_int('scoring.bridging.switch_min_raters')
                      and coalesce((v_last_run.shadow ->> 'agreement')::numeric, 0) >= 0.85
  );
end;
$$;
