import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { authenticate, cors, fail, json, resolveTask, serviceKey, success, supabaseUrl, type ApiAuth } from "./core.ts";
import { completeTask, createTask, deleteTask, reopenTask, restoreTask, updateTask } from "./task-actions.ts";
import { createProject, listProjects, listTasks, updateProject } from "./query-project-actions.ts";
import { actionDocs, openApi } from "./docs.ts";

async function handleAction(req: Request, body: any) {
  const action = String(body.action ?? "");
  const doc = actionDocs.find(item => item.action === action);
  if (!doc) return fail("Unknown action", 404, { actions: actionDocs });
  let auth: ApiAuth;
  try { auth = await authenticate(req, doc.scope === "write"); }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return fail(message, /read-only/.test(message) ? 403 : 401);
  }
  try {
    switch (action) {
      case "workspace_info": return success({ workspace: { id: auth.workspaceId, name: auth.workspaceName }, apiKey: { id: auth.keyId, label: auth.label, scopes: auth.scopes }, apiVersion: "1.4" });
      case "list_tasks": return success(await listTasks(auth, body));
      case "get_task": { const { task } = await resolveTask(auth, body, Boolean(body.includeDeleted)); return success(task); }
      case "create_task": return success(await createTask(auth, body), 201);
      case "update_task": return success(await updateTask(auth, body));
      case "complete_task": return success(await completeTask(auth, body));
      case "reopen_task": return success(await reopenTask(auth, body));
      case "delete_task": return success(await deleteTask(auth, body));
      case "restore_task": return success(await restoreTask(auth, body));
      case "list_projects": return success(await listProjects(auth));
      case "create_project": return success(await createProject(auth, body), 201);
      case "update_project": return success(await updateProject(auth, body));
      default: return fail("Unknown action", 404);
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const notFound = /not found/i.test(message), conflict = /multiple|already exists/i.test(message);
    return fail(message, notFound ? 404 : conflict ? 409 : 400);
  }
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!supabaseUrl || !serviceKey) return fail("TaskMap API is not configured", 500);
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.pathname.endsWith("/openapi.json") || url.searchParams.get("openapi") === "1") return json(openApi());
    return json({ name: "TaskMap External API", version: "1.4", endpoint: `${supabaseUrl.replace(/\/$/, "")}/functions/v1/taskmap-api`, authentication: "Authorization: Bearer TMAPI1.<key-id>.<secret>", openapi: `${supabaseUrl.replace(/\/$/, "")}/functions/v1/taskmap-api?openapi=1`, actions: actionDocs });
  }
  if (req.method !== "POST") return fail("GET or POST required", 405);
  const body = await req.json().catch(() => ({}));
  return await handleAction(req, body);
});
