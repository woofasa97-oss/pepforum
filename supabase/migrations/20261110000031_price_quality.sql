-- ============================================================================
-- 0031 · Price tracking: vendors in the admin console, certificates of analysis
--
-- Two things a storefront feed cannot tell us are kept by admins, by hand,
-- each with its evidence:
--
--   * Which stores we read. An admin adds a vendor (it starts `pending`: never
--     read live, never shown), activates it after a clean dry run, pauses or
--     delists it. Delisting hides it from the site at once.
--   * Certificates of analysis (COAs) a vendor publishes: the lab, the batch,
--     the test date, the method and the purity the document states, with a
--     link to the document and the day we checked it. A COA is the VENDOR's
--     claim; Pepforum records what the document says and never tests anything.
--     The pipeline may file a link it found as a `candidate`
--     (prices.file_coa_candidate); only an admin can publish one.
--
-- Every admin write needs MFA and a reason and is recorded in the moderation
-- log. See docs/PRICES.md and docs/ADMIN.md ("Prices").
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
  'ad_payment_recorded', 'ad_adjustment', 'ad_report_resolved',
  'social_unlinked',
  'price_vendor_saved', 'price_vendor_status', 'price_coa_saved', 'price_coa_status',
  'price_link_saved', 'price_link_removed'));

alter table public.mod_actions drop constraint mod_actions_target_kind_check;
alter table public.mod_actions add constraint mod_actions_target_kind_check check (target_kind in (
  'post', 'comment', 'user', 'config', 'appeal', 'sanction', 'note', 'strike', 'shield', 'taxonomy', 'redirect', 'media',
  'advertiser', 'campaign', 'ad_report', 'price_vendor', 'price_coa'));

-- ---------------------------------------------------------------------------
-- Certificates of analysis
-- ---------------------------------------------------------------------------
create table prices.coa_documents (
  id                uuid primary key default gen_random_uuid(),
  vendor_id         uuid        not null references prices.vendors (id) on delete cascade,
  compound_id       uuid references prices.compounds (id) on delete set null,   -- null = not tied to one compound
  offer_id          uuid,                                                        -- the listing it was found on, if any
  url               text        not null check (url ~ '^https://\S+$' and char_length(url) <= 1000),
  -- What the certificate covers: the vendor as a whole, a product, or one named batch.
  scope             text        not null default 'product' check (scope in ('vendor', 'product', 'batch')),
  batch             text check (batch is null or char_length(batch) between 1 and 80),
  lab               text check (lab is null or char_length(lab) between 2 and 120),
  -- An accreditation as printed on the document (e.g. "ISO/IEC 17025"). Not checked by us.
  lab_accreditation text check (lab_accreditation is null or char_length(lab_accreditation) between 2 and 120),
  method            text check (method is null or method in ('hplc', 'ms', 'hplc_ms', 'other')),
  test_date         date,
  stated_purity_pct numeric(6, 3) check (stated_purity_pct is null or (stated_purity_pct > 0 and stated_purity_pct <= 100)),
  evidence_quote    text check (evidence_quote is null or char_length(evidence_quote) <= 500),
  status            text        not null default 'candidate' check (status in ('candidate', 'published', 'withdrawn')),
  checked_at        timestamptz,
  checked_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (vendor_id, url),
  -- A published certificate names its lab and the purity it states, and someone checked it.
  constraint coa_published_is_complete
    check (status <> 'published' or (lab is not null and stated_purity_pct is not null and checked_at is not null))
);
create index coa_documents_vendor_idx on prices.coa_documents (vendor_id, status);
create trigger coa_documents_touch before update on prices.coa_documents
  for each row execute function private.touch_updated_at();
alter table prices.coa_documents enable row level security;
comment on table prices.coa_documents is
  'Certificates of analysis as published by vendors. Records what the document states; never an independent result.';

