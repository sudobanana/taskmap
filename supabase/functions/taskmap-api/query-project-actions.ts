import { activePayloads, applyChanges, cleanText, entityRow, entityRows, nowIso, resolveProjectId, uuid, type ApiAuth, type EntityRow } from "./core.ts";

export async function listTasks(auth: ApiAuth, body: any) {
  const rows = await entityRows(auth.workspaceId, "task");
  let tasks = activePayloads(rows, Boolean(body.includeDeleted));
  const query = cleanText(body.query ?? body.search, 500).toLowerCase();
  if (query) tasks = tasks.filter(task => [task.title, task.notes, ...(Array.isArray(task.tags) ? task.tags : [])].some(value => String(value ?? "").toLowerCase().includes(query)));
  if (body.status) tasks = tasks.filter(task => task.status === body.status);
  if (body.priority) tasks = tasks.filter(task => task.priority === body.priority);
  const projectId = await resolveProjectId(auth, body).catch(error => { if (body.projectId || body.projectName) throw error; return undefined; });
  if (projectId !== undefined) tasks = tasks.filter(task => task.projectId === projectId);
  if (body.parentTaskId !== undefined) tasks = tasks.filter(task => task.parentTaskId === body.parentTaskId);
  if (body.tag) { const tag = cleanText(body.tag, 80).toLowerCase(); tasks = tasks.filter(task => (task.tags ?? []).some((value: string) => value.toLowerCase() === tag)); }
  const limit = Math.min(200, Math.max(1, Number(body.limit ?? 100))), offset = Math.max(0, Number(body.offset ?? 0));
  tasks.sort((a, b) => Number(a.manualOrder ?? 0) - Number(b.manualOrder ?? 0));
  return { total: tasks.length, offset, limit, tasks: tasks.slice(offset, offset + limit) };
}
export async function listProjects(auth: ApiAuth) {
  const projects = activePayloads(await entityRows(auth.workspaceId, "project"));
  projects.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { projects };
}
export async function createProject(auth: ApiAuth, body: any) {
  const name = cleanText(body.name, 80); if (!name) throw new Error("name is required");
  const existing = activePayloads(await entityRows(auth.workspaceId, "project")).find(project => String(project.name).toLowerCase() === name.toLowerCase());
  if (existing) throw new Error(`Project already exists: ${name}`);
  const now = nowIso(), project = { id: crypto.randomUUID(), name, color: /^#[0-9a-f]{6}$/i.test(String(body.color ?? "")) ? String(body.color) : "#5B5BD6", createdAt: now, updatedAt: now };
  await applyChanges(auth, "project", project.id, "API_PROJECT_CREATED", null, project);
  return project;
}
export async function updateProject(auth: ApiAuth, body: any) {
  let row: EntityRow | null = null;
  if (uuid(body.projectId)) row = await entityRow(auth.workspaceId, "project", String(body.projectId));
  else if (body.projectName) { const matches = (await entityRows(auth.workspaceId, "project")).filter(item => item.payload && !item.is_deleted && String(item.payload.name).toLowerCase() === cleanText(body.projectName, 80).toLowerCase()); if (matches.length === 1) row = matches[0]; else if (matches.length > 1) throw new Error("Multiple matching projects; use projectId"); }
  if (!row?.payload || row.is_deleted) throw new Error("Project not found");
  const patch: Record<string, unknown> = { updatedAt: nowIso() };
  if (body.changes?.name !== undefined) { const name = cleanText(body.changes.name, 80); if (!name) throw new Error("Project name cannot be empty"); patch.name = name; }
  if (body.changes?.color !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(String(body.changes.color))) throw new Error("color must be a six-digit hex color"); patch.color = String(body.changes.color); }
  return await applyChanges(auth, "project", row.entity_id, "API_PROJECT_UPDATED", row.payload, patch);
}
