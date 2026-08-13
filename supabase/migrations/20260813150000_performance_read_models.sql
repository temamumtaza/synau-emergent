-- Performance read models and transactional course mutations.
--
-- The Express server remains the only application client. These functions
-- reduce Data API round trips while keeping the user boundary explicit in
-- every call. Workspace reads intentionally omit lesson material unless the
-- caller names the lesson being opened.

create index if not exists lessons_section_completed_idx
  on public.lessons (section_id, completed_at);

create or replace function public.get_course_workspace_json(
  p_user_id text,
  p_course_id text,
  p_material_lesson_id text default null
) returns jsonb
language sql
stable
set search_path = public
as $function$
  select jsonb_build_object(
    'id', c.id,
    'topic', c.topic,
    'title', c.title,
    'description', c.description,
    'outcomes', c.outcomes_json,
    'status', c.status,
    'createdAt', c.created_at,
    'sections', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'title', s.title,
          'summary', s.summary,
          'position', s.position,
          'lessons', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', l.id,
                'sectionId', l.section_id,
                'title', l.title,
                'summary', l.summary,
                'estimatedMinutes', l.estimated_minutes,
                'position', l.position,
                'material', case
                  when p_material_lesson_id is not null and l.id = p_material_lesson_id
                    then l.material_json
                  else null
                end,
                'completedAt', l.completed_at
              )
              order by l.position
            )
            from public.lessons l
            where l.section_id = s.id
          ), '[]'::jsonb)
        )
        order by s.position
      )
      from public.course_sections s
      where s.course_id = c.id
    ), '[]'::jsonb),
    'progress', jsonb_build_object(
      'completedLessons', (
        select count(*)::integer
        from public.lessons l
        join public.course_sections s on s.id = l.section_id
        where s.course_id = c.id and l.completed_at is not null
      ),
      'totalLessons', (
        select count(*)::integer
        from public.lessons l
        join public.course_sections s on s.id = l.section_id
        where s.course_id = c.id
      ),
      'percent', case
        when (
          select count(*)
          from public.lessons l
          join public.course_sections s on s.id = l.section_id
          where s.course_id = c.id
        ) = 0 then 0
        else round((
          select count(*)::numeric
          from public.lessons l
          join public.course_sections s on s.id = l.section_id
          where s.course_id = c.id and l.completed_at is not null
        ) * 100 / (
          select count(*)::numeric
          from public.lessons l
          join public.course_sections s on s.id = l.section_id
          where s.course_id = c.id
        ))::integer
      end
    )
  )
  from public.courses c
  where c.id = p_course_id and c.user_id = p_user_id;
$function$;

create or replace function public.list_course_summaries(p_user_id text)
returns jsonb
language sql
stable
set search_path = public
as $function$
  select coalesce(
    jsonb_agg(public.get_course_workspace_json(p_user_id, c.id, null) order by c.updated_at desc),
    '[]'::jsonb
  )
  from public.courses c
  where c.user_id = p_user_id;
$function$;

create or replace function public.create_course_from_roadmap_v2(
  p_course_id text,
  p_user_id text,
  p_topic text,
  p_title text,
  p_description text,
  p_outcomes jsonb,
  p_sections jsonb
) returns jsonb
language plpgsql
set search_path = public
as $function$
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

  insert into public.progress_events (id, user_id, course_id, event_type, data_json)
  values (
    gen_random_uuid()::text, p_user_id, p_course_id, 'course_created',
    jsonb_build_object('topic', p_topic)
  );

  return public.get_course_workspace_json(p_user_id, p_course_id, null);
end;
$function$;

create or replace function public.update_course_and_event(
  p_user_id text,
  p_course_id text,
  p_title text default null,
  p_status text default null
) returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  current_course public.courses%rowtype;
  next_updated_at timestamptz := now();