-- The pipeline files a link it found; nothing is shown until an admin publishes it.
create function prices.file_coa_candidate(p_vendor uuid, p_compound uuid, p_offer uuid, p_url text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if p_url is null or p_url !~ '^https://\S+$' or char_length(p_url) > 1000 then
    return false;
  end if;
  insert into prices.coa_documents (vendor_id, compound_id, offer_id, url, status)
  values (p_vendor, p_compound, p_offer, p_url, 'candidate')
  on conflict (vendor_id, url) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
grant execute on function prices.file_coa_candidate(uuid, uuid, uuid, text) to pepforum_prices;

-- A vendor's coa_scope is the most specific scope among its published certificates.
create function private.price_refresh_coa_scope(p_vendor uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update prices.vendors v
     set coa_scope = coalesce((
           select d.scope from prices.coa_documents d
           where d.vendor_id = v.id and d.status = 'published'
           order by case d.scope when 'batch' then 1 when 'product' then 2 else 3 end
           limit 1), 'unknown')
   where v.id = p_vendor;
$$;

-- ---------------------------------------------------------------------------
-- Admin: overview
-- ---------------------------------------------------------------------------
create function public.admin_price_overview()
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
    'enabled', private.cfg_bool('features.prices'),
    'publication', (
      select jsonb_build_object('published_at', p.published_at, 'offers', p.offers, 'vendors', p.vendors,
                                'compounds', p.compounds, 'waiting', p.waiting, 'run_label', r.run_label)
      from prices.publications p join prices.refresh_runs r on r.id = p.run_id
      order by p.published_at desc limit 1),
    'runs', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.started_at desc)
      from (select r.run_label, r.mode, r.dry_run, r.status, r.verdict, r.started_at, r.finished_at,
                   (select count(*) from prices.refresh_attempts a where a.run_id = r.id and a.outcome = 'hit') as vendors_read,
                   (select count(*) from prices.refresh_attempts a where a.run_id = r.id) as vendors_tried
            from prices.refresh_runs r
            where r.mode in ('feeds', 'pages')
            order by r.started_at desc limit 10) x), '[]'::jsonb),
    'vendors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', v.slug, 'name', v.name, 'website_url', v.website_url, 'origin_country', v.origin_country,
               'origin_source', v.origin_source, 'platform', v.detected_platform, 'status', v.status,
               'status_note', v.status_note, 'unreadable', v.unreadable, 'coa_scope', v.coa_scope,
               'last_ingested_at', v.last_ingested_at,
               'offers', (select count(*) from prices.published_offers p where p.vendor_id = v.id),
               'coas', (select count(*) from prices.coa_documents d where d.vendor_id = v.id and d.status = 'published'),
               'coa_candidates', (select count(*) from prices.coa_documents d where d.vendor_id = v.id and d.status = 'candidate'),
               'last_outcome', (select a.outcome from prices.refresh_attempts a
                                where a.vendor_id = v.id and a.finished_at is not null
                                order by a.finished_at desc limit 1),
               'last_http_status', (select a.http_status from prices.refresh_attempts a
                                    where a.vendor_id = v.id and a.finished_at is not null
                                    order by a.finished_at desc limit 1))
             order by v.status, v.name)
      from prices.vendors v), '[]'::jsonb),
    'compounds', coalesce((
      select jsonb_agg(jsonb_build_object('slug', c.slug, 'name', c.name) order by c.name)
      from prices.compounds c where c.is_active), '[]'::jsonb));
end;
$$;
grant execute on function public.admin_price_overview() to authenticated;

-- ---------------------------------------------------------------------------
-- Admin: vendors
-- ---------------------------------------------------------------------------
-- Adds a store (pending) or corrects its name, address or where it is based.
create function public.admin_price_vendor_save(
  p_slug text, p_name text, p_website_url text, p_origin_country text, p_origin_source text, p_reason text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_admin_write(p_reason);
  v_slug   text := lower(btrim(coalesce(p_slug, '')));
  v_name   text := btrim(coalesce(p_name, ''));
  v_url    text := rtrim(btrim(coalesce(p_website_url, '')), '/');
  v_domain text;
  v_id     uuid;
begin
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_slug) > 60 then
    perform private.raise_error('PF422', 'invalid_vendor_slug');
  end if;
  if char_length(v_name) not between 1 and 120 then
    perform private.raise_error('PF422', 'invalid_vendor_name');
  end if;
  if v_url !~ '^https://[a-z0-9-]+(\.[a-z0-9-]+)+(/\S*)?$' or char_length(v_url) > 300 then
    perform private.raise_error('PF422', 'invalid_vendor_url');
  end if;
  if p_origin_country is null or p_origin_country not in ('US', 'CA', 'GB', 'AU', 'NZ', 'EU', 'OTHER') then
    perform private.raise_error('PF422', 'invalid_vendor_country');
  end if;
  v_domain := regexp_replace(regexp_replace(v_url, '^https://(www\.)?', ''), '/.*$', '');

  insert into prices.vendors (slug, name, website_url, canonical_domain, origin_country, origin_source)
  values (v_slug, v_name, v_url, v_domain, p_origin_country, nullif(btrim(coalesce(p_origin_source, '')), ''))
  on conflict (slug) do update set
    name = excluded.name, website_url = excluded.website_url, canonical_domain = excluded.canonical_domain,
    origin_country = excluded.origin_country, origin_source = excluded.origin_source
  returning id into v_id;

  perform private.log_mod_action(v_uid, 'price_vendor_saved', 'price_vendor', v_id, null, null, btrim(p_reason),
                                 jsonb_build_object('slug', v_slug, 'domain', v_domain, 'origin_country', p_origin_country));
  return v_slug;
