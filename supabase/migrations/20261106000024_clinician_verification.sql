-- ============================================================================
-- 0024 · Clinician verification
--
-- Ported from the pepforum-ca prototype build (CredentialReview.tsx, the
-- `verification.review` permission and its pending → approved → expiring →
-- expired / rejected / revoked state machine) onto the Supabase model.
--
--   * A member who is a licensed health professional submits their profession,
--     regulator, province and registration number, plus a credential document
--     uploaded through …023 (kind 'credential': private, owner + admins only).
--   * An admin (MFA session) approves or rejects with a reason. Approval is
--     valid for `clinician.valid_days`, then lapses; it can be revoked at any
--     time. Every decision is in the moderation log and notifies the member.
--   * The only public effect is a badge: profiles, posts and comments say
--     "verified <profession>". Registration numbers and documents are never
--     public, never in a read-API row, and go with the account.
--   * A badge is context, not authority: verified clinicians get no extra
--     karma, votes, note weight or moderation power (docs/SELF_MODERATION.md).
--
-- See docs/ADMIN.md ("Clinicians") and docs/DATA_PRIVACY.md.
-- ============================================================================

create table public.clinician_verifications (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references public.profiles (id),
  profession          text        not null check (profession in ('physician', 'nurse_practitioner', 'registered_nurse', 'pharmacist', 'naturopathic_doctor', 'dietitian', 'other')),
  regulator           text        not null check (char_length(regulator) between 2 and 120),
  province_id         text        not null references public.zones (id),
  registration_number text        not null check (char_length(registration_number) between 2 and 60),
  document_id         uuid        references public.media (id),
  statement           text        not null default '' check (char_length(statement) <= 1000),
  status              text        not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'revoked', 'withdrawn')),
  submitted_at        timestamptz not null default now(),
  reviewed_at         timestamptz,
  reviewed_by         uuid        references public.profiles (id),
  review_note         text        not null default '',
  expires_at          timestamptz,
  check ((status in ('approved', 'rejected', 'revoked')) = (reviewed_at is not null)),
  check ((status = 'approved') = (expires_at is not null))
);
create index clinician_verifications_user   on public.clinician_verifications (user_id, submitted_at desc);
create index clinician_verifications_status on public.clinician_verifications (status, submitted_at);
create unique index clinician_verifications_one_pending  on public.clinician_verifications (user_id) where status = 'pending';
create unique index clinician_verifications_one_approved on public.clinician_verifications (user_id) where status = 'approved';

-- Read through the RPCs below; nobody gets table access.
alter table public.clinician_verifications enable row level security;

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
  'clinician_approved', 'clinician_rejected', 'clinician_revoked'));

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'reply_post', 'reply_comment', 'note_outcome', 'note_on_post', 'mod_action', 'team_reply', 'clinician_review'));

insert into public.app_config (key, value, is_public, description) values
  ('clinician.valid_days', '730', true, 'How long an approved clinician verification lasts before the member must renew it.'),
  ('rate_limit.clinician_submit', '{"limit": 3, "window_seconds": 86400}', false, 'Clinician verification requests one member can submit per day.');
update public.app_config set bounds = '{"min": 30, "max": 3650}' where key = 'clinician.valid_days';

