-- ============================================================================
-- 0002 · Taxonomy: zones, cities, official categories
--
-- Pepforum has no user-created communities. Geography (zone → city) and topic
-- (official category) are two independent axes curated by administrators;
-- every post sits in exactly one zone and one category.
-- ============================================================================

create table public.zones (
  id             text primary key check (id ~ '^[a-z]{2,16}$'),
  name_en        text     not null,
  name_fr        text     not null,
  short_name     text     not null,
  description_en text     not null default '',
  description_fr text     not null default '',
  sort_order     smallint not null default 0
);
comment on table public.zones is 'National plus regional zones. Curated; changes ship as migrations.';

create table public.cities (
  id         text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  zone_id    text not null references public.zones (id),
  name       text not null,
  sort_order smallint not null default 0
);
create index cities_zone on public.cities (zone_id);

create table public.categories (
  id               text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  name_en          text     not null,
  name_fr          text     not null,
  icon             text     not null default 'book',
  description_en   text     not null default '',
  description_fr   text     not null default '',
  rules_en         text[]   not null default '{}',
  rules_fr         text[]   not null default '{}',
  -- Overrides `notes.min_ratings` for high-stakes categories (e.g. regulation).
  min_note_ratings smallint check (min_note_ratings is null or min_note_ratings between 3 and 200),
  sort_order       smallint not null default 0,
  archived_at      timestamptz
);
comment on table public.categories is 'Official, admin-curated categories. Archived categories keep their posts but accept no new ones.';

alter table public.zones      enable row level security;
alter table public.cities     enable row level security;
alter table public.categories enable row level security;

create policy zones_public_read      on public.zones      for select to anon, authenticated using (true);
create policy cities_public_read     on public.cities     for select to anon, authenticated using (true);
create policy categories_public_read on public.categories for select to anon, authenticated using (true);

grant select on public.zones, public.cities, public.categories to anon, authenticated, service_role;
