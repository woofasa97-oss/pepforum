-- ============================================================================
-- 0013 · Scoring input (service_role, read by the worker)
--
-- Returns everything one scoring run needs, read in a single statement so it
-- comes from one consistent MVCC snapshot; `snapshot` is that statement's
-- now(), which apply_note_scores() later uses to detect ratings that arrived
-- while the worker was computing.
--
-- Ratings are compact arrays [note_id, rater_id, value, weight]; only
-- weight > 0 ratings are included (probationary ratings never influence
-- status). Notes older than p_window_days are excluded from the factor model.
-- ============================================================================

create function public.scoring_input(p_window_days integer default 180)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'snapshot', now(),
    'config', (
      select jsonb_object_agg(c.key, c.value)
      from public.app_config c
      where c.key like 'scoring.%' or c.key = 'notes.min_ratings'
    ),
    'open_notes', coalesce((
      select jsonb_agg(jsonb_build_object('id', n.id, 'min_ratings', private.note_min_ratings(n.id), 'status', n.status))
      from public.notes n
      where n.locked_at is null
    ), '[]'::jsonb),
    'ratings', coalesce((
      select jsonb_agg(jsonb_build_array(r.note_id, r.rater_id, r.value, r.weight))
      from public.note_ratings r
      join public.notes n on n.id = r.note_id
      where r.weight > 0
        and n.created_at > now() - make_interval(days => greatest(p_window_days, 1))
    ), '[]'::jsonb)
  );
$$;

grant execute on function public.scoring_input(integer) to service_role;
