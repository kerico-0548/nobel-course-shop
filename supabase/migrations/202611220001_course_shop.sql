begin;
create schema if not exists course_shop;
revoke all on schema course_shop from public, anon, authenticated;
create table course_shop.packages (
 id text primary key, title text not null, description text not null,
 price integer not null check(price>0), active boolean not null default true
);
insert into course_shop.packages values
 ('start','Старт с Codex','Первый небольшой проект и понятный план практики',59000,true),
 ('site','Сайт своими руками','От идеи до страницы с работающими действиями',149000,true),
 ('practice','Больше практики','Тот же учебный канал и материалы для проверки всей цепочки',249000,true);
create table course_shop.orders (
 id uuid primary key, number bigint generated always as identity unique,
 package_id text not null references course_shop.packages(id), price integer not null,
 access_hash text not null, claim_hash text not null unique, ip_hash text not null,
 payment_state text not null default 'pending' check(payment_state in ('pending','paid','canceled')),
 access_state text not null default 'unlinked' check(access_state in ('unlinked','linked','invited','requested','approving','approved','declining','declined')),
 mode text not null default 'yookassa_test' check(mode in ('yookassa_test','robokassa_test')),
 provider_payment_id text unique, confirmation_url text,
 telegram_user bigint, invite_link text, invite_expires timestamptz,
 created_at timestamptz not null default now(), claim_expires timestamptz not null default now()+interval '1 day'
);
create index on course_shop.orders(telegram_user);
create index on course_shop.orders(ip_hash,created_at);
create table course_shop.updates(update_id bigint primary key, actor_id bigint not null, created_at timestamptz not null default now());
create table course_shop.outbox(
 id bigint generated always as identity primary key,effect_key text not null unique,
 kind text not null, data jsonb not null, state text not null default 'pending' check(state in ('pending','processing','sent','failed')),
 attempts integer not null default 0,lease uuid,leased_until timestamptz,next_attempt_at timestamptz not null default now(),error_code text,created_at timestamptz not null default now(),sent_at timestamptz
);
alter table course_shop.packages enable row level security;
alter table course_shop.orders enable row level security;
alter table course_shop.updates enable row level security;
alter table course_shop.outbox enable row level security;
revoke all on all tables in schema course_shop from public,anon,authenticated;
revoke all on all sequences in schema course_shop from public,anon,authenticated;
create function course_shop.queue(k text,typ text,d jsonb) returns void language sql set search_path=pg_catalog,course_shop as $$
 insert into course_shop.outbox(effect_key,kind,data) values(k,typ,d) on conflict(effect_key) do nothing;
$$;
create function course_shop.safe_order(o course_shop.orders) returns jsonb language sql stable set search_path=pg_catalog,course_shop as $$
 select jsonb_build_object('id',o.id,'number',o.number,'packageId',o.package_id,'price',o.price,'paymentState',o.payment_state,'accessState',o.access_state,'telegramBound',o.telegram_user is not null,'mode',o.mode);
$$;
create function course_shop.approved(o course_shop.orders) returns void language plpgsql set search_path=pg_catalog,course_shop as $$
begin
 if o.payment_state<>'paid' or o.telegram_user is null then return;end if;
 update course_shop.orders set access_state='approved' where id=o.id;
 perform course_shop.queue('welcome:'||o.id,'message',jsonb_build_object('chat',o.telegram_user,'text','Модератор открыл доступ. Отправляю два учебных файла с Яндекс Диска.'));
 perform course_shop.queue('material-v1:'||o.telegram_user||':txt','material',jsonb_build_object('chat',o.telegram_user,'order',o.id,'material','txt'));
 perform course_shop.queue('material-v1:'||o.telegram_user||':xlsx','material',jsonb_build_object('chat',o.telegram_user,'order',o.id,'material','xlsx'));
