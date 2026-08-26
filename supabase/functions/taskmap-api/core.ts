import { createClient } from "npm:@supabase/supabase-js@2.112.4";

export const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
export const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
export const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-taskmap-api-key, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: cors });
export const fail = (error: string, status = 400, details?: unknown) => json({ ok: false, error, ...(details === undefined ? {} : { details }) }, status);
export const success = (data: unknown, status = 200) => json({ ok: true, data }, status);
export const nowIso = () => new Date().toISOString();
export const uuid = (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ""));
export const cleanText = (value: unknown, max = 5000) => String(value ?? "").trim().slice(0, max);
export const dateString = (value: unknown) => value == null || value === "" ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : (() => { throw new Error("Dates must use YYYY-MM-DD"); })();
export const timeString = (value: unknown) => value == null || value === "" ? null : /^\d{2}:\d{2}(:\d{2})?$/.test(String(value)) ? String(value).slice(0, 5) : (() => { throw new Error("Times must use HH:MM"); })();

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function parseApiKey(raw: string | null) {
  const parts = (raw ?? "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== "TMAPI1" || !uuid(parts[1]) || parts[2].length < 32) throw new Error("Invalid TaskMap API key");
  return { id: parts[1], secret: parts[2] };
}
export type ApiAuth = { workspaceId: string; keyId: string; label: string; scopes: string[]; workspaceName: string };
export async function authenticate(req: Request, write = false): Promise<ApiAuth> {
  const authHeader = req.headers.get("authorization");
  const bearer = authHeader?.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : null;
  const parsed = parseApiKey(bearer || req.headers.get("x-taskmap-api-key"));
  const { data: keyRow, error } = await db.from("workspace_api_keys")
    .select("workspace_id,id,key_hash,label,scopes")
    .eq("id", parsed.id).is("revoked_at", null).single();
  if (error || !keyRow) throw new Error("API key not found or revoked");
  if (!timingSafeEqual(await sha256(parsed.secret), String(keyRow.key_hash))) throw new Error("Invalid TaskMap API key");
  const scopes = Array.isArray(keyRow.scopes) ? keyRow.scopes.map(String) : [];
  if (write && !scopes.includes("write")) throw new Error("This API key is read-only");
  const { data: workspace, error: workspaceError } = await db.from("sync_workspaces").select("name").eq("id", keyRow.workspace_id).single();
  if (workspaceError || !workspace) throw new Error("Workspace not found");
  await db.from("workspace_api_keys").update({ last_used_at: nowIso() }).eq("id", parsed.id).eq("workspace_id", keyRow.workspace_id);
  return { workspaceId: String(keyRow.workspace_id), keyId: String(keyRow.id), label: String(keyRow.label), scopes, workspaceName: String(workspace.name) };
}

export type EntityType = "task" | "project";
export type EntityRow = { entity_type: EntityType; entity_id: string; payload: any; is_deleted: boolean; revision: number; updated_at: string };
export async function entityRows(workspaceId: string, entityType: EntityType): Promise<EntityRow[]> {
  const rows: EntityRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("workspace_sync_entities")
      .select("entity_type,entity_id,payload,is_deleted,revision,updated_at")
      .eq("workspace_id", workspaceId).eq("entity_type", entityType)
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as EntityRow[]));
    if ((data ?? []).length < 1000) break;
  }
  return rows;
}
export async function entityRow(workspaceId: string, entityType: EntityType, entityId: string): Promise<EntityRow | null> {
  const { data, error } = await db.from("workspace_sync_entities")
    .select("entity_type,entity_id,payload,is_deleted,revision,updated_at")
    .eq("workspace_id", workspaceId).eq("entity_type", entityType).eq("entity_id", entityId).maybeSingle();
  if (error) throw error;
  return data as EntityRow | null;
}
export function activePayloads(rows: EntityRow[], includeDeleted = false) {
  return rows.filter(row => row.payload && (includeDeleted || !row.is_deleted)).map(row => row.payload);
}
export async function resolveTask(auth: ApiAuth, body: any, allowDeleted = false) {
  if (uuid(body.taskId)) {
    const row = await entityRow(auth.workspaceId, "task", String(body.taskId));
    if (!row?.payload || (!allowDeleted && row.is_deleted)) throw new Error("Task not found");
    return { row, task: row.payload };
  }
  const title = cleanText(body.taskTitle, 500).toLowerCase();
  if (!title) throw new Error("taskId or taskTitle is required");
  const matches = (await entityRows(auth.workspaceId, "task")).filter(row => row.payload && (allowDeleted || !row.is_deleted) && String(row.payload.title ?? "").trim().toLowerCase() === title);
  if (!matches.length) throw new Error(`Task not found: ${body.taskTitle}`);
  if (matches.length > 1) throw new Error(`Multiple tasks are named \"${body.taskTitle}\"; use taskId instead`);
  return { row: matches[0], task: matches[0].payload };
}
export async function resolveProjectId(auth: ApiAuth, input: { projectId?: unknown; projectName?: unknown }, allowNull = true): Promise<string | null | undefined> {
  if (input.projectId === null || input.projectName === null) return allowNull ? null : undefined;
  if (input.projectId !== undefined && input.projectId !== "") {
    if (!uuid(input.projectId)) throw new Error("projectId must be a UUID");
    const row = await entityRow(auth.workspaceId, "project", String(input.projectId));
    if (!row?.payload || row.is_deleted) throw new Error("Project not found");
    return String(input.projectId);
  }
  const name = cleanText(input.projectName, 500).toLowerCase();
  if (!name) return undefined;
  const matches = activePayloads(await entityRows(auth.workspaceId, "project")).filter(project => String(project.name ?? "").trim().toLowerCase() === name);
  if (!matches.length) throw new Error(`Project not found: ${input.projectName}`);
  if (matches.length > 1) throw new Error(`Multiple projects are named \"${input.projectName}\"; use projectId instead`);
  return String(matches[0].id);
}
export async function resolveParentId(auth: ApiAuth, input: { parentTaskId?: unknown; parentTitle?: unknown }): Promise<string | null | undefined> {
  if (input.parentTaskId === null || input.parentTitle === null) return null;
  if (input.parentTaskId !== undefined && input.parentTaskId !== "") {
    if (!uuid(input.parentTaskId)) throw new Error("parentTaskId must be a UUID");
    const row = await entityRow(auth.workspaceId, "task", String(input.parentTaskId));
    if (!row?.payload || row.is_deleted) throw new Error("Parent task not found");
    return String(input.parentTaskId);
  }
  const title = cleanText(input.parentTitle, 500).toLowerCase();
  if (!title) return undefined;
  const matches = (await entityRows(auth.workspaceId, "task")).filter(row => row.payload && !row.is_deleted && String(row.payload.title ?? "").trim().toLowerCase() === title);
  if (!matches.length) throw new Error(`Parent task not found: ${input.parentTitle}`);
  if (matches.length > 1) throw new Error(`Multiple tasks are named \"${input.parentTitle}\"; use parentTaskId instead`);
  return String(matches[0].entity_id);
}

