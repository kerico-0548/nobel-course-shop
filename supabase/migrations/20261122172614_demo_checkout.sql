begin;

alter table course_shop.orders drop constraint orders_mode_check;
alter table course_shop.orders add constraint orders_mode_check
  check (mode in ('yookassa_test', 'robokassa_test', 'demo'));

-- Only the shop backend can settle a demo order. The order capability is
-- checked under the same lock as the state change so retries are safe.
create function public.cs_demo_decide(p_order uuid, p_access_hash text, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, course_shop
as $$
declare
  purchase course_shop.orders;
begin
  if p_outcome is null or p_outcome not in ('paid', 'canceled') then
    raise exception 'invalid_demo_outcome';
  end if;

  select * into purchase
    from course_shop.orders
    where id = p_order and access_hash = p_access_hash and mode = 'demo'
    for update;

  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  if purchase.payment_state = 'pending' then
    update course_shop.orders
      set payment_state = p_outcome
      where id = purchase.id
      returning * into purchase;
  elsif purchase.payment_state <> p_outcome then
    return jsonb_build_object('error', 'settled');
  end if;

  return course_shop.safe_order(purchase);
end;
$$;

revoke all on function public.cs_demo_decide(uuid, text, text) from public, anon, authenticated;
grant execute on function public.cs_demo_decide(uuid, text, text) to service_role;

commit;
