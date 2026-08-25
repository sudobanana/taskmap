"use client";

import { useMemo, useState, type DragEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { CopyPlus, FileStack, GripVertical, Pencil, Plus, Trash2, X } from "lucide-react";
import { db } from "@/lib/db";
import { createTaskTemplate, deleteTaskTemplate, updateTaskTemplate, useTaskTemplate } from "@/lib/task-service";
import type { Project, TaskTemplate, TaskTemplateNode } from "@/lib/types";

function newNode(title: string, parentTemplateNodeId: string | null = null): TaskTemplateNode {
  return { templateNodeId: crypto.randomUUID(), parentTemplateNodeId, title, notes: "", tags: [], priority: "normal", projectId: null, estimatedMinutes: null, recurrence: null };
}

function orderedEntries(nodes: TaskTemplateNode[]) {
  const ids = new Set(nodes.map(node => node.templateNodeId));
  const byParent = new Map<string | null, TaskTemplateNode[]>();
  for (const node of nodes) {
    const parent = node.parentTemplateNodeId && ids.has(node.parentTemplateNodeId) ? node.parentTemplateNodeId : null;
    const list = byParent.get(parent) ?? [];
    list.push(node);
    byParent.set(parent,list);
  }
  const out: Array<{node:TaskTemplateNode;depth:number}> = [];
  const seen = new Set<string>();
  const walk = (node:TaskTemplateNode, depth:number) => {
    if (seen.has(node.templateNodeId)) return;
    seen.add(node.templateNodeId);
    out.push({node,depth});
    for (const child of byParent.get(node.templateNodeId) ?? []) walk(child,depth+1);
  };
  for (const root of byParent.get(null) ?? []) walk(root,0);
  for (const node of nodes) if (!seen.has(node.templateNodeId)) walk(node,0);
  return out;
}

function templateDescendantIds(nodes: TaskTemplateNode[], parentId: string) {
  const found = new Set<string>();
  const queue = [parentId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of nodes.filter(node => node.parentTemplateNodeId === current)) {
      if (found.has(child.templateNodeId)) continue;
      found.add(child.templateNodeId);
      queue.push(child.templateNodeId);
    }
  }
  return found;
}

