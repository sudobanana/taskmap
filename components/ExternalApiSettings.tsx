"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, Check, Copy, KeyRound, Plus, RefreshCw, Shield, Trash2 } from "lucide-react";
import { useCloudSync } from "./CloudSyncProvider";
import { createExternalApiKey, listExternalApiKeys, revokeExternalApiKey, type ExternalApiKeyInfo } from "@/lib/external-api";

export default function ExternalApiSettings() {
  const sync = useCloudSync();
  const active = sync.activeWorkspace;
  const [keys, setKeys] = useState<ExternalApiKeyInfo[]>([]);
  const [label, setLabel] = useState("Chatbot");
  const [writeAccess, setWriteAccess] = useState(true);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState("/api/taskmap");

  useEffect(() => {
    if (typeof window !== "undefined") setEndpoint(`${window.location.origin}/api/taskmap`);
  }, []);

  async function refresh() {
    if (!active || active.role !== "owner") { setKeys([]); return; }
    setBusy(true); setMessage(null);
    try { setKeys((await listExternalApiKeys(active.syncKey)).keys); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  useEffect(() => { void refresh(); }, [active?.id, active?.role]); // eslint-disable-line react-hooks/exhaustive-deps

  async function createKey() {
    if (!active || active.role !== "owner" || !label.trim()) return;
    setBusy(true); setMessage(null);
    try {
      const result = await createExternalApiKey(active.syncKey, label.trim(), writeAccess);
      setCreatedKey(result.apiKey);
      setKeys(current => [result.key, ...current.filter(item => item.id !== result.key.id)]);
      setMessage("API key created. Copy it now; TaskMap will not be able to show the secret again after you leave this page.");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function revoke(keyId: string) {
    if (!active || active.role !== "owner") return;
    if (!window.confirm("Revoke this API key? Any chatbot or integration using it will immediately lose access.")) return;
    setBusy(true); setMessage(null);
    try { await revokeExternalApiKey(active.syncKey, keyId); await refresh(); setMessage("API key revoked."); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setMessage("Copied to clipboard.");
  }

  const activeKeys = useMemo(() => keys.filter(key => !key.revokedAt), [keys]);
  const example = `curl -X POST "${endpoint}" \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"action":"list_tasks","query":"invoice"}'`;

  return <section className="settings-card external-api-card">
    <div><Bot size={18}/><h2>External API</h2></div>
    <p>Give chatbots, agents, automations, or other systems controlled access to the active cloud workspace without sharing its Sync Key.</p>

    {!active ? <div className="api-empty-state"><Shield size={18}/><span><strong>Cloud workspace required</strong><small>Create or open a Sync Workspace first. Local Only data cannot be called from an outside system.</small></span></div>
    : active.role !== "owner" ? <div className="api-empty-state"><Shield size={18}/><span><strong>Owner key required</strong><small>Only a workspace owner can create or revoke external API keys.</small></span></div>
    : <>
      <div className="api-endpoint-panel">
        <span>Endpoint</span><code>{endpoint}</code><button className="ghost-button compact" onClick={()=>void copy(endpoint)}><Copy size={13}/> Copy</button>
      </div>
      <div className="api-endpoint-panel">
        <span>OpenAPI</span><code>{endpoint}?openapi=1</code><button className="ghost-button compact" onClick={()=>void copy(`${endpoint}?openapi=1`)}><Copy size={13}/> Copy</button>
      </div>

      <div className="sync-subpanel api-create-panel">
        <h3>Create API key</h3>
        <label className="sync-field"><span>Human-friendly name</span><input value={label} onChange={event=>setLabel(event.target.value)} placeholder="Work Chatbot, Home Assistant…"/></label>
        <label className="api-scope-choice"><input type="checkbox" checked={writeAccess} onChange={event=>setWriteAccess(event.target.checked)}/><span><strong>Allow changes</strong><small>Unchecked = read-only. Checked = create, edit, complete, reopen, delete/restore tasks and manage projects.</small></span></label>
        <button className="primary-button" disabled={busy||!label.trim()} onClick={()=>void createKey()}><Plus size={14}/> {busy?"Working…":"Create API key"}</button>
      </div>

      {createdKey && <div className="sync-key-callout api-key-callout"><div><KeyRound size={18}/><span><strong>Copy this API key now</strong><small>The secret is shown only for this newly created key.</small></span></div><code>{createdKey}</code><div className="sync-actions"><button className="primary-button" onClick={()=>void copy(createdKey)}><Copy size={14}/> Copy API key</button><button className="ghost-button" onClick={()=>setCreatedKey(null)}>I saved it</button></div></div>}

      <div className="api-key-list-heading"><span><strong>API keys</strong><small>{activeKeys.length} active</small></span><button className="ghost-button compact" disabled={busy} onClick={()=>void refresh()}><RefreshCw size={13}/> Refresh</button></div>
      {keys.length===0?<div className="api-empty-state"><KeyRound size={18}/><span><strong>No API keys yet</strong><small>Create one when an outside system needs access.</small></span></div>:<div className="api-key-list">{keys.map(item=><div key={item.id} className={item.revokedAt?"api-key-row revoked":"api-key-row"}><div><strong>{item.label}</strong><span className="api-scope-badges"><small><Check size={11}/> Read</small>{item.scopes.includes("write")&&<small><Check size={11}/> Write</small>}{item.revokedAt&&<small>Revoked</small>}</span><small>Created {new Date(item.createdAt).toLocaleString()}{item.lastUsedAt?` · Last used ${new Date(item.lastUsedAt).toLocaleString()}`:" · Never used"}</small></div>{!item.revokedAt&&<button className="icon-danger" title="Revoke API key" onClick={()=>void revoke(item.id)}><Trash2 size={15}/></button>}</div>)}</div>}

      <details className="api-example"><summary>Example API call</summary><pre><code>{example}</code></pre><p>POST JSON with an <code>action</code>. Common actions: <code>list_tasks</code>, <code>get_task</code>, <code>create_task</code>, <code>update_task</code>, <code>complete_task</code>, <code>reopen_task</code>, <code>delete_task</code>, <code>restore_task</code>, <code>list_projects</code>, and <code>create_project</code>.</p></details>
    </>}
    {message&&<p className="sync-message">{message}</p>}
  </section>;
}
