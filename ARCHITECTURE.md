# TaskMap architecture decisions

## Local-first write path

1. UI performs a user action.
2. Editable controls may hold a temporary dirty value while focused.
3. Dirty controls are outlined amber and do not write transactions yet.
4. On blur/commit, a single Dexie transaction updates the current entity projection.
5. The same Dexie transaction appends one immutable transaction row and its field-level old/new values.
6. The UI updates from IndexedDB immediately.
7. A future sync worker uploads pending transactions when online.

## Current entities

- `tasks` includes a floating-point `manualOrder` for low-write drag reordering.
- `projects` are real entities rather than hard-coded sidebar labels.
- `taskCategories` store named rule expressions used to generate Kanban-style lanes.
- `taskLayouts` keeps map position separate from task data.

## Merge model

- Different fields: merge automatically.
- Same field: newest `clientTimestamp` wins.
- Same timestamp: transaction ID/device ID provide deterministic tie-breaking.
- Server receive time is audit metadata, not normal precedence.
- Cloud `entity_field_versions` records the current winning mutation per field.
- Deletes will be tombstones, not hard deletes.

## Historical revisions

Current state is maintained forward for speed. Historical views can be reconstructed backward from the current materialized task because each transaction stores both old and new values. `lib/history-service.ts` implements the first reverse reconstruction pass.

## Task relationships

A mind-map connection is not merely visual. Creating an edge sets the target task's `parentTaskId`; deleting that edge clears the relationship. List and map representations therefore remain views of the same task graph.

## Rule categories

Custom task categories are computed views, not duplicated task data. The current parser supports `AND` expressions over Project, Due Date, Start Date, Priority, Status, Duration, Completed, Title, and Created Date with operators `=`, `!=`, `<`, `<=`, `>`, and `>=`.

## Production note

The service worker in this test build proves the offline launch/cache path. Before production it should be replaced with a build-manifest-aware caching strategy so exact versioned Next.js assets are precached and old caches are safely retired after deployments.


## IndexedDB schema v3

The QA rebuild adds indexes for all current `where()` / `orderBy()` query fields, including `taskCategories.createdAt`. The v3 migration intentionally resets prototype data once so the browser starts with the deterministic TaskMap QA Checklist dataset. This reset is a development/testing migration only and is not the intended behavior for production releases.

## IndexedDB schema v4

The v4 QA migration refreshes the deterministic test dataset so the checklist includes all current interactions. This remains a prototype/testing-only destructive migration; production migrations will preserve user data.

## Hierarchical task list behavior

Manual drag/drop distinguishes three drop zones. The top and bottom quarters reorder with a highlighted insertion line; the center nests the dragged task beneath the target. Parent relationships are stored only in `parentTaskId`, so Tasks and Mind Map share the same hierarchy.

## Calendar interaction model

Calendar dragging and resizing use transient preview state. No database writes occur during pointer movement. Pointer release commits a single transaction: moving changes `startTime`, bottom resize changes `estimatedMinutes`, and top resize changes both fields atomically.

## Mind Map scopes

The map can project all tasks, one project, or one parent subtree. Tasks outside a filtered scope appear in the Available Tasks tray. Dragging a tray task onto the canvas assigns the relevant project/parent scope and records its map position.

## V5 additions

- Task completion cascades use `Transaction.groupId` so parent + descendant updates are one logical user action while each entity retains its own revision transaction.
- `autoCompletedByParentId` records why a descendant was completed, allowing parent reopen to affect only descendants completed by that parent action.
- `devBacklog` is a separate IndexedDB store; development bugs/features remain hidden from normal task queries.
- Ask TaskMap is server-mediated through `/api/assistant`. The API key remains server-side. Model output is translated to typed `AssistantAction` values and dispatched through normal TaskMap services.
- Destructive assistant actions are held for explicit confirmation.
- Calendar planning uses committed drag endpoints: Day Task → timeline sets `startDate/startTime`; timeline → Day Tasks clears `startTime` while retaining the selected date.

## V6 recurring tasks and templates

Recurring series store a recurrence rule plus a single real active occurrence. Future calendar occurrences are virtual projections calculated for the visible day. Completing the active occurrence persists it as history and materializes only the next real occurrence. This prevents infinite/large recurrence schedules from filling IndexedDB.

Task templates are stored separately in `taskTemplates`. Each template contains template-local node IDs and parent references. Using a template creates fresh Task IDs and rebuilds the hierarchy through the normal task service/transaction layer.

## V15 Mind Map planning model

The Mind Map is a view over the same `parentTaskId` hierarchy used by Tasks and Task Details. It does not own a separate hierarchy model.

