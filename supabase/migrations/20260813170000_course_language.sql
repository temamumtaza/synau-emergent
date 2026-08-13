-- Persist the learner's chosen roadmap language through the course lifecycle.

alter table public.courses
  add column if not exists language text not null default 'en';

do $block$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'courses_language_check'
      and conrelid = 'public.courses'::regclass
  ) then
    alter table public.courses
      add constraint courses_language_check check (language in ('en', 'id'));
  end if;
end
$block$;

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
    'language', c.language,
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

create or replace function public.create_course_from_roadmap_v3(
  p_course_id text,
  p_user_id text,
  p_topic text,
  p_title text,
  p_description text,
  p_outcomes jsonb,
  p_sections jsonb,
  p_language text
) returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  section_record jsonb;
  lesson_record jsonb;
begin
  if p_language not in ('en', 'id') then
    raise exception 'Invalid course language.' using errcode = '22023';
  end if;

  insert into public.courses (id, user_id, topic, language, title, description, outcomes_json)
  values (p_course_id, p_user_id, p_topic, p_language, p_title, p_description, p_outcomes);

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
    jsonb_build_object('topic', p_topic, 'language', p_language)
  );

  return public.get_course_workspace_json(p_user_id, p_course_id, null);
end;
$function$;

revoke all on function public.create_course_from_roadmap_v3(text, text, text, text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.create_course_from_roadmap_v3(text, text, text, text, text, jsonb, jsonb, text) to service_role;