export default function TemplatesView({ projects, onUsed }: { projects: Project[]; onUsed: (rootTaskId: string) => void }) {
  const templates = useLiveQuery(() => db.taskTemplates.orderBy("createdAt").reverse().toArray(), [], []);
  const [editing, setEditing] = useState<TaskTemplate | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [quickTitle, setQuickTitle] = useState("");
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{id:string;mode:"before"|"nest"|"after"}|null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selectedNode = editing?.nodes.find(node => node.templateNodeId === selectedNodeId) ?? null;
  const entries = useMemo(()=>orderedEntries(editing?.nodes ?? []),[editing]);

  function beginNew() {
    const now = new Date().toISOString();
    setEditing({ id: crypto.randomUUID(), name: "Untitled Template", description: "", nodes: [], createdAt: now, updatedAt: now });
    setIsNew(true); setSelectedNodeId(null); setQuickTitle(""); setMessage(null);
  }

  function beginEdit(template: TaskTemplate) {
    setEditing(structuredClone(template));
    setIsNew(false);
    setSelectedNodeId(template.nodes.find(node=>!node.parentTemplateNodeId)?.templateNodeId ?? template.nodes[0]?.templateNodeId ?? null);
    setQuickTitle(""); setMessage(null);
  }

  function patchEditing(patch: Partial<TaskTemplate>) { setEditing(current => current ? {...current,...patch} : current); }
  function patchNode(id:string, patch:Partial<TaskTemplateNode>) {
    setEditing(current => current ? {...current,nodes:current.nodes.map(node=>node.templateNodeId===id?{...node,...patch}:node)} : current);
  }

  function addQuickNodes() {
    if (!editing) return;
    const titles = quickTitle.split(",").map(title=>title.trim()).filter(Boolean);
    if (!titles.length) return;
    const parentId = selectedNodeId;
    const made = titles.map(title=>newNode(title,parentId));
    patchEditing({nodes:[...editing.nodes,...made]});
    setSelectedNodeId(made[0].templateNodeId);
    setQuickTitle("");
  }

  function deleteNode(id:string) {
    if (!editing) return;
    const children = editing.nodes.filter(node=>node.parentTemplateNodeId===id);
    const next = editing.nodes.filter(node=>node.templateNodeId!==id).map(node=>node.parentTemplateNodeId===id?{...node,parentTemplateNodeId:null}:node);
    patchEditing({nodes:next});
    if (selectedNodeId===id) setSelectedNodeId(children[0]?.templateNodeId ?? next[0]?.templateNodeId ?? null);
  }

  function modeFromEvent(event:DragEvent<HTMLDivElement>) {
    const box=event.currentTarget.getBoundingClientRect(); const ratio=(event.clientY-box.top)/Math.max(1,box.height);
    return ratio<.25?"before":ratio>.75?"after":"nest";
  }

  function dropNode(targetId:string, mode:"before"|"nest"|"after") {
    if (!editing || !draggingNodeId || draggingNodeId===targetId) return;
    const dragged=editing.nodes.find(node=>node.templateNodeId===draggingNodeId); const target=editing.nodes.find(node=>node.templateNodeId===targetId);
    if (!dragged||!target) return;
    const descendants=new Set<string>(); const queue=[dragged.templateNodeId]; while(queue.length){const id=queue.shift()!; for(const child of editing.nodes.filter(node=>node.parentTemplateNodeId===id)){if(!descendants.has(child.templateNodeId)){descendants.add(child.templateNodeId);queue.push(child.templateNodeId);}}}
    if (mode==="nest") { if(descendants.has(targetId)) return; patchNode(dragged.templateNodeId,{parentTemplateNodeId:target.templateNodeId}); }
    else {
      const without=editing.nodes.filter(node=>node.templateNodeId!==dragged.templateNodeId);
      const idx=without.findIndex(node=>node.templateNodeId===targetId)+(mode==="after"?1:0);
      const moved={...dragged,parentTemplateNodeId:target.parentTemplateNodeId};
      patchEditing({nodes:[...without.slice(0,idx),moved,...without.slice(idx)]});
    }
    setDraggingNodeId(null); setDropTarget(null);
  }

  async function saveTemplate() {
    if (!editing || !editing.name.trim() || !editing.nodes.length) return;
    if (isNew) await createTaskTemplate(editing.name,editing.nodes,editing.description);
    else await updateTaskTemplate(editing.id,{name:editing.name.trim(),description:editing.description,nodes:editing.nodes});
    setMessage(isNew?"Template created.":"Template saved."); setEditing(null); setSelectedNodeId(null); setIsNew(false);
  }

  if (editing) return <section className="content template-page">
    <div className="page-heading"><div><p className="eyebrow">Template task list</p><h1>{isNew?"New Template":"Edit Template"}</h1><p className="subtitle">Build this exactly like a task hierarchy. Select a row, then Quick Add creates children under it.</p></div><div className="template-top-actions"><button className="ghost-button" onClick={()=>setEditing(null)}><X size={15}/> Cancel</button><button className="primary-button" disabled={!editing.nodes.length || !editing.name.trim()} onClick={()=>void saveTemplate()}>Save template</button></div></div>
    <div className="template-name-row"><label>Template name<input value={editing.name} onChange={e=>patchEditing({name:e.target.value})}/></label><label>Description<input value={editing.description} onChange={e=>patchEditing({description:e.target.value})} placeholder="Reusable workflow"/></label></div>
    <div className="template-task-workspace">
      <div className="task-panel template-task-panel">
        <div className="task-panel-header"><div><h2>Template Tasks</h2><span>{editing.nodes.length} item{editing.nodes.length===1?"":"s"}</span></div></div>
        <div className="quick-add"><Plus size={18}/><input value={quickTitle} onChange={e=>setQuickTitle(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")addQuickNodes();}} placeholder={selectedNode?`Add child task(s) under ${selectedNode.title} — commas supported`:`Add task(s) — commas supported`}/></div>
        <div className="task-list">{entries.length===0?<div className="empty-state">Add the parent task first, select it, then add its child tasks.</div>:entries.map(({node,depth})=><div key={node.templateNodeId} className={`task-row template-task-row ${selectedNodeId===node.templateNodeId?"selected":""} ${dropTarget?.id===node.templateNodeId?`drop-${dropTarget.mode}`:""}`} style={{paddingLeft:`${18+depth*26}px`}} draggable onDragStart={e=>{e.dataTransfer.effectAllowed="move";setDraggingNodeId(node.templateNodeId)}} onDragOver={e=>{e.preventDefault();setDropTarget({id:node.templateNodeId,mode:modeFromEvent(e)})}} onDrop={e=>{e.preventDefault();dropNode(node.templateNodeId,modeFromEvent(e))}} onDragEnd={()=>{setDraggingNodeId(null);setDropTarget(null)}} onClick={()=>setSelectedNodeId(node.templateNodeId)}>
          <span className="drag-handle"><GripVertical size={15}/></span><div className="task-copy"><strong>{node.title}</strong><div className="task-meta">{node.estimatedMinutes!=null&&<span>{node.estimatedMinutes}m</span>}{node.projectId&&<span>{projects.find(p=>p.id===node.projectId)?.name}</span>}</div></div><span className={`priority ${node.priority}`}>{node.priority==="urgent"?"!!!":node.priority==="high"?"!!":node.priority==="normal"?"!":"–"}</span>
        </div>)}</div>
      </div>
      <aside className="template-node-inspector">{selectedNode?<>
        <div className="inspector-header"><span>Template task details</span><button onClick={()=>setSelectedNodeId(null)}>×</button></div>
        <label>Title<input value={selectedNode.title} onChange={e=>patchNode(selectedNode.templateNodeId,{title:e.target.value})}/></label>
        <div className="template-detail-grid"><label>Priority<select value={selectedNode.priority} onChange={e=>patchNode(selectedNode.templateNodeId,{priority:e.target.value as TaskTemplateNode["priority"]})}><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label><label>Duration<input type="number" min="0" step="15" value={selectedNode.estimatedMinutes??""} onChange={e=>patchNode(selectedNode.templateNodeId,{estimatedMinutes:e.target.value===""?null:Math.max(0,Number(e.target.value))})}/></label></div>
        <label>Project<select value={selectedNode.projectId??""} onChange={e=>patchNode(selectedNode.templateNodeId,{projectId:e.target.value||null})}><option value="">No project</option>{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label>Parent<select value={selectedNode.parentTemplateNodeId??""} onChange={e=>patchNode(selectedNode.templateNodeId,{parentTemplateNodeId:e.target.value||null})}><option value="">No parent</option>{editing.nodes.filter(node=>node.templateNodeId!==selectedNode.templateNodeId && !templateDescendantIds(editing.nodes,selectedNode.templateNodeId).has(node.templateNodeId)).map(node=><option key={node.templateNodeId} value={node.templateNodeId}>{node.title}</option>)}</select></label>
        <label>Tags<input value={selectedNode.tags.join(", ")} onChange={e=>patchNode(selectedNode.templateNodeId,{tags:e.target.value.split(",").map(v=>v.trim()).filter(Boolean)})}/></label>
        <label>Notes<textarea value={selectedNode.notes} onChange={e=>patchNode(selectedNode.templateNodeId,{notes:e.target.value})}/></label>
        <button className="danger-button template-delete-node" onClick={()=>deleteNode(selectedNode.templateNodeId)}><Trash2 size={14}/> Delete template task</button>
      </>:<div className="template-inspector-empty">Select a template task to edit its fields.</div>}</aside>
    </div>
  </section>;

  return <section className="content template-page">
    <div className="page-heading"><div><p className="eyebrow">Reusable workflows</p><h1>Templates</h1><p className="subtitle">Create a task hierarchy once, then generate a fresh copy whenever you need it.</p></div><button className="primary-button" onClick={beginNew}><Plus size={16}/> New template</button></div>
    {message&&<div className="template-message">{message}<button onClick={()=>setMessage(null)}>×</button></div>}
    <div className="template-grid">{templates.map(template=>{const roots=orderedEntries(template.nodes).filter(entry=>entry.depth===0);return <article className="template-card" key={template.id}>
      <div className="template-card-head"><div><FileStack size={17}/><strong>{template.name}</strong></div><div className="template-card-actions"><button title="Edit template" onClick={()=>beginEdit(template)}><Pencil size={14}/></button><button className="icon-danger" title="Delete template" onClick={()=>void deleteTaskTemplate(template.id)}><Trash2 size={15}/></button></div></div>
      {template.description&&<p>{template.description}</p>}<div className="template-tree">{orderedEntries(template.nodes).slice(0,12).map(({node,depth})=><span key={node.templateNodeId} style={{paddingLeft:`${depth*15}px`}}>{depth?"↳ ":""}{node.title}</span>)}{template.nodes.length>12&&<small>+ {template.nodes.length-12} more</small>}</div>
      <button className="secondary-button" onClick={async()=>{const made=await useTaskTemplate(template.id);const root=made.find(task=>!task.parentTaskId)??made[0];setMessage(`Created ${made.length} tasks from ${template.name}.`);if(root)onUsed(root.id);}}><CopyPlus size={15}/> Use template</button>
    </article>})}{!templates.length&&<div className="empty-state template-empty">No templates yet. Create one or save an existing task hierarchy as a template from Task Details.</div>}</div>
  </section>;
}
