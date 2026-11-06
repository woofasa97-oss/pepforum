-- ============================================================================
-- 0026 · Regions on/off
--
-- `features.regions` (public, off by default) hides provinces and cities
-- from members: the zone bar, the region and city pickers when posting, the
-- home-region field, the region pill on posts and the /zone pages. Posts go
-- to the national feed meanwhile. Turning it back on in Rules & settings
-- restores everything; zones, cities and zone moderators are untouched.
-- Admin and moderator pages keep showing zones either way.
-- ============================================================================

insert into public.app_config (key, value, is_public, description) values
  ('features.regions', 'false', true,
   'Show provinces and cities to members (zone bar, region pickers, region pages). Off: everything posts to the national feed.');