end $$;
create function public.cs_rpc(p_op text,p jsonb default '{}'::jsonb,p_admin bigint default 0,p_channel bigint default 0)
returns jsonb language plpgsql security definer set search_path=pg_catalog,course_shop as $$
declare o course_shop.orders;pk course_shop.packages; result jsonb;ev text;actor bigint;uid bigint;k text;j course_shop.outbox;lease_id uuid;
begin
 if p_op='catalog' then
  select jsonb_agg(jsonb_build_object('id',id,'title',title,'description',description,'price',price) order by price) into result from course_shop.packages where active;
  return coalesce(result,'[]'::jsonb);
 elsif p_op='create' then
  perform pg_advisory_xact_lock(hashtextextended(p->>'id',0));
  select * into o from course_shop.orders where id=(p->>'id')::uuid;
  if found then
   if o.package_id<>p->>'package' or o.access_hash<>p->>'accessHash' then return jsonb_build_object('error','conflict');end if;
   return course_shop.safe_order(o);
  end if;
  if (select count(*) from course_shop.orders where ip_hash=p->>'ipHash' and created_at>now()-interval '1 hour')>=10 or (select count(*) from course_shop.orders where created_at>now()-interval '1 day')>=500 then return jsonb_build_object('error','rate');end if;
  select * into pk from course_shop.packages where id=p->>'package' and active;
  if not found then return jsonb_build_object('error','package');end if;
  insert into course_shop.orders(id,package_id,price,access_hash,claim_hash,ip_hash,mode)
  values((p->>'id')::uuid,pk.id,pk.price,p->>'accessHash',p->>'claimHash',p->>'ipHash',coalesce(p->>'mode','yookassa_test')) returning * into o;
  return course_shop.safe_order(o);
 elsif p_op='get' then
  select * into o from course_shop.orders where id=(p->>'id')::uuid and access_hash=p->>'accessHash' for update;
  if not found then return jsonb_build_object('error','not_found');end if;
  return course_shop.safe_order(o);
 elsif p_op='payment_saved' then
  update course_shop.orders set provider_payment_id=p->>'paymentId',confirmation_url=p->>'confirmationUrl'
   where id=(p->>'id')::uuid and (provider_payment_id is null or provider_payment_id=p->>'paymentId') returning * into o;
  if not found then raise exception 'payment_conflict';end if;
  return course_shop.safe_order(o);
 elsif p_op='payment_lookup' then
  select to_jsonb(id) into result from course_shop.orders where provider_payment_id=p->>'paymentId';return result;
 elsif p_op='payment_update' then
  select * into o from course_shop.orders where id=(p->>'id')::uuid and provider_payment_id=p->>'paymentId' for update;
  if not found or (p->>'test')::boolean is distinct from true or (p->>'price')::integer<>o.price then raise exception 'payment_mismatch';end if;
  if p->>'status'='succeeded' then update course_shop.orders set payment_state='paid' where id=o.id returning * into o;
  elsif p->>'status'='canceled' and o.payment_state<>'paid' then update course_shop.orders set payment_state='canceled' where id=o.id returning * into o;end if;
  return course_shop.safe_order(o);
 elsif p_op='order_internal' then
  select * into o from course_shop.orders where id=(p->>'id')::uuid;
  if not found then return null;end if;
  return to_jsonb(o)-'access_hash'-'claim_hash'-'ip_hash';
 elsif p_op='event' then
  uid=(p->>'update')::bigint;actor=(p->>'actor')::bigint;ev=p->>'action';k='event:'||uid||':';
  if actor<>p_admin and (select count(*) from course_shop.updates where actor_id=actor and created_at>now()-interval '1 minute')>=30 then return jsonb_build_object('ok',true);end if;
  insert into course_shop.updates(update_id,actor_id) values(uid,actor) on conflict do nothing;
  if not found then return jsonb_build_object('ok',true);end if;
  if ev='id' then
   perform course_shop.queue(k||'id','message',jsonb_build_object('chat',actor,'text','Ваш Telegram ID: '||actor));
  elsif p_admin=0 or p_channel=0 then
   if coalesce((p->>'private')::boolean,false) then perform course_shop.queue(k||'setup','message',jsonb_build_object('chat',actor,'text','Бот ещё подключается. Попробуйте позже.'));end if;
  elsif ev='start' then
   select * into o from course_shop.orders where claim_hash=p->>'claimHash' for update;
   if o.id is null or o.payment_state<>'paid' or (o.telegram_user is null and o.claim_expires<now()) or (o.telegram_user is not null and o.telegram_user<>actor) then
    perform course_shop.queue(k||'denied','message',jsonb_build_object('chat',actor,'text','Ссылка не подходит или истекла. Откройте свою оплаченную учебную покупку на сайте.'));
   else
    update course_shop.orders set telegram_user=actor,access_state=case when access_state='unlinked' then 'linked' else access_state end where id=o.id;
    perform course_shop.queue(k||'access','access',jsonb_build_object('chat',actor,'order',o.id));
   end if;
  elsif ev='join' and (p->>'channel')::bigint=p_channel then
   select * into o from course_shop.orders where telegram_user=actor and payment_state='paid' and invite_link=p->>'invite' order by created_at desc limit 1 for update;
   if o.id is null and exists(select 1 from course_shop.orders where telegram_user=actor and payment_state='paid') and exists(select 1 from course_shop.outbox where kind='access' and state='processing' and (data->>'chat')::bigint=actor) then raise exception 'invite_mapping_pending';end if;
   if o.id is not null and o.access_state not in ('approved','approving') then
    update course_shop.orders set access_state='requested' where id=o.id;
    perform course_shop.queue(k||'moderation','moderation',jsonb_build_object('chat',p_admin,'user',actor,'order',o.id,'number',o.number,'package',o.package_id));
    perform course_shop.queue(k||'wait','message',jsonb_build_object('chat',actor,'text','Заявка на вступление отправлена модератору. Файлы придут после одобрения.'));
   else
    perform course_shop.queue(k||'unknown','message',jsonb_build_object('chat',p_admin,'text','Получена заявка без подходящего оплаченного заказа. Автоматического доступа и файлов нет. Проверьте её отдельно в канале.'));
   end if;
  elsif ev in ('approve','decline') and actor=p_admin then
   select * into o from course_shop.orders where id=(p->>'order')::uuid and payment_state='paid' for update;
   if o.id is not null and o.access_state='requested' then
    update course_shop.orders set access_state=case when ev='approve' then 'approving' else 'declining' end where id=o.id;
    perform course_shop.queue(k||'decision',ev,jsonb_build_object('chat',o.telegram_user,'order',o.id));
   else perform course_shop.queue(k||'done','message',jsonb_build_object('chat',p_admin,'text','Заявка уже обработана или не найдена.'));end if;
  elsif ev='member' and (p->>'channel')::bigint=p_channel and coalesce((p->>'member')::boolean,false) then
   for o in select * from course_shop.orders where telegram_user=actor and payment_state='paid' for update loop perform course_shop.approved(o);end loop;
  elsif ev in ('status','materials') then
   select * into o from course_shop.orders where telegram_user=actor and payment_state='paid' order by created_at desc limit 1;
   if o.id is not null then
    if ev='materials' and o.access_state='approved' then
     perform course_shop.queue(k||'txt','material',jsonb_build_object('chat',actor,'order',o.id,'material','txt'));
     perform course_shop.queue(k||'xlsx','material',jsonb_build_object('chat',actor,'order',o.id,'material','xlsx'));
    else perform course_shop.queue(k||'access','access',jsonb_build_object('chat',actor,'order',o.id));end if;
   else perform course_shop.queue(k||'none','message',jsonb_build_object('chat',actor,'text','У вас пока нет привязанной оплаченной учебной покупки. Начните на сайте.'));end if;
  elsif ev='requests' and actor=p_admin then
   select coalesce(jsonb_agg(q),'[]'::jsonb) into result from (select id,number,package_id,telegram_user from course_shop.orders where access_state='requested' and payment_state='paid' order by created_at limit 8) q;
   perform course_shop.queue(k||'list','requests',jsonb_build_object('chat',actor,'orders',result));
  elsif ev='retry' and actor=p_admin then
   update course_shop.outbox set state='pending',attempts=0,next_attempt_at=now(),leased_until=null,error_code=null where state='failed';
   perform course_shop.queue(k||'retry','message',jsonb_build_object('chat',actor,'text','Повтор ошибок поставлен в очередь. Уже отправленные файлы не затронуты.'));
  elsif coalesce((p->>'private')::boolean,false) then
   perform course_shop.queue(k||'help','message',jsonb_build_object('chat',actor,'text',case when actor=p_admin then 'Модерация: /requests. Повтор ошибок: /retry.' else 'Откройте покупку на сайте и перейдите по её ссылке. /status — доступ, /materials — повтор материалов после одобрения.' end));
  end if;
  return jsonb_build_object('ok',true);
 elsif p_op='invited' then
  select * into o from course_shop.orders where id=(p->>'id')::uuid and payment_state='paid' for update;
  if o.id is not null then
   update course_shop.orders set invite_link=p->>'link',invite_expires=to_timestamp((p->>'expires')::bigint),access_state=case when access_state in ('linked','invited','declined','approved') then 'invited' else access_state end where id=o.id;
   perform course_shop.queue('invite-message:'||(p->>'job'),'invite_message',jsonb_build_object('chat',o.telegram_user,'link',p->>'link','number',o.number));
  end if;
  return jsonb_build_object('ok',true);
 elsif p_op='approved' then
  select * into o from course_shop.orders where id=(p->>'id')::uuid for update;
  if o.id is not null then perform course_shop.approved(o);end if;
  return jsonb_build_object('ok',true);
 elsif p_op='declined' then
  update course_shop.orders set access_state='declined' where id=(p->>'id')::uuid and access_state<>'approved' returning * into o;
  if found then perform course_shop.queue('declined:'||(p->>'job'),'message',jsonb_build_object('chat',o.telegram_user,'text','Модератор отклонил заявку. Для повторной проверки используйте /status или обратитесь к организатору.'));end if;
  return jsonb_build_object('ok',true);
 elsif p_op='claim' then
  lease_id=gen_random_uuid();
  with rows as(select id from course_shop.outbox where state='pending' or (state='processing' and leased_until<now()) or (state='failed' and attempts<4 and next_attempt_at<=now()) order by id for update skip locked limit 8),
  claimed as(update course_shop.outbox set state='processing',attempts=attempts+1,lease=lease_id,leased_until=now()+interval '2 minutes' where id in(select id from rows) returning *) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) into result from claimed;
  return result;
 elsif p_op='sent' then
  update course_shop.outbox set state='sent',sent_at=now(),leased_until=null where id=(p->>'id')::bigint and lease=(p->>'lease')::uuid and state='processing';return jsonb_build_object('ok',true);
 elsif p_op='failed' then
  update course_shop.outbox set state='failed',error_code=left(p->>'error',80),next_attempt_at=now()+attempts*interval '30 seconds',leased_until=null where id=(p->>'id')::bigint and lease=(p->>'lease')::uuid and state='processing' returning * into j;
  if found and j.kind='material' and j.attempts=1 and p_admin<>0 then perform course_shop.queue('failure-notice:'||j.id,'message',jsonb_build_object('chat',p_admin,'text','Не удалось отправить один из материалов. Ошибка сохранена; автоматический повтор выполнит worker. Для ручного повтора: /retry.'));end if;
  return jsonb_build_object('ok',true);
 elsif p_op='summary' then
  return jsonb_build_object('pending',(select count(*) from course_shop.outbox where state in ('pending','processing')),'failed',(select count(*) from course_shop.outbox where state='failed'));
 end if;
 raise exception 'Unknown operation';
end $$;
revoke all on function public.cs_rpc(text,jsonb,bigint,bigint) from public,anon,authenticated;
grant execute on function public.cs_rpc(text,jsonb,bigint,bigint) to service_role;
revoke all on all functions in schema course_shop from public,anon,authenticated;
commit;
