-- Cloud schema target for TaskMap's local-first sync model.
-- The current test build runs from IndexedDB; these tables mirror the local model.
create extension if not exists pgcrypto;

create table if not exists projects (
  id uuid primary key,
  user_id uuid not null,
  name text not null,
  color text not null default '#5B5BD6',
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists task_categories (
  id uuid primary key,
  user_id uuid not null,
  name text not null,
  rule text not null,
  color text not null default '#5B5BD6',
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists tasks (
  id uuid primary key,
  user_id uuid not null,
  title text not null,
  notes text not null default '',
  tags text[] not null default '{}',
  status text not null,
  priority text not null,
  project_id uuid null references projects(id),
  parent_task_id uuid null references tasks(id),
  auto_completed_by_parent_id uuid null references tasks(id),
  start_date date null,
  start_time time null,
  estimated_minutes integer null check (estimated_minutes is null or estimated_minutes >= 0),
  due_date date null,
  due_time time null,
  manual_order double precision not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz null,
  deleted_at timestamptz null,
  revision bigint not null default 1
);


create table if not exists dev_backlog (
  id uuid primary key,
  user_id uuid not null,
  title text not null,
  details text not null default '',
  kind text not null,
  status text not null default 'open',
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists task_layouts (
  task_id uuid primary key references tasks(id),
  x double precision not null,
  y double precision not null,
  collapsed boolean not null default false,
  updated_at timestamptz not null
);

create table if not exists transactions (
  id uuid primary key,
  user_id uuid not null,
  entity_type text not null,
  entity_id uuid not null,
  action_type text not null,
  group_id uuid null,
  device_id uuid not null,
  client_timestamp timestamptz not null,
  server_received_timestamp timestamptz not null default now(),
  base_revision bigint not null,
  result_revision bigint not null,
  sync_status text not null default 'synced'
);

create table if not exists transaction_changes (
  id uuid primary key,
  transaction_id uuid not null references transactions(id) on delete cascade,
  field_name text not null,
  old_value jsonb,
  new_value jsonb
);

create index if not exists tasks_user_due_idx on tasks(user_id, due_date) where deleted_at is null;
create index if not exists tasks_user_manual_idx on tasks(user_id, manual_order) where deleted_at is null;
create index if not exists projects_user_name_idx on projects(user_id, name);
create index if not exists task_categories_user_name_idx on task_categories(user_id, name);
create index if not exists dev_backlog_user_status_idx on dev_backlog(user_id, status, created_at);
create index if not exists transactions_entity_idx on transactions(entity_type, entity_id, client_timestamp);
create index if not exists transaction_changes_tx_idx on transaction_changes(transaction_id);

-- Field-level winning metadata makes concurrent changes merge independently.
-- The sync API compares client timestamps for the same entity+field and uses
-- transaction/device IDs as deterministic tie-breakers when timestamps match.
create table if not exists entity_field_versions (
  user_id uuid not null,
  entity_type text not null,
  entity_id uuid not null,
  field_name text not null,
  winning_client_timestamp timestamptz not null,
  winning_transaction_id uuid not null references transactions(id),
  winning_device_id uuid not null,
  primary key (user_id, entity_type, entity_id, field_name)
);

-- V6 future cloud additions (local prototype currently uses IndexedDB)
-- Task recurrence fields can be represented as JSONB recurrence_rule plus recurrence_series_id UUID and recurrence_occurrence INTEGER.
-- Reusable templates should live in task_templates(id, user_id, name, description, nodes JSONB, created_at, updated_at).