- Scope can be All Tasks, one Project, or one Parent hierarchy.
- Parent/child edges are derived directly from `parentTaskId` and therefore remain synchronized with task-list nesting and Task Details.
- `taskLayouts` stores only visual state: x/y position and collapsed state.
- The v10 IndexedDB migration clears only `taskLayouts` once so the redesigned tree can start from a clean automatic layout.
- Auto Arrange computes a hierarchy layout and persists the resulting x/y positions as grouped `MAP_AUTO_ARRANGED` layout transactions.
- Collapsing a branch changes only the visual `collapsed` flag; it never changes parent/child data.
- Dropping an available task directly on a node updates the dropped task's `parentTaskId` through the normal task transaction service.

Task-list drag behavior uses a dedicated native drag handle. Row centers remain hierarchy drop targets in every sort mode, while before/after reordering is enabled only in Manual sort. This keeps parent assignment available without making non-manual sorts pretend they have a persistent visual order.

## v1.2 online sync
- IndexedDB remains the immediate source of truth for UI writes.
- Supabase Auth identifies the cloud account; RLS restricts all sync rows to `auth.uid()`.
- Local pending transactions are pushed through `apply_taskmap_transaction`.
- The RPC records immutable transactions and transaction changes, then merges each changed field using original client timestamps plus a deterministic transaction-id tie-breaker.
- `sync_entities` stores merged JSON snapshots, so future TaskMap fields do not require a schema migration just to sync.
- Supabase Realtime notifies other online devices; those devices pull the merged snapshots back into IndexedDB.
- Offline devices accumulate pending transactions and sync after reconnect.
- The first device linked to an empty cloud bootstraps current entity snapshots and per-field baselines. Existing local history remains local; all transactions after cloud linking are mirrored and available across devices.

## v1.3 Sync Workspaces

TaskMap v1.3 replaces mandatory Supabase Auth for normal sync with explicit, key-based Sync Workspaces.

- Local Only remains the default and creates no cloud credential.
- A created workspace receives an opaque UUID plus a 256-bit random secret. The portable key is formatted `TM1.<key-id>.<secret>`.
- The key ID is only a lookup identifier. Supabase stores SHA-256 of the high-entropy secret, never the plaintext secret.
- `sync_workspaces` stores workspace metadata and hashed/verified recovery-email metadata.
- `sync_workspace_keys` supports future owner/editor/viewer keys and revocation. v1.3 creates owner keys.
- `workspace_sync_entities`, `workspace_transactions`, `workspace_transaction_changes`, and `workspace_entity_field_versions` preserve the same materialized-state + immutable transaction + per-field merge model from v1.2, but scope every row by workspace rather than `auth.uid()`.
- Workspace tables are RLS-protected with explicit deny-all browser policies. `anon` and `authenticated` grants are revoked. Only the Edge Function's service role can access them.
- The `taskmap-workspace` Edge Function has platform JWT verification disabled because it implements custom Sync Key authentication. Recovery actions separately validate a short-lived Supabase Auth email session.
- Each local workspace uses a distinct IndexedDB database name (`TaskMapDB.workspace.<workspace-id>`). Switching workspaces persists the selected ID then reloads so all existing Dexie/live-query code binds to the selected database cleanly.
- Creating a workspace can clone the currently active IndexedDB database. Joining an existing workspace starts from an isolated local database and pulls the remote projection.
- Devices sync after local writes, on reconnect/focus, and periodically while visible. This avoids requiring an authenticated Realtime subscription for key-only workspaces.
- Recovery email is optional. Its normalized SHA-256 hash is stored server-side; the plaintext address is not needed for workspace lookup. Verification/recovery uses a Supabase magic-link session and can mint a replacement workspace key.


## v1.5 REST API and project lifecycle

- `/api/taskmap/openapi.json` describes separate REST operations for GPT Actions while legacy `POST /api/taskmap` remains backward compatible.
- REST endpoints proxy into the existing transaction-aware cloud API; project deletion uses a small dedicated authenticated Edge Function so the stable API broker does not need an unrelated redeploy.
- External API keys remain workspace-scoped, individually revocable, and separate from Sync Keys.
- Project rename is a normal project entity transaction (`PROJECT_UPDATED`).
- Project deletion is one grouped logical action. `detach` clears `projectId` from tasks (including Trash rows) and deletes the project entity; `cascade` soft-deletes all active tasks assigned to the project plus every nested descendant, then deletes the project entity.
- Cascade can cross project boundaries through hierarchy, so the UI warns when nested descendants currently belong to another project.
- Project entity deletion uses a `__entity__ -> null` transaction change so cloud materialized state records the project as deleted while preserving immutable history.


## v1.6 Kanban presentation layer

Kanban is a presentation of the same task entities used by Tasks; it does not create a parallel board/card data model. The current breakout field is local UI preference and columns are derived from task values. Initial breakout fields are Status, Priority, and Project. A cross-column drop commits the same normal task mutations used elsewhere; Status Done/Reopen routes through completion behavior, and Project changes reuse the existing descendant-scope dialog.

Hierarchy collapse is view state only. Collapsing a parent never changes task relationships or sync data. The visible task set is filtered by collapsed ancestors before list/Kanban rendering, so descendants can be hidden even when their breakout value places them in another Kanban column.
