"use client";

import { useMemo, useState } from "react";
import { Check, CloudOff, Copy, KeyRound, Mail, Plus, RefreshCw, RotateCcw, ShieldCheck, Trash2, Wifi } from "lucide-react";
import { useCloudSync } from "./CloudSyncProvider";
import { localWorkspaceId } from "@/lib/workspace-storage";

type Mode = "overview" | "create" | "join" | "recover";

export default function SyncSettings() {
  const sync=useCloudSync();
  const [mode,setMode]=useState<Mode>("overview");
  const [name,setName]=useState("");
  const [key,setKey]=useState("");
  const [recoveryEmail,setRecoveryEmail]=useState("");
  const [useCurrentData,setUseCurrentData]=useState(true);
  const [message,setMessage]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [showKey,setShowKey]=useState(false);
  const [createdKey,setCreatedKey]=useState<string|null>(null);
  const [recoveryMatches,setRecoveryMatches]=useState<Array<{id:string;name:string;recoveryEmailHint:string|null;updatedAt:string}>>([]);
  const active=sync.activeWorkspace;
  const sorted=useMemo(()=>[...sync.workspaces].sort((a,b)=>a.name.localeCompare(b.name)),[sync.workspaces]);

  async function run(action:()=>Promise<void>) { setBusy(true); setMessage(null); try { await action(); } catch(cause) { setMessage(cause instanceof Error?cause.message:String(cause)); } finally { setBusy(false); } }
  async function copy(value:string) { await navigator.clipboard.writeText(value); setMessage("Copied to clipboard."); }

  async function create() { await run(async()=>{ const profile=await sync.createWorkspace(name.trim(),recoveryEmail.trim(),useCurrentData); setCreatedKey(profile.syncKey); setKey(profile.syncKey); setName(""); setMessage(`Created ${profile.name}. Copy the Sync Key, then open the workspace.`); setMode("overview"); }); }
  async function join() { await run(async()=>{ const profile=await sync.joinWorkspace(key.trim()); setCreatedKey(null); setKey(""); setMessage(`Connected ${profile.name}. Open it to pull its cloud data.`); setMode("overview"); }); }
  async function rotate() { await run(async()=>{ const next=await sync.rotateKey(); setCreatedKey(next); setShowKey(true); setMessage("Sync Key rotated. The previous key has been revoked; update other devices that used it."); }); }
  async function saveRecovery() { await run(async()=>{ await sync.setRecoveryEmail(recoveryEmail.trim()); setMessage("Recovery email saved. Send a verification link to activate recovery."); }); }
  async function sendVerification() { await run(async()=>{ setMessage(await sync.sendRecoveryEmail(recoveryEmail.trim(),"verify")); }); }
  async function completeVerification() { await run(async()=>{ await sync.completeRecoveryVerification(); setMessage("Recovery email verified."); }); }
  async function sendRecovery() { await run(async()=>{ setMessage(await sync.sendRecoveryEmail(recoveryEmail.trim(),"recover")); }); }
  async function findRecovered() { await run(async()=>{ const list=await sync.listRecoverableWorkspaces(); setRecoveryMatches(list); setMessage(list.length?"Choose a workspace to generate a replacement Sync Key.":"No verified TaskMap workspaces were found for that email."); }); }
  async function recover(id:string) { await run(async()=>{ const profile=await sync.recoverWorkspace(id); setCreatedKey(profile.syncKey); setKey(profile.syncKey); setMode("overview"); setRecoveryMatches([]); setMessage(`Recovered ${profile.name}. Copy the new key, then open the workspace.`); }); }

  if(!sync.configured) return <section className="settings-card sync-settings-card"><div><CloudOff size={18}/><h2>Online Sync</h2></div><p>TaskMap cloud is not configured for this build.</p><div className="sync-env-list"><code>NEXT_PUBLIC_SUPABASE_URL</code></div></section>;

  return <section className="settings-card sync-settings-card workspace-sync-card">
    <div><KeyRound size={18}/><h2>Online Sync Workspaces</h2></div>
    <p>Cloud Sync is opt-in. Each named workspace has its own Sync Key and isolated local database, so Personal, Work, and team environments stay separate even while offline.</p>

    <div className="workspace-list">
      <button className={!active?"workspace-row active":"workspace-row"} onClick={()=>sync.switchWorkspace(localWorkspaceId())}>
        <span className="workspace-radio">{!active?<Check size={14}/>:null}</span><span><strong>Local Only</strong><small>No cloud key · stored only on this device</small></span>
      </button>
      {sorted.map(profile=><div key={profile.id} className={active?.id===profile.id?"workspace-row active":"workspace-row"}>
        <button className="workspace-open" onClick={()=>sync.switchWorkspace(profile.id)}><span className="workspace-radio">{active?.id===profile.id?<Check size={14}/>:null}</span><span><strong>{profile.name}</strong><small>{profile.recoveryEmailVerified?`Recovery ${profile.recoveryEmailHint??"verified"}`:profile.recoveryEmailHint?`Recovery ${profile.recoveryEmailHint} · unverified`:"No recovery email"}</small></span></button>
        <button className="workspace-remove" title="Remove this workspace from this device" onClick={()=>void run(()=>sync.disconnectWorkspace(profile.id,false))}><Trash2 size={14}/></button>
      </div>)}
    </div>

    <div className="sync-actions workspace-create-actions">
      <button className="primary-button" onClick={()=>{setMode("create");setMessage(null);}}><Plus size={15}/> Create Sync Workspace</button>
      <button className="ghost-button" onClick={()=>{setMode("join");setMessage(null);}}><KeyRound size={15}/> Connect Existing Key</button>
      <button className="ghost-button" onClick={()=>{setMode("recover");setMessage(null);}}><Mail size={15}/> Recover Workspace</button>
    </div>

    {mode==="create"&&<div className="sync-subpanel">
      <h3>Create Sync Workspace</h3>
      <label className="sync-field"><span>Workspace name</span><input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="Personal, Work, Family…"/></label>
      <label className="sync-field"><span>Recovery email <em>optional</em></span><input type="email" value={recoveryEmail} onChange={e=>setRecoveryEmail(e.target.value)} placeholder="you@example.com"/></label>
      <div className="workspace-start-choice"><label><input type="radio" checked={useCurrentData} onChange={()=>setUseCurrentData(true)}/><span><strong>Use current TaskMap data</strong><small>Clone the workspace you are viewing into the new cloud workspace.</small></span></label><label><input type="radio" checked={!useCurrentData} onChange={()=>setUseCurrentData(false)}/><span><strong>Start empty</strong><small>Create an isolated environment without copying current tasks.</small></span></label></div>
      <div className="sync-actions"><button className="primary-button" disabled={busy||!name.trim()} onClick={()=>void create()}>{busy?"Creating…":"Create workspace"}</button><button className="ghost-button" onClick={()=>setMode("overview")}>Cancel</button></div>
    </div>}

    {mode==="join"&&<div className="sync-subpanel">
      <h3>Connect Existing Sync Key</h3><p>Paste a TaskMap key from another device or teammate. TaskMap discovers the workspace name automatically.</p>
      <label className="sync-field"><span>Sync Key</span><input autoFocus value={key} onChange={e=>setKey(e.target.value)} placeholder="TM1.…" autoCapitalize="off" autoCorrect="off" spellCheck={false}/></label>
      <div className="sync-actions"><button className="primary-button" disabled={busy||!key.trim()} onClick={()=>void join()}>{busy?"Connecting…":"Connect key"}</button><button className="ghost-button" onClick={()=>setMode("overview")}>Cancel</button></div>
    </div>}

    {mode==="recover"&&<div className="sync-subpanel">
      <h3>Recover Sync Workspace</h3><p>Recovery works only for a workspace whose recovery email was previously verified.</p>
      <label className="sync-field"><span>Recovery email</span><input type="email" value={recoveryEmail} onChange={e=>setRecoveryEmail(e.target.value)} placeholder="you@example.com"/></label>
      <div className="sync-actions"><button className="primary-button" disabled={busy||!recoveryEmail.trim()} onClick={()=>void sendRecovery()}><Mail size={14}/> Send recovery link</button><button className="ghost-button" disabled={busy} onClick={()=>void findRecovered()}><RefreshCw size={14}/> I opened the link</button><button className="ghost-button" onClick={()=>setMode("overview")}>Cancel</button></div>
      {recoveryMatches.length>0&&<div className="recovery-workspace-list">{recoveryMatches.map(item=><button key={item.id} onClick={()=>void recover(item.id)}><span><strong>{item.name}</strong><small>{item.recoveryEmailHint}</small></span><KeyRound size={15}/></button>)}</div>}
    </div>}

    {createdKey&&<div className="sync-key-callout"><div><ShieldCheck size={18}/><span><strong>Sync Key ready</strong><small>Anyone with this key can access the workspace. Store it somewhere safe.</small></span></div><code>{showKey?createdKey:"••••••••••••••••••••••••••••••••"}</code><div className="sync-actions"><button className="ghost-button" onClick={()=>setShowKey(v=>!v)}>{showKey?"Hide key":"Show key"}</button><button className="primary-button" onClick={()=>void copy(createdKey)}><Copy size={14}/> Copy key</button></div></div>}

    {active&&<div className="active-workspace-panel">
      <div className="active-workspace-heading"><div><Wifi size={17}/><span><strong>{active.name}</strong><small>{active.role} Sync Key · isolated local database</small></span></div><span className={`sync-status-badge ${sync.status}`}>{sync.status==="syncing"?"Syncing…":sync.status==="synced"?"Synced":sync.status==="offline"?"Offline":sync.status==="error"?"Error":"Ready"}</span></div>
      <div className="settings-row"><span>Pending local changes</span><strong>{sync.pending}</strong></div><div className="settings-row"><span>Last sync</span><strong>{sync.lastSyncAt?new Date(sync.lastSyncAt).toLocaleString():"Not yet"}</strong></div>
      <div className="sync-actions"><button className="primary-button" disabled={busy||sync.status==="syncing"} onClick={()=>void sync.syncNow()}><RefreshCw size={14}/> Sync now</button><button className="ghost-button" onClick={()=>{setCreatedKey(active.syncKey);setShowKey(v=>!v);}}><KeyRound size={14}/> {showKey?"Hide":"Show"} key</button><button className="ghost-button" onClick={()=>void copy(active.syncKey)}><Copy size={14}/> Copy key</button>{active.role==="owner"&&<button className="ghost-button" onClick={()=>void rotate()}><RotateCcw size={14}/> Rotate key</button>}</div>
      {showKey&&<code className="active-sync-key">{active.syncKey}</code>}
      {active.role==="owner"&&<div className="recovery-email-panel"><div><Mail size={16}/><span><strong>Recovery email</strong><small>{active.recoveryEmailVerified?`Verified · ${active.recoveryEmailHint}`:active.recoveryEmailHint?`Pending verification · ${active.recoveryEmailHint}`:"Optional — lets you recover access if a key is lost"}</small></span></div><label className="sync-field"><span>Email</span><input type="email" value={recoveryEmail} onChange={e=>setRecoveryEmail(e.target.value)} placeholder="you@example.com"/></label><div className="sync-actions"><button className="ghost-button" disabled={busy||!recoveryEmail.trim()} onClick={()=>void saveRecovery()}>Save email</button><button className="ghost-button" disabled={busy||!recoveryEmail.trim()} onClick={()=>void sendVerification()}><Mail size={14}/> Send verification</button><button className="ghost-button" disabled={busy} onClick={()=>void completeVerification()}><ShieldCheck size={14}/> I opened the link</button>{active.recoveryEmailHint&&<button className="ghost-button" onClick={()=>void run(()=>sync.clearRecoveryEmail())}>Remove</button>}</div></div>}
    </div>}

    {sync.error&&<p className="sync-error">{sync.error}</p>}{message&&<p className="sync-message">{message}</p>}
    <small>TaskMap stores Sync Keys only on devices you connect. The cloud stores a SHA-256 key hash, never the plaintext key. Recovery email uses a separate one-time email session only for verification/recovery.</small>
  </section>;
}
