-- TaskMap v1.3 Sync Workspaces.
-- Browser clients never query these workspace tables directly. RLS + revoked grants deny anon/authenticated access;
-- the taskmap-workspace Edge Function validates TM1 Sync Keys and uses service_role as the broker.

create table if not exists public.sync_workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  recovery_email_hash text null,
  recovery_email_hint text null,
  recovery_email_verified_at timestamptz null,
  pending_recovery_email_hash text null,
  pending_recovery_email_hint text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_workspace_keys (
  workspace_id uuid not null references public.sync_workspaces(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  key_hash text not null,
  role text not null default 'owner' check (role in ('owner','editor','viewer')),
  label text not null default 'Primary key' check (char_length(label) between 1 and 80),
  created_at timestamptz not null default now(),
  last_used_at timestamptz null,
  revoked_at timestamptz null,
  primary key (workspace_id,id), unique(id)
);

create table if not exists public.workspace_sync_entities (
  workspace_id uuid not null references public.sync_workspaces(id) on delete cascade,
  entity_type text not null check (entity_type in ('task','task_layout','project','task_category','dev_backlog','task_template')),
  entity_id uuid not null, payload jsonb, is_deleted boolean not null default false,
  revision bigint not null default 0, updated_at timestamptz not null default now(),
  primary key (workspace_id,entity_type,entity_id)
);

create table if not exists public.workspace_transactions (
  workspace_id uuid not null references public.sync_workspaces(id) on delete cascade,
  id uuid not null, entity_type text not null check (entity_type in ('task','task_layout','project','task_category','dev_backlog','task_template')),
  entity_id uuid not null, action_type text not null, group_id uuid null, device_id uuid not null,
  client_timestamp timestamptz not null, server_received_timestamp timestamptz not null default now(),
  base_revision bigint not null, result_revision bigint not null,
  primary key (workspace_id,id)
);

create table if not exists public.workspace_transaction_changes (
  workspace_id uuid not null, id uuid not null, transaction_id uuid not null, field_name text not null,
  old_value jsonb, new_value jsonb, primary key (workspace_id,id),
  foreign key (workspace_id,transaction_id) references public.workspace_transactions(workspace_id,id) on delete cascade
);

create table if not exists public.workspace_entity_field_versions (
  workspace_id uuid not null, entity_type text not null, entity_id uuid not null, field_name text not null,
  winning_client_timestamp timestamptz not null, winning_transaction_id uuid not null, winning_device_id uuid not null,
  primary key (workspace_id,entity_type,entity_id,field_name),
  foreign key (workspace_id,winning_transaction_id) references public.workspace_transactions(workspace_id,id) on delete cascade
);

create table if not exists public.workspace_devices (
  workspace_id uuid not null references public.sync_workspaces(id) on delete cascade,
  id uuid not null, name text not null default 'TaskMap device', created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(), last_pull_at timestamptz null,
  primary key (workspace_id,id)
);

create index if not exists sync_workspace_keys_lookup_idx on public.sync_workspace_keys(id) where revoked_at is null;
create index if not exists sync_workspace_recovery_idx on public.sync_workspaces(recovery_email_hash) where recovery_email_verified_at is not null;
create index if not exists workspace_sync_entities_updated_idx on public.workspace_sync_entities(workspace_id,updated_at,entity_type,entity_id);
create index if not exists workspace_transactions_server_idx on public.workspace_transactions(workspace_id,server_received_timestamp,id);
create index if not exists workspace_transactions_entity_idx on public.workspace_transactions(workspace_id,entity_type,entity_id,client_timestamp);
create index if not exists workspace_changes_tx_idx on public.workspace_transaction_changes(workspace_id,transaction_id);
create index if not exists workspace_field_winner_idx on public.workspace_entity_field_versions(workspace_id,winning_transaction_id);
create index if not exists workspace_devices_seen_idx on public.workspace_devices(workspace_id,last_seen_at);

alter table public.sync_workspaces enable row level security;
alter table public.sync_workspace_keys enable row level security;
alter table public.workspace_sync_entities enable row level security;
alter table public.workspace_transactions enable row level security;
alter table public.workspace_transaction_changes enable row level security;
alter table public.workspace_entity_field_versions enable row level security;
alter table public.workspace_devices enable row level security;

revoke all on table public.sync_workspaces, public.sync_workspace_keys, public.workspace_sync_entities,
  public.workspace_transactions, public.workspace_transaction_changes, public.workspace_entity_field_versions,
  public.workspace_devices from anon, authenticated;
grant select, insert, update, delete on table public.sync_workspaces, public.sync_workspace_keys, public.workspace_sync_entities,
  public.workspace_transactions, public.workspace_transaction_changes, public.workspace_entity_field_versions,
  public.workspace_devices to service_role;

drop policy if exists sync_workspaces_deny_clients on public.sync_workspaces;
create policy sync_workspaces_deny_clients on public.sync_workspaces for all to anon, authenticated using (false) with check (false);
drop policy if exists sync_workspace_keys_deny_clients on public.sync_workspace_keys;
create policy sync_workspace_keys_deny_clients on public.sync_workspace_keys for all to anon, authenticated using (false) with check (false);
drop policy if exists workspace_sync_entities_deny_clients on public.workspace_sync_entities;
create policy workspace_sync_entities_deny_clients on public.workspace_sync_entities for all to anon, authenticated using (false) with check (false);
drop policy if exists workspace_transactions_deny_clients on public.workspace_transactions;
create policy workspace_transactions_deny_clients on public.workspace_transactions for all to anon, authenticated using (false) with check (false);
drop policy if exists workspace_transaction_changes_deny_clients on public.workspace_transaction_changes;
create policy workspace_transaction_changes_deny_clients on public.workspace_transaction_changes for all to anon, authenticated using (false) with check (false);
drop policy if exists workspace_entity_field_versions_deny_clients on public.workspace_entity_field_versions;
create policy workspace_entity_field_versions_deny_clients on public.workspace_entity_field_versions for all to anon, authenticated using (false) with check (false);
drop policy if exists workspace_devices_deny_clients on public.workspace_devices;
create policy workspace_devices_deny_clients on public.workspace_devices for all to anon, authenticated using (false) with check (false);

create or replace function public.apply_taskmap_workspace_transaction(p_workspace_id uuid, p_transaction jsonb, p_changes jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tx uuid := (p_transaction->>'id')::uuid;
  v_entity_type text := p_transaction->>'entityType';
  v_entity_id uuid := (p_transaction->>'entityId')::uuid;
  v_action text := p_transaction->>'actionType';
  v_group uuid := nullif(p_transaction->>'groupId','')::uuid;
  v_device uuid := (p_transaction->>'deviceId')::uuid;
  v_client timestamptz := (p_transaction->>'clientTimestamp')::timestamptz;
  v_base bigint := coalesce((p_transaction->>'baseRevision')::bigint,0);
  v_result bigint := coalesce((p_transaction->>'resultRevision')::bigint,v_base+1);
  v_change jsonb; v_field text; v_old jsonb; v_new jsonb; v_change_id uuid;
  v_winner_ts timestamptz; v_winner_tx uuid; v_should_apply boolean; v_payload jsonb; v_is_deleted boolean;
begin
  if not exists(select 1 from public.sync_workspaces where id=p_workspace_id) then raise exception 'workspace not found'; end if;
  if v_entity_type not in ('task','task_layout','project','task_category','dev_backlog','task_template') then raise exception 'invalid entity type'; end if;
  insert into public.workspace_transactions(workspace_id,id,entity_type,entity_id,action_type,group_id,device_id,client_timestamp,base_revision,result_revision)
  values(p_workspace_id,v_tx,v_entity_type,v_entity_id,v_action,v_group,v_device,v_client,v_base,v_result)
  on conflict (workspace_id,id) do nothing;
  insert into public.workspace_sync_entities(workspace_id,entity_type,entity_id,payload,is_deleted,revision,updated_at)
  values(p_workspace_id,v_entity_type,v_entity_id,'{}'::jsonb,false,0,v_client)
  on conflict (workspace_id,entity_type,entity_id) do nothing;
  for v_change in select value from jsonb_array_elements(coalesce(p_changes,'[]'::jsonb)) loop
    v_change_id := (v_change->>'id')::uuid; v_field := v_change->>'fieldName'; v_old := v_change->'oldValue'; v_new := v_change->'newValue';
    insert into public.workspace_transaction_changes(workspace_id,id,transaction_id,field_name,old_value,new_value)
    values(p_workspace_id,v_change_id,v_tx,v_field,v_old,v_new) on conflict (workspace_id,id) do nothing;
    select winning_client_timestamp,winning_transaction_id into v_winner_ts,v_winner_tx
      from public.workspace_entity_field_versions
      where workspace_id=p_workspace_id and entity_type=v_entity_type and entity_id=v_entity_id and field_name=v_field;
    v_should_apply := v_winner_ts is null or v_client > v_winner_ts or (v_client = v_winner_ts and v_tx::text > v_winner_tx::text);
    if v_should_apply then
      select payload,is_deleted into v_payload,v_is_deleted from public.workspace_sync_entities
        where workspace_id=p_workspace_id and entity_type=v_entity_type and entity_id=v_entity_id for update;
      if v_field='__entity__' then
        if v_new is null or v_new='null'::jsonb then v_payload:=null; v_is_deleted:=true; else v_payload:=v_new; v_is_deleted:=false; end if;
      else
        if v_payload is null then v_payload:='{}'::jsonb; end if;
        v_payload:=jsonb_set(v_payload,array[v_field],coalesce(v_new,'null'::jsonb),true);
        if v_field in ('deletedAt','purgedAt') then v_is_deleted:=coalesce((v_payload->>'purgedAt') is not null or (v_payload->>'deletedAt') is not null,false); end if;
      end if;
      update public.workspace_sync_entities set payload=v_payload,is_deleted=v_is_deleted,revision=greatest(revision,v_result),updated_at=greatest(updated_at,v_client)
        where workspace_id=p_workspace_id and entity_type=v_entity_type and entity_id=v_entity_id;
      insert into public.workspace_entity_field_versions(workspace_id,entity_type,entity_id,field_name,winning_client_timestamp,winning_transaction_id,winning_device_id)
      values(p_workspace_id,v_entity_type,v_entity_id,v_field,v_client,v_tx,v_device)
      on conflict (workspace_id,entity_type,entity_id,field_name) do update set
        winning_client_timestamp=excluded.winning_client_timestamp,winning_transaction_id=excluded.winning_transaction_id,winning_device_id=excluded.winning_device_id;
    end if;
  end loop;
  return jsonb_build_object('transactionId',v_tx,'serverReceivedAt',now());
end;
$$;
revoke all on function public.apply_taskmap_workspace_transaction(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.apply_taskmap_workspace_transaction(uuid,jsonb,jsonb) to service_role;
