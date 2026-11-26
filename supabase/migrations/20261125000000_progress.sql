-- Player progress, one row per (player, puzzle).
-- Run once in the Supabase dashboard (SQL Editor), or with `supabase db push`.

create table public.progress (
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  puzzle_key  text        not null check (length(puzzle_key) <= 64),   -- "<central>:<7 sorted letters>"
  found       text[]      not null default '{}',
  points      integer     not null default 0 check (points >= 0),
  updated_at  timestamptz not null default now(),
  primary key (user_id, puzzle_key)
);

comment on table public.progress is 'Words found and points per player and puzzle (énigmot).';

-- Row level security: a player only ever sees and writes their own rows.
alter table public.progress enable row level security;

create policy "Players read their own progress"
  on public.progress for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Players insert their own progress"
  on public.progress for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Players update their own progress"
  on public.progress for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Players delete their own progress"
  on public.progress for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Save = merge, never overwrite: found words are unioned and points keep the max,
-- so two devices playing the same puzzle can't erase each other's words.
-- security invoker: runs as the player, so the policies above still apply.
create function public.save_progress(p_puzzle_key text, p_found text[], p_points integer)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.progress as p (user_id, puzzle_key, found, points)
  values (auth.uid(), p_puzzle_key, p_found, p_points)
  on conflict (user_id, puzzle_key) do update set
    found      = array(select distinct w from unnest(p.found || excluded.found) as w order by w),
    points     = greatest(p.points, excluded.points),
    updated_at = now();
$$;

revoke execute on function public.save_progress(text, text[], integer) from public, anon;
grant execute on function public.save_progress(text, text[], integer) to authenticated;