end;
$$;
grant execute on function public.admin_price_vendor_save(text, text, text, text, text, text) to authenticated;

-- pending → active (read live and shown), paused (kept, neither read nor
-- shown), delisted (hidden for good). `unreadable` exempts a store that
-- refuses our reader from the gate's "vendors gone silent" check.
create function public.admin_price_vendor_set_status(p_slug text, p_status text, p_unreadable boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  v_id  uuid;
  v_old text;
begin
  if p_status is null or p_status not in ('pending', 'active', 'paused', 'delisted') then
    perform private.raise_error('PF422', 'invalid_vendor_status');
  end if;
  select v.id, v.status into v_id, v_old from prices.vendors v where v.slug = p_slug for update;
  if v_id is null then
    perform private.raise_error('PF404', 'vendor_not_found');
  end if;
  update prices.vendors
     set status = p_status, unreadable = coalesce(p_unreadable, unreadable), status_note = btrim(p_reason)
   where id = v_id;
  perform private.log_mod_action(v_uid, 'price_vendor_status', 'price_vendor', v_id, null, null, btrim(p_reason),
                                 jsonb_build_object('slug', p_slug, 'from', v_old, 'to', p_status, 'unreadable', p_unreadable));
end;
$$;
grant execute on function public.admin_price_vendor_set_status(text, text, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Admin: certificates
-- ---------------------------------------------------------------------------
create function public.admin_price_coas(p_status text default null)
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
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', d.id, 'vendor', v.slug, 'vendor_name', v.name, 'compound', c.slug, 'compound_name', c.name,
             'url', d.url, 'scope', d.scope, 'batch', d.batch, 'lab', d.lab, 'lab_accreditation', d.lab_accreditation,
             'method', d.method, 'test_date', d.test_date, 'stated_purity_pct', d.stated_purity_pct,
             'evidence_quote', d.evidence_quote, 'status', d.status, 'checked_at', d.checked_at,
             'checked_by', (select p.username from public.profiles p where p.id = d.checked_by),
             'created_at', d.created_at)
           order by d.status, v.name, d.created_at desc)
    from (select * from prices.coa_documents x
          where p_status is null or x.status = p_status
          order by x.created_at desc limit 500) d
    join prices.vendors v on v.id = d.vendor_id
    left join prices.compounds c on c.id = d.compound_id), '[]'::jsonb);
end;
$$;
grant execute on function public.admin_price_coas(text) to authenticated;

