import { workspaceAction } from "./workspace-api";

export type ExternalApiKeyInfo = {
  id: string;
  label: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export async function listExternalApiKeys(syncKey: string) {
  return workspaceAction<{ keys: ExternalApiKeyInfo[] }>("list_api_keys", {}, { syncKey });
}

export async function createExternalApiKey(syncKey: string, label: string, writeAccess: boolean) {
  return workspaceAction<{ apiKey: string; key: ExternalApiKeyInfo }>("create_api_key", {
    label,
    scopes: writeAccess ? ["read", "write"] : ["read"],
  }, { syncKey });
}

export async function revokeExternalApiKey(syncKey: string, keyId: string) {
  return workspaceAction<{ revoked: boolean; keyId: string }>("revoke_api_key", { keyId }, { syncKey });
}
