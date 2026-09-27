-- Voice fitness logger: initial schema
-- Target: Supabase Postgres (ap-south-1), PG 15+
-- Run top to bottom. Idempotent where practical.

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";
create extension if not exists "vector";

-- ---------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------

create type entry_type   as enum ('activity', 'food', 'bodyweight', 'note');
create type entry_source as enum ('voice', 'manual', 'import', 'correction');
create type intensity    as enum ('light', 'moderate', 'vigorous');
create type meal_slot    as enum ('breakfast', 'lunch', 'snack', 'dinner', 'unspecified');

-- ---------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------

create table household (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- One row per family member. id mirrors auth.users.id so RLS is trivial.
create table app_user (
  id            uuid primary key references auth.users(id) on delete cascade,
  household_id  uuid not null references household(id) on delete cascade,
  display_name  text not null,
  weight_kg     numeric(5,2),
  height_cm     numeric(5,1),
  timezone      text not null default 'Asia/Kolkata',
  created_at    timestamptz not null default now()
);

create index on app_user (household_id);

-- Helper used by every RLS policy below.
create or replace function current_household_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select household_id from app_user where id = auth.uid()
$$;

-- ---------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------

-- MET values drive calorie estimates. Source: Compendium of Physical Activities.
create table activity_type (
  key        text primary key,
  label      text not null,
  met_value  numeric(4,2) not null,
  aliases    text[] not null default '{}'
);

-- Canonical food. is_dish = true means it expands via recipe_component.
-- per_100g holds the nutrient vector so we never join to a wide table.
create table food (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  aliases      text[] not null default '{}',
  is_dish      boolean not null default false,
  source       text not null default 'ifct2017',   -- ifct2017 | off | user | llm_seed
  verified     boolean not null default false,
  per_100g     jsonb not null default '{}'::jsonb, -- {kcal, protein_g, carb_g, fat_g, fibre_g}
  embedding    vector(384),
  created_at   timestamptz not null default now()
);

create index food_name_trgm on food using gin (name gin_trgm_ops);
create index food_aliases_gin on food using gin (aliases);
create index food_embedding_hnsw on food using hnsw (embedding vector_cosine_ops);

-- Dish breakdown. Seeded once by batch job, then corrected by hand.
create table recipe_component (
  dish_id        uuid not null references food(id) on delete cascade,
  ingredient_id  uuid not null references food(id) on delete restrict,
  grams          numeric(7,2) not null check (grams > 0),
  primary key (dish_id, ingredient_id)
);

-- Household unit conversions: 1 katori of dal = 150g, 1 roti = 45g.
create table portion_unit (
  id        uuid primary key default gen_random_uuid(),
  food_id   uuid references food(id) on delete cascade,  -- null = global default
  unit      text not null,
  grams     numeric(7,2) not null check (grams > 0),
  unique (food_id, unit)
);

-- ---------------------------------------------------------------
-- The log
-- ---------------------------------------------------------------

create table log_entry (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references app_user(id) on delete cascade,
  type            entry_type not null,
  logged_at       timestamptz not null default now(),
  local_day       date not null,          -- computed client side in user timezone
  source          entry_source not null default 'voice',
  raw_transcript  text,
  confidence      numeric(3,2) check (confidence between 0 and 1),
  parsed_by       text,                   -- 'grammar' | 'haiku' | 'manual'
  client_id       text,                   -- idempotency key from offline client
  created_at      timestamptz not null default now(),
  unique (user_id, client_id)
);

create index log_entry_user_time on log_entry (user_id, logged_at desc);
create index log_entry_user_day  on log_entry (user_id, local_day);

create table activity_detail (
  entry_id      uuid primary key references log_entry(id) on delete cascade,
  activity_key  text not null references activity_type(key),
  duration_min  integer not null check (duration_min between 1 and 720),
  level         intensity not null default 'moderate',
  distance_km   numeric(6,2),
  est_kcal      numeric(7,2)
);

create table food_detail (
  id        uuid primary key default gen_random_uuid(),
  entry_id  uuid not null references log_entry(id) on delete cascade,
  food_id   uuid not null references food(id) on delete restrict,
  meal      meal_slot not null default 'unspecified',
  qty       numeric(6,2) not null check (qty > 0),
  unit      text not null,
  grams     numeric(7,2) not null,
  macros    jsonb not null default '{}'::jsonb  -- resolved at write time, denormalised on purpose
);

create index food_detail_entry on food_detail (entry_id);

create table bodyweight_detail (
  entry_id   uuid primary key references log_entry(id) on delete cascade,
  weight_kg  numeric(5,2) not null check (weight_kg between 20 and 300)
);

-- "my protein shake" -> a specific food plus a default portion.
create table user_food (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references app_user(id) on delete cascade,
  spoken_alias  text not null,
  food_id       uuid not null references food(id) on delete cascade,
  default_qty   numeric(6,2),
  default_unit  text,
  hit_count     integer not null default 0,
  unique (user_id, spoken_alias)
);

create index user_food_alias_trgm on user_food using gin (spoken_alias gin_trgm_ops);

-- Every utterance the parser could not resolve. This is the backlog
-- that tells you which grammar rules to write next.
create table parse_failure (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references app_user(id) on delete set null,
  transcript  text not null,
  stage       text not null,     -- 'grammar' | 'haiku' | 'food_match'
  detail      jsonb,
  resolved    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- Rollups. Summaries read only from here, never from raw rows.
-- ---------------------------------------------------------------

create table daily_rollup (
  user_id      uuid not null references app_user(id) on delete cascade,
  day          date not null,
  active_min   integer not null default 0,
  kcal_out     numeric(8,2) not null default 0,
  kcal_in      numeric(8,2) not null default 0,
  macros       jsonb not null default '{}'::jsonb,
  entry_count  integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (user_id, day)
);

create or replace function refresh_daily_rollup(p_user uuid, p_day date)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  insert into daily_rollup (user_id, day, active_min, kcal_out, kcal_in, macros, entry_count, updated_at)
  select
    p_user,
    p_day,
    coalesce(sum(ad.duration_min), 0),
    coalesce(sum(ad.est_kcal), 0),
    coalesce(sum((fd.macros->>'kcal')::numeric), 0),
    jsonb_build_object(
      'protein_g', coalesce(sum((fd.macros->>'protein_g')::numeric), 0),
      'carb_g',    coalesce(sum((fd.macros->>'carb_g')::numeric), 0),
      'fat_g',     coalesce(sum((fd.macros->>'fat_g')::numeric), 0)
    ),
    count(distinct le.id),
    now()
  from log_entry le
  left join activity_detail ad on ad.entry_id = le.id
  left join food_detail     fd on fd.entry_id = le.id
  where le.user_id = p_user and le.local_day = p_day
  on conflict (user_id, day) do update set
    active_min  = excluded.active_min,
    kcal_out    = excluded.kcal_out,
    kcal_in     = excluded.kcal_in,
    macros      = excluded.macros,
    entry_count = excluded.entry_count,
    updated_at  = now();
end;
$$;

create or replace function trg_refresh_rollup()
returns trigger
language plpgsql
as $$
declare
  v_user uuid;
  v_day  date;
begin
  if tg_table_name = 'log_entry' then
    v_user := coalesce(new.user_id, old.user_id);
    v_day  := coalesce(new.local_day, old.local_day);
  else
    select le.user_id, le.local_day into v_user, v_day
    from log_entry le where le.id = coalesce(new.entry_id, old.entry_id);
  end if;

  if v_user is not null then
    perform refresh_daily_rollup(v_user, v_day);
  end if;
  return null;
end;
$$;

create trigger rollup_on_entry
  after insert or update or delete on log_entry
  for each row execute function trg_refresh_rollup();

create trigger rollup_on_activity
  after insert or update or delete on activity_detail
  for each row execute function trg_refresh_rollup();

create trigger rollup_on_food
  after insert or update or delete on food_detail
  for each row execute function trg_refresh_rollup();

-- ---------------------------------------------------------------
-- Row level security. Household members see each other, nobody else.
-- ---------------------------------------------------------------

alter table household        enable row level security;
alter table app_user         enable row level security;
alter table log_entry        enable row level security;
alter table activity_detail  enable row level security;
alter table food_detail      enable row level security;
alter table bodyweight_detail enable row level security;
alter table user_food        enable row level security;
alter table daily_rollup     enable row level security;
alter table parse_failure    enable row level security;

create policy household_self on household
  for select using (id = current_household_id());

create policy user_same_household on app_user
  for select using (household_id = current_household_id());

create policy user_update_self on app_user
  for update using (id = auth.uid());

create policy entry_own on log_entry
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy entry_household_read on log_entry
  for select using (
    user_id in (select id from app_user where household_id = current_household_id())
  );

create policy activity_via_entry on activity_detail
  for all using (entry_id in (select id from log_entry where user_id = auth.uid()))
  with check (entry_id in (select id from log_entry where user_id = auth.uid()));

create policy food_detail_via_entry on food_detail
  for all using (entry_id in (select id from log_entry where user_id = auth.uid()))
  with check (entry_id in (select id from log_entry where user_id = auth.uid()));

create policy bodyweight_via_entry on bodyweight_detail
  for all using (entry_id in (select id from log_entry where user_id = auth.uid()))
  with check (entry_id in (select id from log_entry where user_id = auth.uid()));

create policy user_food_own on user_food
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy rollup_household_read on daily_rollup
  for select using (
    user_id in (select id from app_user where household_id = current_household_id())
  );

create policy parse_failure_own on parse_failure
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Reference tables are readable by every signed in user, writable by service role only.
alter table food             enable row level security;
alter table activity_type    enable row level security;
alter table recipe_component enable row level security;
alter table portion_unit     enable row level security;

create policy food_read       on food             for select to authenticated using (true);
create policy activity_read   on activity_type    for select to authenticated using (true);
create policy recipe_read     on recipe_component for select to authenticated using (true);
create policy portion_read    on portion_unit     for select to authenticated using (true);

-- ---------------------------------------------------------------
-- Targets. Time versioned: never update a target in place, close the
-- old row and open a new one, so historical days stay answerable.
-- ---------------------------------------------------------------

create type target_metric     as enum ('kcal_in','protein_g','carb_g','fat_g','fibre_g','active_min','kcal_out','sessions');
create type target_comparator as enum ('at_least','at_most','around');

create table goal_target (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references app_user(id) on delete cascade,
  metric          target_metric not null,
  comparator      target_comparator not null default 'at_least',
  target_value    numeric(8,2) not null check (target_value >= 0),
  tolerance_pct   numeric(4,1) not null default 10,   -- only meaningful for 'around'
  effective_from  date not null default current_date,
  effective_to    date,                               -- null = still active
  created_at      timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

create unique index goal_target_one_active
  on goal_target (user_id, metric)
  where effective_to is null;

create index goal_target_lookup on goal_target (user_id, metric, effective_from);

-- Resolves every logged day against the target that was in force that day.
create or replace view daily_progress as
select
  r.user_id,
  r.day,
  t.metric,
  t.comparator,
  t.target_value,
  case t.metric
    when 'kcal_in'    then r.kcal_in
    when 'kcal_out'   then r.kcal_out
    when 'active_min' then r.active_min::numeric
    when 'protein_g'  then (r.macros->>'protein_g')::numeric
    when 'carb_g'     then (r.macros->>'carb_g')::numeric
    when 'fat_g'      then (r.macros->>'fat_g')::numeric
    when 'fibre_g'    then (r.macros->>'fibre_g')::numeric
    else null
  end as actual_value
from daily_rollup r
join goal_target t
  on t.user_id = r.user_id
 and r.day >= t.effective_from
 and (t.effective_to is null or r.day <= t.effective_to);

-- Registered devices. The kitchen tablet runs wake word, phones do not.
create table device (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references household(id) on delete cascade,
  label             text not null,
  is_always_on      boolean not null default false,
  wake_word_enabled boolean not null default false,
  default_user_id   uuid references app_user(id) on delete set null,
  last_seen_at      timestamptz
);

create index device_household on device (household_id);

-- Summary questions the query registry could not match. Same idea as
-- parse_failure: this list is the roadmap for which query to add next.
create table query_miss (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references app_user(id) on delete set null,
  transcript  text not null,
  candidates  jsonb,
  resolved    boolean not null default false,
  created_at  timestamptz not null default now()
);

alter table goal_target enable row level security;
alter table device      enable row level security;
alter table query_miss  enable row level security;

create policy goal_own on goal_target
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy goal_household_read on goal_target
  for select using (
    user_id in (select id from app_user where household_id = current_household_id())
  );

create policy device_household on device
  for all using (household_id = current_household_id())
  with check (household_id = current_household_id());

create policy query_miss_own on query_miss
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------
-- Seed: activity types
-- ---------------------------------------------------------------

insert into activity_type (key, label, met_value, aliases) values
  ('strength',     'Strength training', 5.0, array['weights','gym','lifting','strength training','resistance']),
  ('cardio',       'Cardio',            7.0, array['cardio','conditioning']),
  ('running',      'Running',           9.8, array['run','running','jog','jogging']),
  ('walking',      'Walking',           3.5, array['walk','walking','steps']),
  ('cycling',      'Cycling',           7.5, array['cycle','cycling','bike','biking']),
  ('swimming',     'Swimming',          8.0, array['swim','swimming']),
  ('yoga',         'Yoga',              3.0, array['yoga','stretching','mobility']),
  ('hiit',         'HIIT',             10.0, array['hiit','intervals','circuit']),
  ('sports',       'Sports',            7.0, array['badminton','football','cricket','tennis']),
  ('housework',    'Housework',         3.0, array['cleaning','chores','housework'])
on conflict (key) do nothing;

-- Global portion units. Food specific overrides go in portion_unit with food_id set.
insert into portion_unit (food_id, unit, grams) values
  (null, 'katori',  150),
  (null, 'bowl',    200),
  (null, 'glass',   240),
  (null, 'cup',     200),
  (null, 'plate',   300),
  (null, 'piece',    50),
  (null, 'tbsp',     15),
  (null, 'tsp',       5),
  (null, 'slice',    30)
on conflict (food_id, unit) do nothing;
