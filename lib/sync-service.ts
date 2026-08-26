import { db } from "./db";
import { getDeviceId } from "./device";
import { workspaceAction, type CloudWorkspaceInfo } from "./workspace-api";
import { updateWorkspaceProfile, type LocalWorkspaceProfile } from "./workspace-storage";
import type { DevBacklogItem, Project, Task, TaskCategory, TaskLayout, TaskTemplate, Transaction, TransactionChange } from "./types";

export type SyncRunResult = { pushed: number; pulled: number; syncedAt: string; workspace: CloudWorkspaceInfo };
type EntityType = Transaction["entityType"];
type Snapshot = { entityType: EntityType; entityId: string; payload: unknown };
type RemoteEntity = { entity_type: EntityType; entity_id: string; payload: unknown; is_deleted: boolean; revision: number; updated_at: string };
type RemoteTransaction = { id:string; entity_type:EntityType; entity_id:string; action_type:string; group_id:string|null; device_id:string; client_timestamp:string; server_received_timestamp:string; base_revision:number; result_revision:number };
type RemoteChange = { id:string; transaction_id:string; field_name:string; old_value:unknown; new_value:unknown };
type SyncResponse = {
  workspace: CloudWorkspaceInfo;
  entityCount: number;
  bootstrapped: number;
  pushed: number;
  entities: RemoteEntity[];
  transactions: RemoteTransaction[];
  changes: RemoteChange[];
  cursor: string | null;
  syncedAt: string;
};

let running: Promise<SyncRunResult> | null = null;

async function snapshots(): Promise<Snapshot[]> {
  const entities: Snapshot[] = [];
  for (const item of await db.projects.toArray()) entities.push({ entityType:"project", entityId:item.id, payload:item });
  for (const item of await db.taskCategories.toArray()) entities.push({ entityType:"task_category", entityId:item.id, payload:item });
  for (const item of await db.tasks.toArray()) entities.push({ entityType:"task", entityId:item.id, payload:item });
  for (const item of await db.taskLayouts.toArray()) entities.push({ entityType:"task_layout", entityId:item.taskId, payload:item });
  for (const item of await db.devBacklog.toArray()) entities.push({ entityType:"dev_backlog", entityId:item.id, payload:item });
  for (const item of await db.taskTemplates.toArray()) entities.push({ entityType:"task_template", entityId:item.id, payload:item });
  return entities;
}

async function pendingTransactions() {
  const pending = await db.transactions.where("syncStatus").equals("pending").sortBy("clientTimestamp");
  const result: Array<{ transaction: Omit<Transaction,"serverReceivedTimestamp"|"syncStatus">; changes: TransactionChange[] }> = [];
  for (const tx of pending) {
    const changes = await db.transactionChanges.where("transactionId").equals(tx.id).toArray();
    result.push({
      transaction: {
        id:tx.id, entityType:tx.entityType, entityId:tx.entityId, actionType:tx.actionType, groupId:tx.groupId ?? null,
        deviceId:tx.deviceId, clientTimestamp:tx.clientTimestamp, baseRevision:tx.baseRevision, resultRevision:tx.resultRevision,
      },
      changes,
    });
  }
  return result;
}

async function removeFreshLocalQaIfRemoteHasQa(entities: RemoteEntity[]) {
  const remoteQa = entities.find(row => row.entity_type === "project" && (row.payload as {name?:string}|null)?.name === "TaskMap QA Checklist");
  if (!remoteQa) return;
  const localQa = await db.projects.where("name").equals("TaskMap QA Checklist").first();
  if (!localQa || localQa.id === remoteQa.entity_id) return;
  const taskIds = (await db.tasks.where("projectId").equals(localQa.id).toArray()).map(task => task.id);
  const entityIds = new Set([localQa.id, ...taskIds]);
  const txs = (await db.transactions.toArray()).filter(tx => entityIds.has(tx.entityId));
  const txIds = txs.map(tx => tx.id);
  await db.transaction("rw", db.tasks, db.projects, db.transactions, db.transactionChanges, async () => {
    await db.tasks.where("projectId").equals(localQa.id).delete();
    await db.projects.delete(localQa.id);
    if (txIds.length) {
      await db.transactionChanges.where("transactionId").anyOf(txIds).delete();
      await db.transactions.bulkDelete(txIds);
    }
  });
}

