-- Synau core schema
--
-- The application server is the only database client in this architecture.
-- It uses the Supabase server secret and enforces the learner boundary before
-- each query. RLS is still enabled on every exposed table and anonymous/
-- authenticated Data API access is revoked so a future client cannot bypass
-- the server contract accidentally.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.users (
  id text primary key,
  email text not null,
  name text not null,
  first_name text not null,
  last_name text not null,
  username text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists users_email_lower_idx on public.users (lower(email));
create unique index if not exists users_username_lower_idx on public.users (lower(username));
alter table public.users add column if not exists auth_user_id uuid;
create unique index if not exists users_auth_user_id_idx on public.users (auth_user_id) where auth_user_id is not null;

create table if not exists public.sessions (
  token text primary key,
  user_id text not null references public.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_user_expires_idx on public.sessions (user_id, expires_at);

create table if not exists public.courses (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  topic text not null,
  title text not null,
  description text not null,
  outcomes_json jsonb not null default '[]'::jsonb,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists courses_user_updated_idx on public.courses (user_id, updated_at desc);

create table if not exists public.course_sections (
  id text primary key,
  course_id text not null references public.courses(id) on delete cascade,
  title text not null,
  summary text not null,
  position integer not null check (position >= 0)
);
create index if not exists course_sections_course_position_idx on public.course_sections (course_id, position);

create table if not exists public.lessons (
  id text primary key,
  section_id text not null references public.course_sections(id) on delete cascade,
  title text not null,
  summary text not null,
  estimated_minutes integer not null check (estimated_minutes > 0),
  position integer not null check (position >= 0),
  material_json jsonb,
  last_generated_at timestamptz,
  completed_at timestamptz
);
create index if not exists lessons_section_position_idx on public.lessons (section_id, position);

create table if not exists public.lesson_generation_locks (
  user_id text primary key references public.users(id) on delete cascade,
  course_id text not null references public.courses(id) on delete cascade,
  lesson_id text not null references public.lessons(id) on delete cascade,
  lesson_title text not null,
  created_at timestamptz not null default now()
);
create index if not exists lesson_generation_locks_course_idx on public.lesson_generation_locks (course_id, lesson_id);

create table if not exists public.quiz_attempts (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  course_id text not null references public.courses(id) on delete cascade,
  scope text not null check (scope in ('lesson', 'chapter', 'course')),
  scope_id text not null,
  quiz_json jsonb not null,
  score integer check (score is null or (score >= 0 and score <= 100)),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists quiz_attempts_user_course_idx on public.quiz_attempts (user_id, course_id, created_at desc);

create table if not exists public.progress_events (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  course_id text not null references public.courses(id) on delete cascade,
  lesson_id text references public.lessons(id) on delete set null,
  event_type text not null,
  data_json jsonb,
  created_at timestamptz not null default now()
);
create index if not exists progress_events_course_created_idx on public.progress_events (course_id, created_at desc);
create index if not exists progress_events_user_course_idx on public.progress_events (user_id, course_id, created_at desc);

create table if not exists public.credit_accounts (
  user_id text primary key references public.users(id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_ledger (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  type text not null check (type in ('grant', 'topup', 'hold', 'refund', 'usage', 'adjustment')),
  delta integer not null,
  reference_id text not null,
  description text not null,
  metadata_json jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, reference_id)
);
create index if not exists credit_ledger_user_created_idx on public.credit_ledger (user_id, created_at desc);

create table if not exists public.llm_usage (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  generation_id text not null unique,
  generator text not null,
  provider_id text not null,
  model text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  cached_input_tokens integer not null default 0 check (cached_input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  total_tokens integer not null default 0 check (total_tokens >= 0),
  request_count integer not null default 0 check (request_count >= 0),
  credit_cost integer not null default 0 check (credit_cost >= 0),
  status text not null check (status in ('success', 'failed')),
  metadata_json jsonb,
  created_at timestamptz not null default now()
);
create index if not exists llm_usage_user_created_idx on public.llm_usage (user_id, created_at desc);

create table if not exists public.credit_topups (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  order_id text not null unique,
  product_id text not null,
  credits integer not null check (credits > 0),
  amount_idr integer not null check (amount_idr > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'expired')),
  snap_token text,
  redirect_url text,
  midtrans_transaction_id text,
  payment_type text,
  raw_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists credit_topups_user_created_idx on public.credit_topups (user_id, created_at desc);

create table if not exists public.credit_promo_codes (
  id text primary key,
  token text not null unique,
  credits integer not null check (credits > 0),
  active boolean not null default true,
  max_redemptions integer not null default 1 check (max_redemptions > 0),
  redeemed_count integer not null default 0 check (redeemed_count >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.credit_promo_redemptions (
  id text primary key,
  promo_code_id text not null references public.credit_promo_codes(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  credits integer not null check (credits > 0),
  created_at timestamptz not null default now(),
  unique (promo_code_id, user_id)
);
create index if not exists credit_promo_redemptions_user_created_idx on public.credit_promo_redemptions (user_id, created_at desc);

create table if not exists public.auth_challenges (
  id text primary key,
  mode text not null check (mode in ('sign_in', 'sign_up')),
  identifier text not null,
  email text not null default '',
  first_name text not null default '',
  last_name text not null default '',
  username text not null default '',
  code_hash text not null,
  attempts integer not null default 0 check (attempts >= 0),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists auth_challenges_lookup_idx on public.auth_challenges (mode, identifier, created_at desc);

create or replace function public.create_course_from_roadmap(
  p_course_id text,
  p_user_id text,
  p_topic text,
  p_title text,
  p_description text,
  p_outcomes jsonb,
  p_sections jsonb
) returns void
language plpgsql
set search_path = public
as $$
declare
  section_record jsonb;
  lesson_record jsonb;
begin
  insert into public.courses (id, user_id, topic, title, description, outcomes_json)
  values (p_course_id, p_user_id, p_topic, p_title, p_description, p_outcomes);

  for section_record in select value from jsonb_array_elements(p_sections) loop
    insert into public.course_sections (id, course_id, title, summary, position)
    values (
      section_record->>'id', p_course_id, section_record->>'title',
      section_record->>'summary', (section_record->>'position')::integer
    );
    for lesson_record in select value from jsonb_array_elements(section_record->'lessons') loop
      insert into public.lessons (id, section_id, title, summary, estimated_minutes, position)
      values (
        lesson_record->>'id', section_record->>'id', lesson_record->>'title',
        lesson_record->>'summary', (lesson_record->>'estimated_minutes')::integer,
        (lesson_record->>'position')::integer
      );
    end loop;
  end loop;
end;
$$;

-- Use a short-lived database lock to make lesson generation single-flight
-- across multiple backend processes, not only inside one Node process.
create or replace function public.claim_lesson_generation_lock(
  p_user_id text,
  p_course_id text,
  p_lesson_id text,
  p_lesson_title text,
  p_stale_before timestamptz
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  existing_lock public.lesson_generation_locks%rowtype;
begin
  delete from public.lesson_generation_locks
   where user_id = p_user_id and created_at <= p_stale_before;

  insert into public.lesson_generation_locks (user_id, course_id, lesson_id, lesson_title)
  values (p_user_id, p_course_id, p_lesson_id, p_lesson_title)
  on conflict (user_id) do nothing;

  if found then
    return jsonb_build_object('acquired', true);
  end if;

  select * into existing_lock
    from public.lesson_generation_locks
   where user_id = p_user_id;
  return jsonb_build_object(
    'acquired', false,
    'lock', jsonb_build_object(
      'user_id', existing_lock.user_id,
      'course_id', existing_lock.course_id,
      'lesson_id', existing_lock.lesson_id,
      'lesson_title', existing_lock.lesson_title,
      'created_at', existing_lock.created_at
    )
  );
end;
$$;

create or replace function public.apply_credit_delta(
  p_user_id text,
  p_delta integer,
  p_type text,
  p_reference_id text,
  p_description text,
  p_metadata jsonb default null
) returns boolean
language plpgsql
set search_path = public
as $$
declare
  current_balance integer;
begin
  insert into public.credit_accounts (user_id, balance)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  if exists (
    select 1 from public.credit_ledger
     where user_id = p_user_id and reference_id = p_reference_id
  ) then
    return false;
  end if;

  select balance into current_balance
    from public.credit_accounts
   where user_id = p_user_id
   for update;

  if current_balance + p_delta < 0 then
    raise exception 'Not enough credits to run this generation.'
      using errcode = 'P0001', hint = 'insufficient_credits';
  end if;

  update public.credit_accounts
     set balance = current_balance + p_delta, updated_at = now()
   where user_id = p_user_id;

  insert into public.credit_ledger
    (id, user_id, type, delta, reference_id, description, metadata_json)
  values
    (gen_random_uuid()::text, p_user_id, p_type, p_delta, p_reference_id, p_description, p_metadata);
  return true;
end;
$$;

create or replace function public.record_llm_usage(
  p_id text,
  p_user_id text,
  p_generation_id text,
  p_generator text,
  p_provider_id text,
  p_model text,
  p_input_tokens integer,
  p_cached_input_tokens integer,
  p_output_tokens integer,
  p_total_tokens integer,
  p_request_count integer,
  p_credit_cost integer,
  p_status text,
  p_hold_credits integer,
  p_metadata jsonb
) returns boolean
language plpgsql
set search_path = public
as $$
declare
  settled_cost integer;
  refund integer;
begin
  if exists (select 1 from public.llm_usage where generation_id = p_generation_id) then
    return false;
  end if;

  settled_cost := least(case when p_status = 'success' then p_credit_cost else 0 end, p_hold_credits);
  refund := p_hold_credits - settled_cost;
  if refund > 0 then
    perform public.apply_credit_delta(
      p_user_id,
      refund,
      'refund',
      'llm:' || p_generation_id || ':refund',
      case when p_status = 'success' then 'Unused generation credit hold returned' else 'Failed generation credit hold returned' end,
      p_metadata
    );
  end if;

  insert into public.llm_usage
    (id, user_id, generation_id, generator, provider_id, model, input_tokens,
     cached_input_tokens, output_tokens, total_tokens, request_count, credit_cost,
     status, metadata_json)
  values
    (p_id, p_user_id, p_generation_id, p_generator, p_provider_id, p_model,
     greatest(p_input_tokens, 0), greatest(p_cached_input_tokens, 0),
     greatest(p_output_tokens, 0), greatest(p_total_tokens, 0),
     greatest(p_request_count, 0), settled_cost, p_status, p_metadata);
  return true;
end;
$$;

-- Do not expose application tables to browser roles. The backend uses the
-- server secret, while the application-level auth boundary remains in Express.
alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.courses enable row level security;
alter table public.course_sections enable row level security;
alter table public.lessons enable row level security;
alter table public.lesson_generation_locks enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.progress_events enable row level security;
alter table public.credit_accounts enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.llm_usage enable row level security;
alter table public.credit_topups enable row level security;
alter table public.auth_challenges enable row level security;

revoke all on table
  public.users,
  public.sessions,
  public.courses,
  public.course_sections,
  public.lessons,
  public.lesson_generation_locks,
  public.quiz_attempts,
  public.progress_events,
  public.credit_accounts,
  public.credit_ledger,
  public.llm_usage,
  public.credit_topups,
  public.auth_challenges
from anon, authenticated;

grant usage on schema public to service_role;
grant all on table
  public.users,
  public.sessions,
  public.courses,
  public.course_sections,
  public.lessons,
  public.lesson_generation_locks,
  public.quiz_attempts,
  public.progress_events,
  public.credit_accounts,
  public.credit_ledger,
  public.llm_usage,
  public.credit_topups,
  public.auth_challenges
to service_role;

revoke all on function public.claim_lesson_generation_lock(text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.create_course_from_roadmap(text, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.apply_credit_delta(text, integer, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.record_llm_usage(text, text, text, text, text, text, integer, integer, integer, integer, integer, integer, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.claim_lesson_generation_lock(text, text, text, text, timestamptz) to service_role;
grant execute on function public.create_course_from_roadmap(text, text, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.apply_credit_delta(text, integer, text, text, text, jsonb) to service_role;
grant execute on function public.record_llm_usage(text, text, text, text, text, text, integer, integer, integer, integer, integer, integer, text, integer, jsonb) to service_role;