-- Records what a certificate states. p_id null = a new record (found by hand);
-- otherwise the candidate or record being completed. Saving stamps who checked
-- it and when; it does not publish.
create function public.admin_price_coa_save(
  p_id uuid, p_vendor text, p_compound text, p_url text, p_scope text, p_batch text, p_lab text,
  p_lab_accreditation text, p_method text, p_test_date date, p_stated_purity_pct numeric,
  p_evidence_quote text, p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := private.require_admin_write(p_reason);
  v_vendor   uuid;
  v_compound uuid;
  v_id       uuid;
  v_url      text := btrim(coalesce(p_url, ''));
begin
  select v.id into v_vendor from prices.vendors v where v.slug = p_vendor;
  if v_vendor is null then
    perform private.raise_error('PF404', 'vendor_not_found');
  end if;
  if nullif(btrim(coalesce(p_compound, '')), '') is not null then
    select c.id into v_compound from prices.compounds c where c.slug = p_compound;
    if v_compound is null then
      perform private.raise_error('PF404', 'compound_not_found');
    end if;
  end if;
  if v_url !~ '^https://\S+$' or char_length(v_url) > 1000 then
    perform private.raise_error('PF422', 'invalid_url');
  end if;
  if p_scope is null or p_scope not in ('vendor', 'product', 'batch') then
    perform private.raise_error('PF422', 'invalid_coa_scope');
  end if;
  if p_method is not null and p_method not in ('hplc', 'ms', 'hplc_ms', 'other') then
    perform private.raise_error('PF422', 'invalid_coa_method');
  end if;
  if p_stated_purity_pct is not null and (p_stated_purity_pct <= 0 or p_stated_purity_pct > 100) then
    perform private.raise_error('PF422', 'invalid_coa_purity');
  end if;
  if p_test_date is not null and p_test_date > current_date then
    perform private.raise_error('PF422', 'invalid_coa_date');
  end if;
  if p_scope = 'batch' and nullif(btrim(coalesce(p_batch, '')), '') is null then
    perform private.raise_error('PF422', 'coa_batch_required');
  end if;

  if p_id is null then
    insert into prices.coa_documents (vendor_id, compound_id, url, scope, batch, lab, lab_accreditation, method,
                                      test_date, stated_purity_pct, evidence_quote, checked_at, checked_by)
    values (v_vendor, v_compound, v_url, p_scope, nullif(btrim(coalesce(p_batch, '')), ''),
            nullif(btrim(coalesce(p_lab, '')), ''), nullif(btrim(coalesce(p_lab_accreditation, '')), ''), p_method,
            p_test_date, p_stated_purity_pct, nullif(btrim(coalesce(p_evidence_quote, '')), ''), now(), v_uid)
    on conflict (vendor_id, url) do nothing
    returning id into v_id;
    if v_id is null then
      perform private.raise_error('PF409', 'coa_exists');
    end if;
  else
    update prices.coa_documents d
       set vendor_id = v_vendor, compound_id = v_compound, url = v_url, scope = p_scope,
           batch = nullif(btrim(coalesce(p_batch, '')), ''), lab = nullif(btrim(coalesce(p_lab, '')), ''),
           lab_accreditation = nullif(btrim(coalesce(p_lab_accreditation, '')), ''), method = p_method,
           test_date = p_test_date, stated_purity_pct = p_stated_purity_pct,
           evidence_quote = nullif(btrim(coalesce(p_evidence_quote, '')), ''), checked_at = now(), checked_by = v_uid,
           -- An edit that leaves a published record incomplete takes it down.
           status = case when d.status = 'published'
                          and (nullif(btrim(coalesce(p_lab, '')), '') is null or p_stated_purity_pct is null)
                         then 'candidate' else d.status end
     where d.id = p_id
    returning d.id into v_id;
    if v_id is null then
      perform private.raise_error('PF404', 'coa_not_found');
    end if;
  end if;

  perform private.price_refresh_coa_scope(v_vendor);
  perform private.log_mod_action(v_uid, 'price_coa_saved', 'price_coa', v_id, null, null, btrim(p_reason),
                                 jsonb_build_object('vendor', p_vendor, 'compound', p_compound, 'scope', p_scope));
  return v_id;
end;
$$;
grant execute on function public.admin_price_coa_save(uuid, text, text, text, text, text, text, text, text, date, numeric, text, text) to authenticated;

create function public.admin_price_coa_set_status(p_id uuid, p_status text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  v_doc prices.coa_documents%rowtype;
begin
  if p_status is null or p_status not in ('candidate', 'published', 'withdrawn') then
    perform private.raise_error('PF422', 'invalid_coa_status');
  end if;
  select * into v_doc from prices.coa_documents d where d.id = p_id for update;
  if v_doc.id is null then
    perform private.raise_error('PF404', 'coa_not_found');
  end if;
  if p_status = 'published' and (v_doc.lab is null or v_doc.stated_purity_pct is null or v_doc.checked_at is null) then
    perform private.raise_error('PF422', 'coa_incomplete');
  end if;
  update prices.coa_documents set status = p_status where id = p_id;
  perform private.price_refresh_coa_scope(v_doc.vendor_id);
  perform private.log_mod_action(v_uid, 'price_coa_status', 'price_coa', p_id, null, null, btrim(p_reason),
                                 jsonb_build_object('from', v_doc.status, 'to', p_status));
end;
$$;
grant execute on function public.admin_price_coa_set_status(uuid, text, text) to authenticated;
