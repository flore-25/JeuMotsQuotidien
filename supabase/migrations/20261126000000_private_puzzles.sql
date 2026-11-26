-- Private puzzles: the solutions live only in the database and are checked on the server.
-- Run once in the Supabase dashboard (SQL Editor), after 20261125000000_progress.sql.
--
-- Players never read public.puzzles directly (row level security on, no policy). They go
-- through the functions below, which only ever return:
--   - the letters and counts of a puzzle that is out (date ≤ today somewhere on Earth),
--   - the families of words the player has found (unfound forms masked: length + tense only),
--   - a hint (a few first letters), or everything after the player chose to reveal.
-- Found words are written only by submit_word(), so they are always valid words.

-- ---------- puzzles ----------

create table public.puzzles (
  date        date        primary key,
  number      integer     not null unique,
  letters     text        not null check (letters ~ '^[a-z]{7}$'),   -- central letter first
  puzzle_key  text        not null,                                  -- "<central>:<7 sorted letters>", as in progress
  words       text[]      not null,                                  -- every valid word, normalized (NFC, lowercase)
  pangrams    text[]      not null,
  families    jsonb       not null,                                  -- [{lemma, goal, forms: [...], tenses?: {form: [codes]}}]
  updated_at  timestamptz not null default now()
);

comment on table public.puzzles is 'Daily puzzles with their solutions (énigmot). Written by the deploy (secret key), read only through functions.';

alter table public.puzzles enable row level security;
-- No policy on purpose: anon and authenticated can't select, insert, update or delete.

-- ---------- progress: only the server writes found words ----------

drop policy "Players insert their own progress" on public.progress;
drop policy "Players update their own progress" on public.progress;
drop function public.save_progress(text, text[], integer);
-- Kept: "Players read their own progress" (select) and "Players delete their own progress" (start over).

-- ---------- helpers (private schema: not reachable through the API) ----------

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- The latest date that has started anywhere (UTC+14): with local midnight, no player can be further ahead.
create function private.latest_date()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Pacific/Kiritimati')::date;
$$;

-- The puzzle of a day, only for a signed-in player and only once it is out.
create function private.playable_puzzle(p_date date)
returns public.puzzles
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.puzzles;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_date is null or p_date > private.latest_date() then
    raise exception 'puzzle not available' using errcode = '22023';
  end if;
  select * into p from public.puzzles where date = p_date;
  if not found then
    raise exception 'no puzzle on %', p_date using errcode = 'P0002';
  end if;
  return p;
end;
$$;

-- The player's found words for a puzzle.
create function private.found_words(p_key text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select found from public.progress where user_id = auth.uid() and puzzle_key = p_key), '{}');
$$;

-- One family as the player may see it: found forms in clear, the others as length + tenses only.
create function private.family_view(f jsonb, idx integer, shown text[], words text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', idx,
    'lemma', f->>'lemma',
    'goal', (f->>'goal')::boolean,
    'playable', (f->>'lemma') = any(words),
    'forms', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'w', case when w = any(shown) then w end,
               'len', char_length(w),
               'tenses', coalesce(f->'tenses'->w, '[]'::jsonb)
             ) order by ord), '[]'::jsonb)
      from jsonb_array_elements_text(f->'forms') with ordinality as t(w, ord)
    )
  );
$$;

-- Families containing at least one of `words_in` (e.g. the found words), as views.
create function private.families_with(p public.puzzles, words_in text[], shown text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(private.family_view(f, (i - 1)::integer, shown, p.words) order by i), '[]'::jsonb)
  from jsonb_array_elements(p.families) with ordinality as t(f, i)
  where exists (select 1 from jsonb_array_elements_text(f->'forms') as x(w) where x.w = any(words_in));
$$;

-- Same letters without accents (for the "check the accents" hint).
create function private.strip_accents(w text)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(w, 'àâäçéèêëîïôöùûüÿ', 'aaaceeeeiioouuuy');
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------- API (called by the page with supabase.rpc) ----------

-- Days that are out: number and date only.
create function public.list_days()
returns table (date date, number integer)
language sql
stable
security definer
set search_path = ''
as $$
  select p.date, p.number
  from public.puzzles p
  where auth.uid() is not null and p.date <= private.latest_date()
  order by p.date;
$$;

