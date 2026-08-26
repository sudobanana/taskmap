-- TaskMap v1.2 cloud sync schema.
-- The app uses sync_entities + immutable transactions as the authoritative cloud sync layer.
create extension if not exists pgcrypto;

create table if not exists public.transactions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('task','task_layout','project','task_category','dev_backlog','task_template')),
  entity_id uuid not null,
  action_type text not null,
  group_id uuid null,
  device_id uuid not null,
  client_timestamp timestamptz not null,
  server_received_timestamp timestamptz not null default now(),
  base_revision bigint not null,
  result_revision bigint not null,
  sync_status text not null default 'synced' check (sync_status in ('pending','synced','conflict'))
);

create table if not exists public.transaction_changes (
  id uuid primary key,
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  field_name text not null,
  old_value jsonb,
  new_value jsonb
);

create table if not exists public.entity_field_versions (
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  field_name text not null,
  winning_client_timestamp timestamptz not null,
  winning_transaction_id uuid not null references public.transactions(id) on delete cascade,
  winning_device_id uuid not null,
  primary key (user_id, entity_type, entity_id, field_name)
);

create table if not exists public.sync_entities (
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('task','task_layout','project','task_category','dev_backlog','task_template')),
  entity_id uuid not null,
  payload jsonb,
  is_deleted boolean not null default false,
  revision bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id)
);

create table if not exists public.devices (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'TaskMap device',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_pull_at timestamptz null
);

create index if not exists sync_entities_user_updated_idx on public.sync_entities(user_id, updated_at, entity_type, entity_id);
create index if not exists transactions_user_server_idx on public.transactions(user_id, server_received_timestamp, id);
create index if not exists transactions_entity_idx on public.transactions(user_id, entity_type, entity_id, client_timestamp);
create index if not exists transaction_changes_tx_idx on public.transaction_changes(transaction_id);
create index if not exists entity_field_versions_winning_tx_idx on public.entity_field_versions(winning_transaction_id);
create index if not exists devices_user_seen_idx on public.devices(user_id, last_seen_at);

alter table public.transactions enable row level security;
alter table public.transaction_changes enable row level security;
alter table public.entity_field_versions enable row level security;
alter table public.sync_entities enable row level security;
alter table public.devices enable row level security;

create policy transactions_owner_all on public.transactions for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy transaction_changes_owner_select on public.transaction_changes for select to authenticated
  using (exists (select 1 from public.transactions t where t.id = transaction_id and t.user_id = (select auth.uid())));
create policy transaction_changes_owner_insert on public.transaction_changes for insert to authenticated
  with check (exists (select 1 from public.transactions t where t.id = transaction_id and t.user_id = (select auth.uid())));
create policy transaction_changes_owner_delete on public.transaction_changes for delete to authenticated
  using (exists (select 1 from public.transactions t where t.id = transaction_id and t.user_id = (select auth.uid())));
create policy field_versions_owner_all on public.entity_field_versions for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy sync_entities_owner_all on public.sync_entities for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy devices_owner_all on public.devices for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.transactions, public.transaction_changes, public.entity_field_versions, public.sync_entities, public.devices to authenticated;

create or replace function public.apply_taskmap_transaction(p_transaction jsonb, p_changes jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := (select auth.uid());
  v_tx uuid := (p_transaction->>'id')::uuid;
  v_entity_type text := p_transaction->>'entityType';
  v_entity_id uuid := (p_transaction->>'entityId')::uuid;
  v_action text := p_transaction->>'actionType';
  v_group uuid := nullif(p_transaction->>'groupId','')::uuid;
  v_device uuid := (p_transaction->>'deviceId')::uuid;
  v_client timestamptz := (p_transaction->>'clientTimestamp')::timestamptz;
  v_base bigint := coalesce((p_transaction->>'baseRevision')::bigint,0);
  v_result bigint := coalesce((p_transaction->>'resultRevision')::bigint,v_base+1);
  v_change jsonb;
  v_field text;
  v_old jsonb;
  v_new jsonb;
  v_change_id uuid;
  v_winner_ts timestamptz;
  v_winner_tx uuid;
  v_should_apply boolean;
  v_payload jsonb;
  v_is_deleted boolean;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if v_entity_type not in ('task','task_layout','project','task_category','dev_backlog','task_template') then raise exception 'invalid entity type'; end if;

  insert into public.transactions(id,user_id,entity_type,entity_id,action_type,group_id,device_id,client_timestamp,base_revision,result_revision,sync_status)
  values(v_tx,v_user,v_entity_type,v_entity_id,v_action,v_group,v_device,v_client,v_base,v_result,'synced')
  on conflict (id) do nothing;

  insert into public.sync_entities(user_id,entity_type,entity_id,payload,is_deleted,revision,updated_at)
  values(v_user,v_entity_type,v_entity_id,'{}'::jsonb,false,0,v_client)
  on conflict (user_id,entity_type,entity_id) do nothing;

  for v_change in select value from jsonb_array_elements(coalesce(p_changes,'[]'::jsonb)) loop
    v_change_id := (v_change->>'id')::uuid;
    v_field := v_change->>'fieldName';
    v_old := v_change->'oldValue';
    v_new := v_change->'newValue';

    insert into public.transaction_changes(id,transaction_id,field_name,old_value,new_value)
    values(v_change_id,v_tx,v_field,v_old,v_new)
    on conflict (id) do nothing;

    select winning_client_timestamp, winning_transaction_id into v_winner_ts, v_winner_tx
    from public.entity_field_versions
    where user_id=v_user and entity_type=v_entity_type and entity_id=v_entity_id and field_name=v_field;

    v_should_apply := v_winner_ts is null or v_client > v_winner_ts or (v_client = v_winner_ts and v_tx::text > v_winner_tx::text);

    if v_should_apply then
      select payload, is_deleted into v_payload, v_is_deleted
      from public.sync_entities
      where user_id=v_user and entity_type=v_entity_type and entity_id=v_entity_id
      for update;

      if v_field = '__entity__' then
        if v_new is null or v_new = 'null'::jsonb then v_payload := null; v_is_deleted := true;
        else v_payload := v_new; v_is_deleted := false; end if;
      else
        if v_payload is null then v_payload := '{}'::jsonb; end if;
        v_payload := jsonb_set(v_payload, array[v_field], coalesce(v_new,'null'::jsonb), true);
        if v_field in ('deletedAt','purgedAt') then
          v_is_deleted := coalesce((v_payload->>'purgedAt') is not null or (v_payload->>'deletedAt') is not null,false);
        end if;
      end if;

      update public.sync_entities set payload=v_payload,is_deleted=v_is_deleted,revision=greatest(revision,v_result),updated_at=greatest(updated_at,v_client)
      where user_id=v_user and entity_type=v_entity_type and entity_id=v_entity_id;

      insert into public.entity_field_versions(user_id,entity_type,entity_id,field_name,winning_client_timestamp,winning_transaction_id,winning_device_id)
      values(v_user,v_entity_type,v_entity_id,v_field,v_client,v_tx,v_device)
      on conflict (user_id,entity_type,entity_id,field_name) do update set
        winning_client_timestamp=excluded.winning_client_timestamp,
        winning_transaction_id=excluded.winning_transaction_id,
        winning_device_id=excluded.winning_device_id;
    end if;
  end loop;

  return jsonb_build_object('transactionId',v_tx,'serverReceivedAt',now());
end;
$$;

revoke all on function public.apply_taskmap_transaction(jsonb,jsonb) from public;
grant execute on function public.apply_taskmap_transaction(jsonb,jsonb) to authenticated;