-- ---------------------------------------------------------------------------
-- Predicates
-- ---------------------------------------------------------------------------
-- Current, approved and not lapsed. Null-safe for anonymous callers.
create function private.clinician_badge(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select v.profession
  from public.clinician_verifications v
  where v.user_id = p_user and v.status = 'approved' and v.expires_at > now()
  limit 1;
$$;

-- Team notifications include verification decisions (from …022).
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
           else false
         end
  from (select 1) x
  left join public.notification_settings s on s.user_id = p_user;
$$;

-- ---------------------------------------------------------------------------
-- Members: submit, withdraw, see where it stands
-- ---------------------------------------------------------------------------
create function public.submit_clinician_verification(
  p_profession text, p_regulator text, p_province text, p_registration_number text,
  p_document_id uuid, p_statement text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := private.require_user();
  v_regulator text := btrim(coalesce(p_regulator, ''));
  v_number    text := btrim(coalesce(p_registration_number, ''));
  v_statement text := btrim(coalesce(p_statement, ''));
  v_id        uuid;
begin
  perform private.require_capability(v_uid, 'report');
  perform private.enforce_rate_limit(v_uid, 'clinician_submit');

  if p_profession is null or p_profession not in ('physician', 'nurse_practitioner', 'registered_nurse', 'pharmacist', 'naturopathic_doctor', 'dietitian', 'other') then
    perform private.raise_error('PF422', 'invalid_profession');
  end if;
  if char_length(v_regulator) not between 2 and 120 then
    perform private.raise_error('PF422', 'invalid_regulator');
  end if;
  if p_province is null or p_province = 'national' or not exists (select 1 from public.zones z where z.id = p_province) then
    perform private.raise_error('PF422', 'invalid_province');
  end if;
  if char_length(v_number) not between 2 and 60 then
    perform private.raise_error('PF422', 'invalid_registration');
  end if;
  if char_length(v_statement) > 1000 then
    perform private.raise_error('PF422', 'invalid_body');
  end if;
  if p_document_id is null or not exists (
       select 1 from public.media m
       where m.id = p_document_id and m.owner_id = v_uid and m.kind = 'credential' and m.status = 'ready') then
    perform private.raise_error('PF404', 'not_found', 'document');
  end if;
  if exists (select 1 from public.clinician_verifications v where v.user_id = v_uid and v.status = 'pending') then
    perform private.raise_error('PF409', 'already_pending');
  end if;
  if private.clinician_badge(v_uid) is not null
     and (select v.expires_at from public.clinician_verifications v where v.user_id = v_uid and v.status = 'approved') > now() + interval '90 days' then
    perform private.raise_error('PF409', 'already_verified');
  end if;

  insert into public.clinician_verifications (user_id, profession, regulator, province_id, registration_number, document_id, statement)
  values (v_uid, p_profession, v_regulator, p_province, v_number, p_document_id, v_statement)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.withdraw_clinician_verification()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  update public.clinician_verifications set status = 'withdrawn' where user_id = v_uid and status = 'pending';
  if not found then
    perform private.raise_error('PF404', 'not_found', 'verification');
  end if;
end;
$$;

-- The caller's latest request and whether they currently carry the badge.
-- Never says which admin reviewed it.
create function public.my_clinician_verification()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v     public.clinician_verifications;
begin
  select * into v from public.clinician_verifications x where x.user_id = v_uid
   order by case x.status when 'pending' then 0 when 'approved' then 1 else 2 end, x.submitted_at desc limit 1;
  return jsonb_build_object(
    'badge', private.clinician_badge(v_uid),
    'latest', case when v.id is null then null else jsonb_build_object(
      'id', v.id, 'profession', v.profession, 'regulator', v.regulator, 'province_id', v.province_id,
      'status', case when v.status = 'approved' and v.expires_at <= now() then 'expired' else v.status end,
      'submitted_at', v.submitted_at, 'reviewed_at', v.reviewed_at, 'review_note', v.review_note, 'expires_at', v.expires_at,
      'document_id', v.document_id) end,
    'valid_days', private.cfg_int('clinician.valid_days'));
end;
$$;

grant execute on function public.submit_clinician_verification(text, text, text, text, uuid, text) to authenticated;
grant execute on function public.withdraw_clinician_verification()                               to authenticated;
grant execute on function public.my_clinician_verification()                                     to authenticated;

-- ---------------------------------------------------------------------------
-- Admins: the review queue
-- ---------------------------------------------------------------------------
-- p_filter: pending (longest wait first) · approved · expiring (within 60 days) · rejected · revoked
create function public.admin_clinician_verifications(p_filter text default 'pending')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_user();
  v_filter text := coalesce(p_filter, 'pending');
begin
  perform private.require_admin(v_uid);
  if v_filter not in ('pending', 'approved', 'expiring', 'rejected', 'revoked') then
    perform private.raise_error('PF422', 'invalid_status');
  end if;
  return jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', v.id, 'member', p.username, 'member_tier', p.tier, 'user_id', p.id, 'joined', p.created_at,
               'profession', v.profession, 'regulator', v.regulator, 'province_id', v.province_id,
               'registration_number', v.registration_number, 'document_id', v.document_id, 'statement', v.statement,
               'status', case when v.status = 'approved' and v.expires_at <= now() then 'expired' else v.status end,
               'submitted_at', v.submitted_at, 'reviewed_at', v.reviewed_at,
               'reviewed_by', (select r.username from public.profiles r where r.id = v.reviewed_by),
               'review_note', v.review_note, 'expires_at', v.expires_at,
               'previous', (select count(*) from public.clinician_verifications x where x.user_id = v.user_id and x.id <> v.id))
             order by case when v_filter = 'pending' then v.submitted_at end asc, coalesce(v.reviewed_at, v.submitted_at) desc)
      from public.clinician_verifications v
      join public.profiles p on p.id = v.user_id
      where case v_filter
              when 'pending'  then v.status = 'pending'
              when 'approved' then v.status = 'approved' and v.expires_at > now()
              when 'expiring' then v.status = 'approved' and v.expires_at between now() and now() + interval '60 days'
              else v.status = v_filter end), '[]'::jsonb),
    'counts', jsonb_build_object(
      'pending',  (select count(*) from public.clinician_verifications v where v.status = 'pending'),
      'approved', (select count(*) from public.clinician_verifications v where v.status = 'approved' and v.expires_at > now()),
      'expiring', (select count(*) from public.clinician_verifications v where v.status = 'approved' and v.expires_at between now() and now() + interval '60 days'),
      'rejected', (select count(*) from public.clinician_verifications v where v.status = 'rejected'),
      'revoked',  (select count(*) from public.clinician_verifications v where v.status = 'revoked'))
  );