-- A puzzle as the player sees it: letters, counts, their progress and the families they found.
create function public.get_puzzle(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.puzzles;
  v_found text[];
  v_points integer;
begin
  p := private.playable_puzzle(p_date);
  -- "found" is also a PL/pgSQL variable: always qualify the column (pr.found).
  select coalesce(pr.found, '{}'), pr.points into v_found, v_points
  from public.progress pr where pr.user_id = auth.uid() and pr.puzzle_key = p.puzzle_key;
  v_found := array(select w from unnest(coalesce(v_found, '{}')) as w where w = any(p.words));
  return jsonb_build_object(
    'date', p.date,
    'number', p.number,
    'letters', p.letters,
    'puzzle_key', p.puzzle_key,
    'family_count', jsonb_array_length(p.families),
    'goal_count', (select count(*) from jsonb_array_elements(p.families) as f where (f->>'goal')::boolean),
    'pangram_count', cardinality(p.pangrams),
    'found', to_jsonb(v_found),
    'points', coalesce(v_points, 0),
    'pangrams_found', to_jsonb(array(select w from unnest(v_found) as w where w = any(p.pangrams))),
    'families', private.families_with(p, v_found, v_found)
  );
end;
$$;

-- Check a word. Valid and new → saved. Returns the status and the word's families.
--   status: ok | already | almost (right letters, wrong accents) | unknown
create function public.submit_word(p_date date, p_word text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p public.puzzles;
  w text := lower(normalize(coalesce(p_word, ''), NFC));
  v_found text[];
begin
  p := private.playable_puzzle(p_date);
  if char_length(w) > 40 then
    return jsonb_build_object('status', 'unknown');
  end if;
  if not (w = any(p.words)) then
    return jsonb_build_object('status',
      case when exists (select 1 from unnest(p.words) as x where private.strip_accents(x) = private.strip_accents(w))
           then 'almost' else 'unknown' end);
  end if;

  v_found := private.found_words(p.puzzle_key);
  if w = any(v_found) then
    return jsonb_build_object('status', 'already', 'word', w,
      'families', private.families_with(p, array[w], v_found));
  end if;

  insert into public.progress as pr (user_id, puzzle_key, found, points)
  values (auth.uid(), p.puzzle_key, array[w], 0)
  on conflict (user_id, puzzle_key) do update set
    found      = array(select distinct x from unnest(pr.found || excluded.found) as x order by x),
    updated_at = now()
  returning pr.found into v_found;

  return jsonb_build_object(
    'status', 'ok',
    'word', w,
    'pangram', w = any(p.pangrams),
    'families', private.families_with(p, array[w], v_found)
  );
end;
$$;

-- Points are computed by the page (streaks, bonuses) and only ever go up.
create function public.save_points(p_date date, p_points integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p public.puzzles;
begin
  p := private.playable_puzzle(p_date);
  update public.progress pr
  set points = greatest(pr.points, least(greatest(p_points, 0), 100000)), updated_at = now()
  where pr.user_id = auth.uid() and pr.puzzle_key = p.puzzle_key;
end;
$$;

-- A hint: the first letters of a word the player hasn't found (never the whole word).
-- p_family null = pick a family (a goal one if any is left); else continue that family's hint.
create function public.get_hint(p_date date, p_family integer, p_letters integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p public.puzzles;
  v_found text[];
  fam jsonb;
  idx integer;
  target text;
begin
  p := private.playable_puzzle(p_date);
  v_found := private.found_words(p.puzzle_key);
  if p_family is null then
    select f, (i - 1)::integer into fam, idx
    from jsonb_array_elements(p.families) with ordinality as t(f, i)
    where not exists (select 1 from jsonb_array_elements_text(f->'forms') as x(w) where x.w = any(v_found))
    order by (f->>'goal')::boolean desc, random()
    limit 1;
    if fam is null then
      return null; -- every family found
    end if;
  else
    fam := p.families->p_family;
    idx := p_family;
    if fam is null then
      raise exception 'no such family' using errcode = '22023';
    end if;
  end if;
  -- The word to guess: the lemma when it can be spelled here, else the family's shortest form.
  target := case when fam->>'lemma' = any(p.words) then fam->>'lemma'
                 else (select x from jsonb_array_elements_text(fam->'forms') as x order by char_length(x), x limit 1) end;
  return jsonb_build_object(
    'family', idx,
    'len', char_length(target),
    'prefix', left(target, greatest(1, least(coalesce(p_letters, 1), char_length(target) - 1)))
  );
end;
$$;

-- Everything, after the player confirmed "Révéler la solution".
create function public.reveal_solution(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.puzzles;
begin
  p := private.playable_puzzle(p_date);
  return jsonb_build_object(
    'pangrams', to_jsonb(p.pangrams),
    'families', private.families_with(p, p.words, p.words)
  );
end;
$$;

revoke all on function public.list_days() from public, anon;
revoke all on function public.get_puzzle(date) from public, anon;
revoke all on function public.submit_word(date, text) from public, anon;
revoke all on function public.save_points(date, integer) from public, anon;
revoke all on function public.get_hint(date, integer, integer) from public, anon;
revoke all on function public.reveal_solution(date) from public, anon;
grant execute on function public.list_days() to authenticated;
grant execute on function public.get_puzzle(date) to authenticated;
grant execute on function public.submit_word(date, text) to authenticated;
grant execute on function public.save_points(date, integer) to authenticated;
grant execute on function public.get_hint(date, integer, integer) to authenticated;
grant execute on function public.reveal_solution(date) to authenticated;
