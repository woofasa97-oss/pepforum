-- Newcomers can post from the day they sign up.
--
-- Posting used to unlock at Member (100 karma), which stopped new members at
-- the door. Now a Newcomer can start text posts straight away, a few a day;
-- Member unlocks link posts and the normal daily limit. Karma still gates
-- everything that moderates other people (rating and writing notes, Steward),
-- and new posts still pass the sourcing shield and collapse on reports.
-- See docs/SELF_MODERATION.md, "Tiers".

-- Move the defaults only where nobody has changed them in production.
update public.app_config set value = '0'::jsonb
 where key = 'gates.post_text.min_tier' and value = '1'::jsonb;

update public.app_config set value = '1'::jsonb
 where key = 'gates.post_link.min_tier' and value = '2'::jsonb;

insert into public.app_config (key, value, is_public, description) values
  ('rate_limit.post_newcomer', '{"limit": 3, "window_seconds": 86400}', false,
   'Posts a Newcomer (tier 0) can start per day, on top of rate_limit.post.');

-- create_post: unchanged except for the Newcomer limit.
create or replace function public.create_post(
  p_zone_id     text,
  p_category_id text,
  p_post_type   text,
  p_title       text,
  p_body        text,
  p_link_url    text default null,
  p_city_id     text default null,
  p_language    text default 'en'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := private.require_user();
  v_title text := btrim(coalesce(p_title, ''));
  v_body  text := btrim(coalesce(p_body, ''));
  v_link  text := nullif(btrim(coalesce(p_link_url, '')), '');
  v_id    uuid;
begin
  perform private.require_capability(v_uid, case when v_link is null then 'post_text' else 'post_link' end);
  perform private.enforce_rate_limit(v_uid, 'post');
  if (select p.tier from public.profiles p where p.id = v_uid) = 0 then
    perform private.enforce_rate_limit(v_uid, 'post_newcomer');
  end if;
  if private.integrity(v_uid) < private.cfg_int('gates.posting.cooldown_integrity') then
    perform private.enforce_rate_limit(v_uid, 'post_low_integrity');
  end if;

  if not exists (select 1 from public.zones z where z.id = p_zone_id) then
    perform private.raise_error('PF422', 'invalid_zone');
  end if;
  if not exists (select 1 from public.categories c where c.id = p_category_id and c.archived_at is null) then
    perform private.raise_error('PF422', 'invalid_category');
  end if;
  if p_city_id is not null and not exists (
    select 1 from public.cities c where c.id = p_city_id and c.zone_id = p_zone_id
  ) then
    perform private.raise_error('PF422', 'invalid_city');
  end if;
  if p_post_type is null or p_post_type not in ('experience', 'claim', 'question', 'resource') then
    perform private.raise_error('PF422', 'invalid_post_type');
  end if;
  if char_length(v_title) not between 8 and 140 then
    perform private.raise_error('PF422', 'invalid_title');
  end if;
  if char_length(v_body) > 10000 or (p_post_type <> 'resource' and char_length(v_body) < 1) then
    perform private.raise_error('PF422', 'invalid_body');
  end if;
  if p_post_type = 'resource' and v_link is null then
    perform private.raise_error('PF422', 'link_required');
  end if;
  if p_language is null or p_language not in ('en', 'fr') then
    perform private.raise_error('PF422', 'invalid_language');
  end if;

  insert into public.posts (author_id, zone_id, city_id, category_id, post_type, title, body, link_url, language)
  values (v_uid, p_zone_id, p_city_id, p_category_id, p_post_type, v_title, v_body, v_link, p_language)
  returning id into v_id;

  insert into public.post_revisions (post_id, revision, title, body, link_url)
  values (v_id, 1, v_title, v_body, v_link);

  return v_id;
end;
$$;
