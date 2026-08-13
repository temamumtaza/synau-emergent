-- Keep the frequently rendered credit wallet on one Data API round trip.
-- Stale-hold recovery and promo-code maintenance belong to mutation paths,
-- not to every dashboard balance read.

create or replace function public.get_credit_summary_json(p_user_id text)
returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  current_balance integer;
  recent_rows jsonb;
begin
  insert into public.credit_accounts (user_id, balance)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  select balance into current_balance
  from public.credit_accounts
  where user_id = p_user_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', ledger.id,
        'type', ledger.type,
        'delta', ledger.delta,
        'description', ledger.description,
        'createdAt', ledger.created_at
      ) order by ledger.created_at desc
    ),
    '[]'::jsonb
  ) into recent_rows
  from (
    select id, type, delta, description, created_at
    from public.credit_ledger
    where user_id = p_user_id
    order by created_at desc
    limit 20
  ) ledger;

  return jsonb_build_object(
    'balance', coalesce(current_balance, 0),
    'recentTransactions', recent_rows
  );
end;
$function$;

revoke all on function public.get_credit_summary_json(text) from public, anon, authenticated;
grant execute on function public.get_credit_summary_json(text) to service_role;
