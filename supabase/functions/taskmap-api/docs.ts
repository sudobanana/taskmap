import { supabaseUrl } from "./core.ts";

export const actionDocs = [
  { action: "workspace_info", scope: "read", description: "Return workspace and API-key metadata." },
  { action: "list_tasks", scope: "read", description: "Search/filter tasks. Supports query, status, priority, projectId/projectName, parentTaskId, tag, limit, offset, includeDeleted." },
  { action: "get_task", scope: "read", description: "Get one task by taskId or exact taskTitle." },
  { action: "create_task", scope: "write", description: "Create a task/subtask. Accepts TaskMap task fields plus projectName and parentTitle helpers." },
  { action: "update_task", scope: "write", description: "Update a task by taskId/taskTitle. Put editable fields in changes." },
  { action: "complete_task", scope: "write", description: "Complete a task and incomplete descendants; recurring series advance to the next occurrence." },
  { action: "reopen_task", scope: "write", description: "Reopen the task and descendants auto-completed by that parent completion." },
  { action: "delete_task", scope: "write", description: "Soft-delete a task. childMode is orphan (default) or cascade." },
  { action: "restore_task", scope: "write", description: "Restore a soft-deleted task." },
  { action: "list_projects", scope: "read", description: "List projects." },
  { action: "create_project", scope: "write", description: "Create a project." },
  { action: "update_project", scope: "write", description: "Rename/recolor a project." },
];
export function openApi() {
  const server = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/taskmap-api`;
  return {
    openapi: "3.1.0",
    info: { title: "TaskMap External API", version: "1.4.0", description: "Workspace-scoped TaskMap API for chatbots, agents, automations, and other external systems." },
    servers: [{ url: server }],
    components: { securitySchemes: { taskMapApiKey: { type: "http", scheme: "bearer", bearerFormat: "TMAPI1" } } },
    security: [{ taskMapApiKey: [] }],
    paths: {
      "/": {
        get: { operationId: "taskMapApiInfo", security: [], summary: "Describe the TaskMap API", responses: { "200": { description: "API metadata" } } },
        post: {
          operationId: "callTaskMap",
          summary: "Call a TaskMap action",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["action"], properties: { action: { type: "string", enum: actionDocs.map(item => item.action) } }, additionalProperties: true }, examples: { listTasks: { value: { action: "list_tasks", query: "invoice" } }, createTask: { value: { action: "create_task", title: "Follow up", projectName: "Work", priority: "high" } }, completeTask: { value: { action: "complete_task", taskId: "00000000-0000-4000-8000-000000000000" } } } } } },
          responses: { "200": { description: "Action result" }, "400": { description: "Invalid request" }, "401": { description: "Invalid/revoked API key" }, "403": { description: "Insufficient API-key scope" } },
        },
      },
    },
  };
}