export async function applyChanges(auth: ApiAuth, entityType: EntityType, entityId: string, actionType: string, before: any | null, patch: Record<string, unknown>, groupId: string | null = null) {
  const row = before ? await entityRow(auth.workspaceId, entityType, entityId) : null;
  const baseRevision = Number(row?.revision ?? before?.revision ?? 0);
  const nextRevision = baseRevision + 1;
  const now = nowIso();
  const txId = crypto.randomUUID();
  let changes: any[] = [];
  let nextPayload: any;
  if (!before) {
    nextPayload = { ...patch };
    changes = [
      { id: crypto.randomUUID(), transactionId: txId, fieldName: "__entity__", oldValue: null, newValue: nextPayload },
      ...Object.entries(nextPayload).map(([fieldName, newValue]) => ({ id: crypto.randomUUID(), transactionId: txId, fieldName, oldValue: null, newValue })),
    ];
  } else {
    nextPayload = { ...before, ...patch };
    changes = Object.entries(patch)
      .filter(([fieldName, newValue]) => JSON.stringify(before[fieldName]) !== JSON.stringify(newValue))
      .map(([fieldName, newValue]) => ({ id: crypto.randomUUID(), transactionId: txId, fieldName, oldValue: before[fieldName] ?? null, newValue }));
  }
  if (!changes.length) return nextPayload;
  const transaction = {
    id: txId, entityType, entityId, actionType, groupId,
    deviceId: auth.keyId, clientTimestamp: now,
    baseRevision, resultRevision: nextRevision,
  };
  const { error } = await db.rpc("apply_taskmap_workspace_transaction", { p_workspace_id: auth.workspaceId, p_transaction: transaction, p_changes: changes });
  if (error) throw error;
  return nextPayload;
}
