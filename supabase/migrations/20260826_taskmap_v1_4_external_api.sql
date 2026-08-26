-- TaskMap v1.4 External API keys.
-- API keys are workspace-scoped and independent from Sync Keys. Browser roles cannot read this table.

create table if not exists public.workspace_api_keys (
  workspace_id uuid not null references public.sync_workspaces(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  key_hash text not null,
  label text not null check (char_length(label) between 1 and 80),
  scopes text[] not null default array['read']::text[],
  created_at timestamptz not null default now(),
  last_used_at timestamptz null,
  revoked_at timestamptz null,
  primary key (workspace_id,id),
  unique(id),
  check (cardinality(scopes) between 1 and 2),
  check (scopes <@ array['read','write']::text[])
);

create index if not exists workspace_api_keys_lookup_idx
  on public.workspace_api_keys(id) where revoked_at is null;

alter table public.workspace_api_keys enable row level security;
revoke all on table public.workspace_api_keys from anon, authenticated;
grant select, insert, update, delete on table public.workspace_api_keys to service_role;

drop policy if exists workspace_api_keys_deny_clients on public.workspace_api_keys;
create policy workspace_api_keys_deny_clients on public.workspace_api_keys
  for all to anon, authenticated using (false) with check (false);
