# TaskMap v1.5.0

TaskMap is a local-first task manager with optional named cloud Sync Workspaces.


## New in v1.5 — REST GPT Actions + project management

- External API now exposes distinct REST operations so Custom GPT Actions sees separate tools instead of one generic POST command.
- GPT/OpenAPI discovery: `/api/taskmap/openapi.json` (the legacy `/api/taskmap?openapi=1` alias returns the same REST schema).
- REST routes include workspace info, task search/create/get/update/delete/complete/reopen/restore, and project list/create/update/delete.
- The legacy `POST /api/taskmap` action endpoint remains available for existing integrations.
- Project pages now include **Rename project** and **Delete project** actions on desktop and mobile.
- Project deletion uses the same modal style as parent-task deletion: **Delete project only** keeps tasks and makes them unassigned, while **Delete project + all tasks/descendants** soft-deletes project tasks plus recursively nested descendants.
- Cascade warnings explicitly call out descendants assigned to another project before deletion.
- Project rename/delete actions are transaction-backed so they sync through the same local-first/cloud history model.

## New in v1.4 — External API + safer workspace joining

- Settings → External API can create multiple named workspace-scoped API keys.
- API keys can be read-only or read/write and are independent from Sync Keys.
- API secrets use the `TMAPI1.<key-id>.<secret>` format and are shown only when created.
- Callable endpoint: `/api/taskmap` on the deployed TaskMap domain.
- Legacy OpenAPI alias: `/api/taskmap?openapi=1`; v1.5 also exposes `/api/taskmap/openapi.json`.
- Supported actions include workspace info, task list/search/get/create/update/complete/reopen/delete/restore, and project list/create/update.
- All API writes go through the cloud transaction/field-merge layer so changes sync back to TaskMap and retain history.
- Connecting an existing Sync Key now performs a pull-only first bootstrap into that workspace's isolated IndexedDB. It never uploads the device's Local Only tasks into an existing workspace.

## New in v1.3 — Sync Workspaces

Cloud Sync no longer requires users to create a traditional TaskMap account.

- **Cloud Sync is off by default.** Local Only remains the default until the user explicitly opens Settings → Online Sync.
- **Create Sync Workspace** generates a high-entropy `TM1...` Sync Key only when requested.
- Workspaces have human-friendly names such as **Personal**, **Work**, **Family**, or **Team Alpha**.
- A device can keep multiple Sync Workspaces and switch among them.
- Each workspace uses its own IndexedDB database, so environments remain separated offline as well as online.
- New workspaces can start by cloning the current TaskMap or by starting empty.
- **Connect Existing Key** joins an existing workspace without email/password signup.
- Workspace keys are stored on connected devices. Supabase stores only a SHA-256 hash of the secret portion of the key.
- Owner keys can be rotated; the old key is revoked.
- An optional recovery email can be added, verified through a one-time Supabase email link, and used to generate a replacement key if the original is lost.
- The cloud merge model remains transaction-based and per-field: unrelated concurrent edits merge, while the later original client edit wins when two devices change the same field.

The v1.2 account-sync tables remain in the schema for compatibility/testing, but v1.3 uses the workspace tables and `taskmap-workspace` Edge Function.

## Cloud security model

Browser clients do **not** receive a service-role key and cannot query workspace tables directly. Workspace tables have RLS enabled, explicit deny-all browser policies, and grants revoked from `anon` / `authenticated`. The `taskmap-workspace` Edge Function performs custom Sync Key authentication and brokers data using the Supabase service role.

A Sync Key is effectively a workspace credential. Anyone with the key can access that workspace, so users should store it securely.

## Recovery email note

Recovery uses Supabase passwordless email only to verify ownership of the recovery address; it is not required for ordinary TaskMap sync. For public production delivery, configure custom SMTP in Supabase. The built-in SMTP service is intended for development and has recipient restrictions.

## Enable Ask TaskMap

Copy `.env.example` to `.env.local` and set:

```text
OPENAI_API_KEY=your_key_here
```

Then restart TaskMap. On Vercel, add the same `OPENAI_API_KEY` in Project Settings → Environment Variables.

## Run locally on Windows

Double-click **`START TASKMAP.bat`**.

Or run:

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

## Supabase configuration

The included build points at the TaskMap Supabase project using publishable browser credentials:

```env
NEXT_PUBLIC_SUPABASE_URL=https://axlykicsvtpeulshzyol.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_cLPFSdXhSOc5tIPSKop4Kw_a_MuFAAF
```

The publishable key is used by the optional recovery-email flow. Never place the Supabase service-role key in `.env.local`, browser code, GitHub, or Vercel client environment variables.

Backend source is included under `supabase/`:

- `migrations/20260826_taskmap_v1_2_sync.sql` — previous account-sync layer.
- `migrations/20260826_taskmap_v1_3_sync_workspaces.sql` — Sync Workspace tables and merge RPC.
- `functions/taskmap-workspace/` — Sync Key / recovery Edge Function.
- `functions/taskmap-api/` — stable legacy action API broker.
- `functions/taskmap-project-delete/` — authenticated project delete broker used by the v1.5 REST route.

## Core architecture

IndexedDB remains the immediate working copy. User actions update local state and append immutable transactions first; network sync happens afterward. Recurring tasks materialize only one active occurrence, Calendar projects future recurrences virtually, templates are separate reusable definitions, and deletes are tombstoned for Trash/restore behavior.
