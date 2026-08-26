"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, clearWorkspaceDatabase, cloneActiveDatabaseToWorkspace } from "@/lib/db";
import { getSupabaseClient } from "@/lib/supabase-client";
import { syncTaskMapWorkspace } from "@/lib/sync-service";
import { workspaceAction, workspaceApiConfigured, type CloudWorkspaceInfo } from "@/lib/workspace-api";
import {
  activateWorkspace,
  getActiveWorkspaceId,
  getActiveWorkspaceProfile,
  getWorkspaceProfiles,
  localWorkspaceId,
  removeWorkspaceProfile,
  upsertWorkspaceProfile,
  updateWorkspaceProfile,
  type LocalWorkspaceProfile,
} from "@/lib/workspace-storage";

export type CloudSyncStatus = "disabled" | "local_only" | "syncing" | "synced" | "error" | "offline";
type RecoveryWorkspace = { id:string; name:string; recoveryEmailHint:string|null; updatedAt:string };

type CloudSyncContextValue = {
  configured:boolean;
  workspaces:LocalWorkspaceProfile[];
  activeWorkspace:LocalWorkspaceProfile|null;
  activeWorkspaceId:string;
  status:CloudSyncStatus;
  pending:number;
  lastSyncAt:string|null;
  error:string|null;
  createWorkspace:(name:string,recoveryEmail:string,useCurrentData:boolean)=>Promise<LocalWorkspaceProfile>;
  joinWorkspace:(syncKey:string)=>Promise<LocalWorkspaceProfile>;
  switchWorkspace:(id:string)=>void;
  disconnectWorkspace:(id:string,deleteLocalCopy?:boolean)=>Promise<void>;
  syncNow:()=>Promise<void>;
  renameWorkspace:(name:string)=>Promise<void>;
  rotateKey:()=>Promise<string>;
  setRecoveryEmail:(email:string)=>Promise<void>;
  clearRecoveryEmail:()=>Promise<void>;
  sendRecoveryEmail:(email:string,mode:"verify"|"recover")=>Promise<string>;
  completeRecoveryVerification:()=>Promise<void>;
  listRecoverableWorkspaces:()=>Promise<RecoveryWorkspace[]>;
  recoverWorkspace:(workspaceId:string)=>Promise<LocalWorkspaceProfile>;
};

const CloudSyncContext = createContext<CloudSyncContextValue|null>(null);

function freshProfile(id:string|null|undefined) {
  if (!id) return null;
  return getWorkspaceProfiles().find(profile=>profile.id===id) ?? null;
}