begin
  select * into current_course
  from public.courses
  where id = p_course_id and user_id = p_user_id
  for update;

  if not found then
    return null;
  end if;
  if p_status is not null and p_status not in ('active', 'archived') then
    raise exception 'Invalid course status.' using errcode = '22023';
  end if;

  update public.courses
  set title = coalesce(p_title, title),
      status = coalesce(p_status, status),
      updated_at = next_updated_at
  where id = p_course_id and user_id = p_user_id;

  if p_title is not null and p_title is distinct from current_course.title then
    insert into public.progress_events (id, user_id, course_id, event_type, data_json)
    values (
      gen_random_uuid()::text, p_user_id, p_course_id, 'course_renamed',
      jsonb_build_object('from', current_course.title, 'to', p_title)
    );
  end if;
  if p_status is not null and p_status is distinct from current_course.status then
    insert into public.progress_events (id, user_id, course_id, event_type)
    values (
      gen_random_uuid()::text, p_user_id, p_course_id,
      case when p_status = 'archived' then 'course_archived' else 'course_reopened' end
    );
  end if;

  return public.get_course_workspace_json(p_user_id, p_course_id, null);
end;
$function$;

create or replace function public.delete_course_if_unlocked(
  p_user_id text,
  p_course_id text
) returns jsonb
language plpgsql
set search_path = public
as $function$
begin
  if not exists (
    select 1 from public.courses where id = p_course_id and user_id = p_user_id
  ) then
    return jsonb_build_object('deleted', false, 'locked', false, 'notFound', true);
  end if;
  if exists (
    select 1 from public.lesson_generation_locks
    where user_id = p_user_id and course_id = p_course_id
  ) then
    return jsonb_build_object('deleted', false, 'locked', true, 'notFound', false);
  end if;

  delete from public.courses where id = p_course_id and user_id = p_user_id;
  return jsonb_build_object('deleted', true, 'locked', false, 'notFound', false);
end;
$function$;

create or replace function public.complete_lesson_and_event(
  p_user_id text,
  p_course_id text,
  p_lesson_id text
) returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  current_course public.courses%rowtype;
  current_lesson public.lessons%rowtype;
  completed_at_value timestamptz := now();
begin
  select * into current_course
  from public.courses
  where id = p_course_id and user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if current_course.status = 'archived' then
    return jsonb_build_object('ok', false, 'code', 'archived');
  end if;

  select l.* into current_lesson
  from public.lessons l
  join public.course_sections s on s.id = l.section_id
  where l.id = p_lesson_id and s.course_id = p_course_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if current_lesson.completed_at is null then
    update public.lessons set completed_at = completed_at_value where id = p_lesson_id;
    update public.courses set updated_at = completed_at_value where id = p_course_id;
    insert into public.progress_events (id, user_id, course_id, lesson_id, event_type)
    values (gen_random_uuid()::text, p_user_id, p_course_id, p_lesson_id, 'lesson_completed');
  end if;

  return jsonb_build_object(
    'ok', true,
    'alreadyComplete', current_lesson.completed_at is not null,
    'course', public.get_course_workspace_json(p_user_id, p_course_id, null)
  );
end;
$function$;

create or replace function public.open_lesson_and_get_workspace(
  p_user_id text,
  p_course_id text,
  p_lesson_id text
) returns jsonb
language plpgsql
set search_path = public
as $function$
begin
  if not exists (
    select 1 from public.courses where id = p_course_id and user_id = p_user_id
  ) then
    return null;
  end if;
  if not exists (
    select 1
    from public.lessons l
    join public.course_sections s on s.id = l.section_id
    where l.id = p_lesson_id and s.course_id = p_course_id
  ) then
    return null;
  end if;

  insert into public.progress_events (id, user_id, course_id, lesson_id, event_type)
  values (gen_random_uuid()::text, p_user_id, p_course_id, p_lesson_id, 'lesson_opened');

  return public.get_course_workspace_json(p_user_id, p_course_id, p_lesson_id);
end;
$function$;