async function applyRemoteEntity(remote: RemoteEntity) {
  const payload = remote.payload as Record<string, unknown> | null;
  switch (remote.entity_type) {
    case "task": payload ? await db.tasks.put(payload as unknown as Task) : await db.tasks.delete(remote.entity_id); break;
    case "project": payload ? await db.projects.put(payload as unknown as Project) : await db.projects.delete(remote.entity_id); break;
    case "task_category": payload ? await db.taskCategories.put(payload as unknown as TaskCategory) : await db.taskCategories.delete(remote.entity_id); break;
    case "task_template": payload ? await db.taskTemplates.put(payload as unknown as TaskTemplate) : await db.taskTemplates.delete(remote.entity_id); break;
    case "dev_backlog": payload ? await db.devBacklog.put(payload as unknown as DevBacklogItem) : await db.devBacklog.delete(remote.entity_id); break;
    case "task_layout": payload ? await db.taskLayouts.put({ taskId: remote.entity_id, ...payload } as unknown as TaskLayout) : await db.taskLayouts.delete(remote.entity_id); break;
  }
}

async function applyRemote(response: SyncResponse) {
  await db.transaction("rw", db.tasks, db.projects, db.taskCategories, db.taskLayouts, db.devBacklog, db.taskTemplates, async () => {
    for (const remote of response.entities) await applyRemoteEntity(remote);
  });
  const transactions: Transaction[] = response.transactions.map(row => ({
    id:row.id, entityType:row.entity_type, entityId:row.entity_id, actionType:row.action_type, groupId:row.group_id,
    deviceId:row.device_id, clientTimestamp:row.client_timestamp, serverReceivedTimestamp:row.server_received_timestamp,
    baseRevision:Number(row.base_revision), resultRevision:Number(row.result_revision), syncStatus:"synced",
  }));
  const changes: TransactionChange[] = response.changes.map(row => ({ id:row.id, transactionId:row.transaction_id, fieldName:row.field_name, oldValue:row.old_value, newValue:row.new_value }));
  await db.transaction("rw", db.transactions, db.transactionChanges, async () => {
    if (transactions.length) await db.transactions.bulkPut(transactions);
    if (changes.length) await db.transactionChanges.bulkPut(changes);
  });
}

async function runSync(profile: LocalWorkspaceProfile): Promise<SyncRunResult> {
  if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("Device is offline");
  const outgoing = await pendingTransactions();
  const bootstrapEntities = profile.bootstrapOnFirstSync && !profile.hasSynced ? await snapshots() : [];
  const response = await workspaceAction<SyncResponse>("sync", {
    deviceId:getDeviceId(),
    deviceName: typeof navigator === "undefined" ? "TaskMap device" : /Mobile|Android|iPhone/i.test(navigator.userAgent) ? "TaskMap mobile" : "TaskMap desktop",
    cursor:profile.cursor,
    bootstrapEntities,
    transactions:outgoing,
  }, { syncKey:profile.syncKey });

  if (!profile.hasSynced && profile.source !== "created" && response.entityCount > 0) await removeFreshLocalQaIfRemoteHasQa(response.entities);
  await applyRemote(response);
  const txIds = outgoing.map(item => item.transaction.id);
  if (txIds.length) await db.transactions.where("id").anyOf(txIds).modify({ syncStatus:"synced", serverReceivedTimestamp:response.syncedAt });
  updateWorkspaceProfile(profile.id, {
    name:response.workspace.name,
    role:response.workspace.role,
    recoveryEmailHint:response.workspace.recoveryEmailHint,
    recoveryEmailVerified:response.workspace.recoveryEmailVerified,
    lastSyncAt:response.syncedAt,
    cursor:response.cursor,
    hasSynced:true,
    bootstrapOnFirstSync:false,
  });
  return { pushed:response.pushed + response.bootstrapped, pulled:response.entities.length, syncedAt:response.syncedAt, workspace:response.workspace };
}

export function syncTaskMapWorkspace(profile: LocalWorkspaceProfile) {
  if (!running) running = runSync(profile).finally(() => { running = null; });
  return running;
}