export function CloudSyncProvider({children}:{children:ReactNode}) {
  const configured = workspaceApiConfigured();
  const [workspaces,setWorkspaces] = useState<LocalWorkspaceProfile[]>([]);
  const [activeWorkspaceId,setActiveWorkspaceId] = useState(localWorkspaceId());
  const [status,setStatus] = useState<CloudSyncStatus>(configured?"local_only":"disabled");
  const [lastSyncAt,setLastSyncAt] = useState<string|null>(null);
  const [error,setError] = useState<string|null>(null);
  const pending = useLiveQuery(()=>db.transactions.where("syncStatus").equals("pending").count(),[],0);
  const activeWorkspace = workspaces.find(profile=>profile.id===activeWorkspaceId) ?? null;

  const refreshProfiles = useCallback(()=>{
    const profiles = getWorkspaceProfiles();
    const activeId = getActiveWorkspaceId();
    if (activeId!==localWorkspaceId() && !profiles.some(profile=>profile.id===activeId)) activateWorkspace(localWorkspaceId());
    const actualId = getActiveWorkspaceId();
    setWorkspaces(profiles);
    setActiveWorkspaceId(actualId);
    const profile = profiles.find(item=>item.id===actualId) ?? null;
    setLastSyncAt(profile?.lastSyncAt ?? null);
    setStatus(!configured?"disabled":profile?(navigator.onLine?(profile.lastSyncAt?"synced":"syncing"):"offline"):"local_only");
  },[configured]);

  useEffect(()=>{ refreshProfiles(); },[refreshProfiles]);

  const syncNow = useCallback(async()=>{
    const profile = freshProfile(getActiveWorkspaceId());
    if (!configured || !profile) { setStatus(configured?"local_only":"disabled"); return; }
    if (!navigator.onLine) { setStatus("offline"); return; }
    setStatus("syncing"); setError(null);
    try {
      const result = await syncTaskMapWorkspace(profile);
      setLastSyncAt(result.syncedAt); setStatus("synced"); refreshProfiles();
    } catch(cause) {
      setError(cause instanceof Error?cause.message:String(cause)); setStatus("error");
    }
  },[configured,refreshProfiles]);

  useEffect(()=>{
    if (!activeWorkspace) return;
    void syncNow();
    const interval = window.setInterval(()=>{ if (navigator.onLine && document.visibilityState==="visible") void syncNow(); },15000);
    const onFocus=()=>void syncNow();
    const onOnline=()=>void syncNow();
    const onOffline=()=>setStatus("offline");
    window.addEventListener("focus",onFocus); window.addEventListener("online",onOnline); window.addEventListener("offline",onOffline);
    return()=>{ clearInterval(interval); window.removeEventListener("focus",onFocus); window.removeEventListener("online",onOnline); window.removeEventListener("offline",onOffline); };
  },[activeWorkspace?.id,syncNow]);

  useEffect(()=>{
    if (!activeWorkspace || pending<=0) return;
    const timer=setTimeout(()=>void syncNow(),700);
    return()=>clearTimeout(timer);
  },[pending,activeWorkspace?.id,syncNow]);

  const value = useMemo<CloudSyncContextValue>(()=>({
    configured,workspaces,activeWorkspace,activeWorkspaceId,status,pending,lastSyncAt,error,
    createWorkspace:async(name,recoveryEmail,useCurrentData)=>{
      const result = await workspaceAction<{workspace:CloudWorkspaceInfo&{created_at?:string};syncKey:string}>("create_workspace",{name,recoveryEmail:recoveryEmail.trim()||null});
      if (useCurrentData) await cloneActiveDatabaseToWorkspace(result.workspace.id); else await clearWorkspaceDatabase(result.workspace.id);
      const now=new Date().toISOString();
      const profile:LocalWorkspaceProfile={id:result.workspace.id,name:result.workspace.name,syncKey:result.syncKey,role:result.workspace.role,recoveryEmailHint:result.workspace.recoveryEmailHint,recoveryEmailVerified:false,createdAt:now,lastUsedAt:now,lastSyncAt:null,cursor:null,source:"created",bootstrapOnFirstSync:true,hasSynced:false};
      upsertWorkspaceProfile(profile); refreshProfiles(); return profile;
    },
    joinWorkspace:async(syncKey)=>{
      const result=await workspaceAction<{workspace:CloudWorkspaceInfo;entityCount:number}>("workspace_info",{}, {syncKey:syncKey.trim()});
      const existing=freshProfile(result.workspace.id); const now=new Date().toISOString();
      const profile:LocalWorkspaceProfile={id:result.workspace.id,name:result.workspace.name,syncKey:syncKey.trim(),role:result.workspace.role,recoveryEmailHint:result.workspace.recoveryEmailHint,recoveryEmailVerified:result.workspace.recoveryEmailVerified,createdAt:existing?.createdAt??now,lastUsedAt:now,lastSyncAt:existing?.lastSyncAt??null,cursor:existing?.cursor??null,source:existing?.source??"joined",bootstrapOnFirstSync:false,hasSynced:existing?.hasSynced??false};
      if (!existing) await clearWorkspaceDatabase(profile.id);
      upsertWorkspaceProfile(profile); refreshProfiles(); return profile;
    },
    switchWorkspace:id=>{ activateWorkspace(id); window.location.reload(); },
    disconnectWorkspace:async(id,deleteLocalCopy=false)=>{ if(deleteLocalCopy) await clearWorkspaceDatabase(id); removeWorkspaceProfile(id); if(getActiveWorkspaceId()===localWorkspaceId()) window.location.reload(); else refreshProfiles(); },
    syncNow,
    renameWorkspace:async name=>{
      const profile=getActiveWorkspaceProfile(); if(!profile) throw new Error("No active Sync Workspace");
      const result=await workspaceAction<{workspace:{name:string}}>("rename_workspace",{name},{syncKey:profile.syncKey});
      updateWorkspaceProfile(profile.id,{name:result.workspace.name}); refreshProfiles();
    },
    rotateKey:async()=>{
      const profile=getActiveWorkspaceProfile(); if(!profile) throw new Error("No active Sync Workspace");
      const result=await workspaceAction<{syncKey:string}>("rotate_key",{}, {syncKey:profile.syncKey});
      updateWorkspaceProfile(profile.id,{syncKey:result.syncKey}); refreshProfiles(); return result.syncKey;
    },
    setRecoveryEmail:async email=>{
      const profile=getActiveWorkspaceProfile(); if(!profile) throw new Error("No active Sync Workspace");
      const result=await workspaceAction<{recoveryEmailHint:string;recoveryEmailVerified:boolean}>("set_recovery_email",{email},{syncKey:profile.syncKey});
      updateWorkspaceProfile(profile.id,{recoveryEmailHint:result.recoveryEmailHint,recoveryEmailVerified:false}); refreshProfiles();
    },
    clearRecoveryEmail:async()=>{
      const profile=getActiveWorkspaceProfile(); if(!profile) throw new Error("No active Sync Workspace");
      await workspaceAction("clear_recovery_email",{}, {syncKey:profile.syncKey});
      updateWorkspaceProfile(profile.id,{recoveryEmailHint:null,recoveryEmailVerified:false}); refreshProfiles();
    },
    sendRecoveryEmail:async(email,mode)=>{
      const supabase=getSupabaseClient(); if(!supabase) throw new Error("Supabase email recovery is not configured");
      const {error:authError}=await supabase.auth.signInWithOtp({email:email.trim(),options:{shouldCreateUser:true,emailRedirectTo:window.location.origin+window.location.pathname}});
      if(authError) throw authError;
      localStorage.setItem("taskmap.recoveryMode",mode);
      return "Recovery link sent. Open the link in this browser, then return to Settings to finish.";
    },
    completeRecoveryVerification:async()=>{
      const profile=getActiveWorkspaceProfile(); if(!profile) throw new Error("No active Sync Workspace");
      const supabase=getSupabaseClient(); if(!supabase) throw new Error("Supabase email recovery is not configured");
      const {data}=await supabase.auth.getSession(); const token=data.session?.access_token; if(!token) throw new Error("Open the verification link from your email first");
      const result=await workspaceAction<{recoveryEmailHint:string;recoveryEmailVerified:boolean}>("verify_recovery_email",{}, {syncKey:profile.syncKey,recoveryToken:token});
      updateWorkspaceProfile(profile.id,{recoveryEmailHint:result.recoveryEmailHint,recoveryEmailVerified:true}); await supabase.auth.signOut(); localStorage.removeItem("taskmap.recoveryMode"); refreshProfiles();
    },
    listRecoverableWorkspaces:async()=>{
      const supabase=getSupabaseClient(); if(!supabase) throw new Error("Supabase email recovery is not configured");
      const {data}=await supabase.auth.getSession(); const token=data.session?.access_token; if(!token) throw new Error("Open the recovery link from your email first");
      const result=await workspaceAction<{workspaces:RecoveryWorkspace[]}>("recovery_list",{}, {recoveryToken:token}); return result.workspaces;
    },
    recoverWorkspace:async workspaceId=>{
      const supabase=getSupabaseClient(); if(!supabase) throw new Error("Supabase email recovery is not configured");
      const {data}=await supabase.auth.getSession(); const token=data.session?.access_token; if(!token) throw new Error("Open the recovery link from your email first");
      const result=await workspaceAction<{workspace:CloudWorkspaceInfo;syncKey:string}>("recovery_new_key",{workspaceId},{recoveryToken:token});
      const now=new Date().toISOString(); const existing=freshProfile(result.workspace.id);
      const profile:LocalWorkspaceProfile={id:result.workspace.id,name:result.workspace.name,syncKey:result.syncKey,role:result.workspace.role,recoveryEmailHint:result.workspace.recoveryEmailHint,recoveryEmailVerified:true,createdAt:existing?.createdAt??now,lastUsedAt:now,lastSyncAt:existing?.lastSyncAt??null,cursor:existing?.cursor??null,source:"recovered",bootstrapOnFirstSync:false,hasSynced:existing?.hasSynced??false};
      if(!existing) await clearWorkspaceDatabase(profile.id); upsertWorkspaceProfile(profile); await supabase.auth.signOut(); localStorage.removeItem("taskmap.recoveryMode"); refreshProfiles(); return profile;
    },
  }),[configured,workspaces,activeWorkspace,activeWorkspaceId,status,pending,lastSyncAt,error,syncNow,refreshProfiles]);

  return <CloudSyncContext.Provider value={value}>{children}</CloudSyncContext.Provider>;
}

export function useCloudSync(){ const value=useContext(CloudSyncContext); if(!value) throw new Error("useCloudSync must be used inside CloudSyncProvider"); return value; }
