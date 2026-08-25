import { db } from "./db";
import type { Task } from "./types";

/**
 * Rebuild a historical task revision by cloning the current materialized state
 * and reversing every later transaction using its recorded old values.
 */
export async function reconstructTaskAt(taskId: string, targetTimestamp: string): Promise<Task | null> {
  const current = await db.tasks.get(taskId);
  if (!current) return null;

  const targetMs = new Date(targetTimestamp).getTime();
  const transactions = await db.transactions.where("entityId").equals(taskId).toArray();
  const later = transactions
    .filter(tx => tx.entityType === "task" && new Date(tx.clientTimestamp).getTime() > targetMs)
    .sort((a, b) => new Date(b.clientTimestamp).getTime() - new Date(a.clientTimestamp).getTime());

  let historical: Record<string, unknown> | null = structuredClone(current) as unknown as Record<string, unknown>;

  for (const tx of later) {
    if (tx.actionType === "TASK_CREATED") {
      historical = null;
      break;
    }
    if (!historical) break;
    const changes = await db.transactionChanges.where("transactionId").equals(tx.id).toArray();
    for (const change of changes) {
      if (change.fieldName === "__entity__") continue;
      historical[change.fieldName] = structuredClone(change.oldValue);
    }
  }

  return historical as unknown as Task | null;
}