end;
$$;

create function public.admin_review_clinician(p_id uuid, p_decision text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  v     public.clinician_verifications;
begin
  if p_decision not in ('approve', 'reject') then
    perform private.raise_error('PF422', 'invalid_decision');
  end if;
  select * into v from public.clinician_verifications x where x.id = p_id for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'verification');
  end if;
  if v.user_id = v_uid then
    perform private.raise_error('PF403', 'conflict_of_interest');
  end if;
  if v.status <> 'pending' then
    perform private.raise_error('PF409', 'not_pending');
  end if;

  if p_decision = 'approve' then
    -- A renewal replaces the current approval.
    update public.clinician_verifications
       set status = 'revoked', reviewed_at = coalesce(reviewed_at, now()), review_note = 'Replaced by a renewal', expires_at = null
     where user_id = v.user_id and status = 'approved';
    update public.clinician_verifications
       set status = 'approved', reviewed_at = now(), reviewed_by = v_uid, review_note = btrim(p_reason),
           expires_at = now() + make_interval(days => private.cfg_int('clinician.valid_days'))
     where id = v.id;
  else
    update public.clinician_verifications
       set status = 'rejected', reviewed_at = now(), reviewed_by = v_uid, review_note = btrim(p_reason)
     where id = v.id;
  end if;

  perform private.log_mod_action(v_uid, case when p_decision = 'approve' then 'clinician_approved' else 'clinician_rejected' end,
                                 'user', v.user_id, v.user_id, null, p_reason,
                                 jsonb_build_object('verification_id', v.id, 'profession', v.profession));
  perform private.notify(v.user_id, 'clinician_review', 'clinician:' || v.id || ':' || p_decision, null, null, null, null, null, null,
                         jsonb_build_object('action', case when p_decision = 'approve' then 'approved' else 'rejected' end,
                                            'reason', btrim(p_reason)));
end;
$$;

create function public.admin_revoke_clinician(p_user uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  v     public.clinician_verifications;
begin
  select * into v from public.clinician_verifications x where x.user_id = p_user and x.status = 'approved' for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'verification');
  end if;
  update public.clinician_verifications
     set status = 'revoked', reviewed_at = now(), reviewed_by = v_uid, review_note = btrim(p_reason), expires_at = null
   where id = v.id;
  perform private.log_mod_action(v_uid, 'clinician_revoked', 'user', v.user_id, v.user_id, null, p_reason,
                                 jsonb_build_object('verification_id', v.id, 'profession', v.profession));
  perform private.notify(v.user_id, 'clinician_review', 'clinician:' || v.id || ':revoked', null, null, null, null, null, null,
                         jsonb_build_object('action', 'revoked', 'reason', btrim(p_reason)));
end;
$$;

grant execute on function public.admin_clinician_verifications(text)      to authenticated;
grant execute on function public.admin_review_clinician(uuid, text, text) to authenticated;
grant execute on function public.admin_revoke_clinician(uuid, text)       to authenticated;

-- ---------------------------------------------------------------------------
-- Recreated from earlier migrations (verbatim, plus the lines marked …024)
-- ---------------------------------------------------------------------------
-- Profiles carry the badge (from …019).
create or replace function public.get_profile(p_username text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'username',      p.username,
    'bio',           p.bio,
    'coi',           p.coi,
    'home_zone_id',  p.home_zone_id,
    'karma',         p.karma,
    'tier',          p.tier,
    -- Moderation-track numbers move when notes settle; publishing them would
    -- unmask pseudonymous writers and reveal how raters voted. Owner only.
    'mod_xp',        case when p.id = auth.uid() then p.mod_xp end,
    'rater_status',  case when p.id = auth.uid() then private.effective_rater_status(p) end,
    'rater_impact',  case when p.id = auth.uid() then p.rater_impact end,
    'writer_impact', case when p.id = auth.uid() then p.writer_impact end,
    'joined_at',     p.created_at,
    'deleted',       p.deleted_at is not null,
    'is_me',         coalesce(p.id = auth.uid(), false),
    'is_admin',      private.is_admin(p.id),
    'clinician',     private.clinician_badge(p.id),   -- …024
    'moderates',     coalesce((select jsonb_agg(m.zone_id) from public.zone_moderators m where m.user_id = p.id), '[]'::jsonb),
    'post_count',    (select count(*) from public.posts x where x.author_id = p.id and x.status in ('visible', 'collapsed')),
    'comment_count', (select count(*) from public.comments x where x.author_id = p.id and x.status in ('visible', 'collapsed'))
  )
  from public.profiles p
  where lower(p.username) = lower(p_username);