create or replace function public.get_course_memory_rows_json(p_user_id text, p_course_id text)
returns jsonb
language sql
stable
set search_path = public
as $function$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('title', rows.title, 'material', rows.material_json)
      order by rows.last_generated_at desc
    ),
    '[]'::jsonb
  )
  from (
    select l.title, l.material_json, l.last_generated_at
    from public.lessons l
    join public.course_sections s on s.id = l.section_id
    join public.courses c on c.id = s.course_id
    where c.id = p_course_id and c.user_id = p_user_id and l.material_json is not null
    order by l.last_generated_at desc
    limit 40
  ) rows;
$function$;

create or replace function public.get_course_context_json(
  p_user_id text,
  p_course_id text,
  p_scope text,
  p_scope_id text
) returns jsonb
language plpgsql
stable
set search_path = public
as $function$
declare
  current_course public.courses%rowtype;
  current_section public.course_sections%rowtype;
  current_lesson public.lessons%rowtype;
  context_rows jsonb;
begin
  select * into current_course
  from public.courses
  where id = p_course_id and user_id = p_user_id;
  if not found then
    return null;
  end if;

  if p_scope = 'lesson' then
    select l.* into current_lesson
    from public.lessons l
    join public.course_sections s on s.id = l.section_id
    where l.id = p_scope_id and s.course_id = p_course_id;
    if not found then return null; end if;
    return jsonb_build_object(
      'title', current_lesson.title,
      'description', null,
      'context', jsonb_build_array(jsonb_build_object(
        'summary', current_lesson.summary,
        'material', current_lesson.material_json
      ))
    );
  end if;

  if p_scope = 'chapter' then
    select * into current_section
    from public.course_sections
    where id = p_scope_id and course_id = p_course_id;
    if not found then return null; end if;
    select coalesce(
      jsonb_agg(
        jsonb_build_object('summary', l.summary, 'material', l.material_json)
        order by l.position
      ),
      '[]'::jsonb
    ) into context_rows
    from public.lessons l
    where l.section_id = p_scope_id;
    return jsonb_build_object('title', current_section.title, 'description', null, 'context', context_rows);
  end if;

  if p_scope = 'course' and p_scope_id = p_course_id then
    select coalesce(
      jsonb_agg(
        jsonb_build_object('summary', l.summary, 'material', l.material_json)
        order by s.position, l.position
      ),
      '[]'::jsonb
    ) into context_rows
    from public.lessons l
    join public.course_sections s on s.id = l.section_id
    where s.course_id = p_course_id;
    return jsonb_build_object(
      'title', current_course.title,
      'description', current_course.description,
      'context', context_rows
    );
  end if;

  return null;
end;
$function$;

revoke all on function public.get_course_workspace_json(text, text, text) from public, anon, authenticated;
revoke all on function public.list_course_summaries(text) from public, anon, authenticated;
revoke all on function public.create_course_from_roadmap_v2(text, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.update_course_and_event(text, text, text, text) from public, anon, authenticated;
revoke all on function public.delete_course_if_unlocked(text, text) from public, anon, authenticated;
revoke all on function public.complete_lesson_and_event(text, text, text) from public, anon, authenticated;
revoke all on function public.open_lesson_and_get_workspace(text, text, text) from public, anon, authenticated;
revoke all on function public.get_course_memory_rows_json(text, text) from public, anon, authenticated;
revoke all on function public.get_course_context_json(text, text, text, text) from public, anon, authenticated;

grant execute on function public.get_course_workspace_json(text, text, text) to service_role;
grant execute on function public.list_course_summaries(text) to service_role;
grant execute on function public.create_course_from_roadmap_v2(text, text, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.update_course_and_event(text, text, text, text) to service_role;
grant execute on function public.delete_course_if_unlocked(text, text) to service_role;
grant execute on function public.complete_lesson_and_event(text, text, text) to service_role;
grant execute on function public.open_lesson_and_get_workspace(text, text, text) to service_role;
grant execute on function public.get_course_memory_rows_json(text, text) to service_role;
grant execute on function public.get_course_context_json(text, text, text, text) to service_role;
