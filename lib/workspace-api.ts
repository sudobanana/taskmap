const DEFAULT_SUPABASE_URL = "https://axlykicsvtpeulshzyol.supabase.co";

export type CloudWorkspaceInfo = {
  id: string;
  name: string;
  recoveryEmailHint: string | null;
  recoveryEmailVerified: boolean;
  role: "owner" | "editor" | "viewer";
};

export function workspaceApiConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL ?? DEFAULT_SUPABASE_URL);
}

function endpoint() {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? DEFAULT_SUPABASE_URL).replace(/\/$/, "");
  return `${base}/functions/v1/taskmap-workspace`;
}

export async function workspaceAction<T>(action: string, payload: Record<string, unknown> = {}, options?: { syncKey?: string | null; recoveryToken?: string | null }): Promise<T> {
  const headers: Record<string,string> = { "Content-Type": "application/json" };
  if (options?.syncKey) headers["x-taskmap-sync-key"] = options.syncKey;
  if (options?.recoveryToken) headers["x-taskmap-recovery-token"] = options.recoveryToken;
  const result = await fetch(endpoint(), { method: "POST", headers, body: JSON.stringify({ action, ...payload }) });
  const data = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(typeof data?.error === "string" ? data.error : `TaskMap cloud request failed (${result.status})`);
  return data as T;
}