$$;

-- Posts and comments carry the author's badge (from …015 and …016). The
-- result shape changes, so the functions are dropped and recreated.
drop function public.get_post(uuid);
create function public.get_post(p_post_id uuid)
returns table (
  id              uuid,
  title           text,
  body            text,
  post_type       text,
  link_url        text,
  language        text,
  status          text,
  removal_reason  text,
  zone_id         text,
  city_id         text,
  category_id     text,
  author_username text,
  author_tier     smallint,
  author_karma    integer,
  is_mine         boolean,
  score           integer,
  comment_count   integer,
  revision        integer,
  created_at      timestamptz,
  edited_at       timestamptz,
  my_vote         smallint,
  can_moderate    boolean,
  pinned          boolean,
  comments_locked boolean,
  author_clinician text
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id,
         case when p.status = 'deleted' then '[deleted post]' else p.title end,
         case when p.status = 'deleted' then '' else p.body end,
         p.post_type, p.link_url, p.language, p.status, p.removal_reason,
         p.zone_id, p.city_id, p.category_id,
         a.username, a.tier, a.karma,
         coalesce(p.author_id = auth.uid(), false),
         p.score, p.comment_count, p.revision, p.created_at, p.edited_at,
         (select v.value from public.post_votes v where v.post_id = p.id and v.voter_id = auth.uid()),
         coalesce(private.is_zone_mod(auth.uid(), p.zone_id) and private.staff_session(), false),
         p.pinned_at is not null,
         p.comments_locked_at is not null,
         private.clinician_badge(a.id)   -- …024
  from public.posts p
  join public.profiles a on a.id = p.author_id
  where p.id = p_post_id
    and (p.status in ('visible', 'collapsed')
         or p.author_id = auth.uid()
         or (private.is_zone_mod(auth.uid(), p.zone_id) and private.staff_session()));
$$;
grant execute on function public.get_post(uuid) to anon, authenticated;

drop function public.get_comments(uuid);
create function public.get_comments(p_post_id uuid)
returns table (
  id              uuid,
  parent_id       uuid,
  depth           smallint,
  author_username text,
  author_tier     smallint,
  is_op           boolean,
  is_mine         boolean,
  body            text,
  status          text,
  score           integer,
  created_at      timestamptz,
  edited_at       timestamptz,
  my_vote         smallint,
  author_clinician text
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.parent_id, c.depth,
         a.username, a.tier,
         c.author_id = p.author_id,
         coalesce(c.author_id = auth.uid(), false),
         case
           -- NULL-safe: for anonymous callers auth.uid() is NULL, and NOT (NULL) would
           -- fall through to the original text.
           when c.status = 'removed'
                and not coalesce(c.author_id = auth.uid()
                                 or (private.is_zone_mod(auth.uid(), p.zone_id) and private.staff_session()), false)
             then '[removed by a moderator]'
           else c.body
         end,
         c.status, c.score, c.created_at, c.edited_at,
         (select v.value from public.comment_votes v where v.comment_id = c.id and v.voter_id = auth.uid()),
         private.clinician_badge(a.id)   -- …024
  from public.comments c
  join public.posts p on p.id = c.post_id
  join public.profiles a on a.id = c.author_id
  where c.post_id = p_post_id
    and p.status in ('visible', 'collapsed')
    -- Held comments: only their author and the zone's moderators see them.
    and (c.status <> 'held'
         or coalesce(c.author_id = auth.uid()
                     or (private.is_zone_mod(auth.uid(), p.zone_id) and private.staff_session()), false))
  order by c.created_at;
$$;
grant execute on function public.get_comments(uuid) to anon, authenticated;

-- Deleting an account deletes its verification requests (from …023).
create or replace function private.tombstone_profile(p_user uuid, p_erase_content boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
  -- Uploads are removed; the worker deletes the bytes (…023).
  update public.media set status = 'removed', removed_reason = 'account_deleted', post_id = null
   where owner_id = p_user and status <> 'removed';

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

-- Your data export includes your verification requests, not who reviewed them (from …022).
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
    'ledger',         coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.ledger_events e where e.user_id = v_uid), '[]'),
    'strikes',        coalesce((select jsonb_agg(to_jsonb(s)) from public.strikes s where s.user_id = v_uid), '[]'),
    'sanctions',      coalesce((select jsonb_agg(to_jsonb(s)) from public.sanctions s where s.user_id = v_uid), '[]'),
    'moderation_actions_on_me',
                      coalesce((select jsonb_agg(to_jsonb(a) - 'actor_id') from public.mod_actions a where a.target_user_id = v_uid), '[]')
  );
end;
$$;
