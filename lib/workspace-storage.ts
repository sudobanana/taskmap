export type LocalWorkspaceProfile = {
  id: string;
  name: string;
  syncKey: string;
  role: "owner" | "editor" | "viewer";
  recoveryEmailHint: string | null;
  recoveryEmailVerified: boolean;
  createdAt: string;
  lastUsedAt: string;
  lastSyncAt: string | null;
  cursor: string | null;
  source: "created" | "joined" | "recovered";
  bootstrapOnFirstSync: boolean;
  hasSynced: boolean;
};

const PROFILES_KEY = "taskmap.syncWorkspaces.v1";
const ACTIVE_KEY = "taskmap.activeWorkspace.v1";
const LOCAL_ID = "local";

function browser() { return typeof window !== "undefined"; }

export function getWorkspaceProfiles(): LocalWorkspaceProfile[] {
  if (!browser()) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(item => item?.id && item?.syncKey && item?.name) : [];
  } catch { return []; }
}

export function saveWorkspaceProfiles(profiles: LocalWorkspaceProfile[]) {
  if (!browser()) return;
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

export function getActiveWorkspaceId() {
  if (!browser()) return LOCAL_ID;
  return localStorage.getItem(ACTIVE_KEY) || LOCAL_ID;
}

export function getActiveWorkspaceProfile() {
  const id = getActiveWorkspaceId();
  if (id === LOCAL_ID) return null;
  return getWorkspaceProfiles().find(profile => profile.id === id) ?? null;
}

export function upsertWorkspaceProfile(profile: LocalWorkspaceProfile) {
  const profiles = getWorkspaceProfiles();
  const next = profiles.filter(item => item.id !== profile.id);
  next.push(profile);
  saveWorkspaceProfiles(next.sort((a,b) => a.name.localeCompare(b.name)));
}

export function updateWorkspaceProfile(id: string, patch: Partial<LocalWorkspaceProfile>) {
  const profiles = getWorkspaceProfiles();
  const current = profiles.find(item => item.id === id);
  if (!current) return null;
  const updated = { ...current, ...patch };
  upsertWorkspaceProfile(updated);
  return updated;
}

export function removeWorkspaceProfile(id: string) {
  saveWorkspaceProfiles(getWorkspaceProfiles().filter(profile => profile.id !== id));
  if (getActiveWorkspaceId() === id && browser()) localStorage.setItem(ACTIVE_KEY, LOCAL_ID);
}

export function activateWorkspace(id: string) {
  if (!browser()) return;
  if (id !== LOCAL_ID && !getWorkspaceProfiles().some(profile => profile.id === id)) throw new Error("Workspace is not connected on this device");
  localStorage.setItem(ACTIVE_KEY, id);
  if (id !== LOCAL_ID) updateWorkspaceProfile(id, { lastUsedAt: new Date().toISOString() });
}

export function localWorkspaceId() { return LOCAL_ID; }
export function workspaceDatabaseName(id = getActiveWorkspaceId()) { return id === LOCAL_ID ? "TaskMapDB" : `TaskMapDB.workspace.${id}`; }

export function shouldDelayQaSeed() {
  const profile = getActiveWorkspaceProfile();
  return Boolean(profile && profile.source !== "created" && !profile.hasSynced);
}
