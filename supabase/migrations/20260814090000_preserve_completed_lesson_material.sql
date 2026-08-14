-- Keep the lesson that was just completed in the returned workspace.
-- The normal course list still omits all material; only this selected lesson
-- is included so the learner does not lose the article after marking it done.
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
    'course', public.get_course_workspace_json(p_user_id, p_course_id, p_lesson_id)
  );
end;
$function$;
