"use client";

import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { ChevronDown, ChevronRight, GitBranch, LayoutTree, Plus, Repeat2, Search, Trash2 } from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { arrangeTaskNodes, createTask, moveTaskNode, setTaskNodeCollapsed, updateTask } from "@/lib/task-service";
import type { Project, Task, TaskLayout } from "@/lib/types";

interface TaskNodeData extends Record<string, unknown> {
  taskId: string;
  label: string;
  priority: Task["priority"];
  done: boolean;
  dimCompleted: boolean;
  projectName: string | null;
  dueDate: string | null;
  tags: string[];
  recurring: boolean;
  childCount: number;
  collapsed: boolean;
  orientation: MapOrientation;
  onToggleCollapse: (taskId: string) => void;
  onAddChild: (taskId: string) => void;
  onDropTask: (targetId: string, taskId: string) => void;
}

type TaskNode = Node<TaskNodeData, "taskNode">;
type MapScope = "all" | "project" | "parent";
type MapOrientation = "horizontal" | "vertical";
type CompletedMode = "dim" | "show" | "hide";

function TaskFlowNode({ data }: NodeProps<TaskNode>) {
  const targetPosition = data.orientation === "horizontal" ? Position.Left : Position.Top;
  const sourcePosition = data.orientation === "horizontal" ? Position.Right : Position.Bottom;
  return (
    <div
      className={`task-flow-node planning-node priority-${data.priority} ${data.done ? "done" : ""} ${data.dimCompleted ? "dim-completed" : ""}`}
      onDragOver={event => { event.preventDefault(); event.stopPropagation(); }}
      onDrop={event => {
        event.preventDefault();
        event.stopPropagation();
        const taskId = event.dataTransfer.getData("application/taskmap-task") || event.dataTransfer.getData("text/plain");
        if (taskId) data.onDropTask(data.taskId, taskId);
      }}
    >
      <Handle type="target" position={targetPosition} className="task-handle target-handle" />
      <div className="planning-node-topline">
        <span className={`planning-priority-dot ${data.priority}`} />
        {data.projectName && <span className="planning-project-pill">{data.projectName}</span>}
        {data.recurring && <span className="planning-repeat-pill"><Repeat2 size={10}/> Repeat</span>}
      </div>
      <div className="planning-node-title-row">
        <strong>{data.label}</strong>
        {data.childCount > 0 && (
          <button
            type="button"
            className="nodrag nopan planning-collapse-button"
            title={data.collapsed ? `Show ${data.childCount} child task${data.childCount === 1 ? "" : "s"}` : `Hide ${data.childCount} child task${data.childCount === 1 ? "" : "s"}`}
            onClick={event => { event.stopPropagation(); data.onToggleCollapse(data.taskId); }}
          >
            {data.collapsed ? <ChevronRight size={14}/> : <ChevronDown size={14}/>} {data.childCount}
          </button>
        )}
      </div>
      {(data.dueDate || data.tags.length > 0 || data.done) && (
        <div className="planning-node-meta">
          {data.done && <span className="planning-complete-pill">Completed</span>}
          {data.dueDate && <span>Due {data.dueDate}</span>}
          {data.tags.slice(0, 2).map(tag => <span key={tag} className="planning-tag-pill">#{tag}</span>)}
          {data.tags.length > 2 && <span>+{data.tags.length - 2}</span>}
        </div>
      )}
      <button
        type="button"
        className="nodrag nopan planning-add-child"
        title="Add child task"
        onClick={event => { event.stopPropagation(); data.onAddChild(data.taskId); }}
      ><Plus size={13}/></button>
      <Handle type="source" position={sourcePosition} className="task-handle source-handle" />
    </div>
  );
}

const nodeTypes = { taskNode: TaskFlowNode };

function descendants(tasks: Task[], parentId: string) {
  const result = new Set<string>();
  const queue = [parentId];
  const byParent = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.parentTaskId) continue;
    const children = byParent.get(task.parentTaskId) ?? [];
    children.push(task);
    byParent.set(task.parentTaskId, children);
  }
  while (queue.length) {
    const id = queue.shift()!;
    for (const child of byParent.get(id) ?? []) {
      if (result.has(child.id)) continue;
      result.add(child.id);
      queue.push(child.id);
    }
  }
  return result;
}

function hiddenByCollapsed(tasks: Task[], collapsedIds: Set<string>) {
  const hidden = new Set<string>();
  for (const parentId of collapsedIds) {
    for (const childId of descendants(tasks, parentId)) hidden.add(childId);
  }
  return hidden;
}

function buildTreeLayout(tasks: Task[], orientation: MapOrientation) {
  const ids = new Set(tasks.map(task => task.id));
  const byParent = new Map<string, Task[]>();
  const roots: Task[] = [];
  const sortTasks = (items: Task[]) => [...items].sort((a, b) => a.manualOrder - b.manualOrder || a.title.localeCompare(b.title));
  for (const task of tasks) {
    if (task.parentTaskId && ids.has(task.parentTaskId)) {
      const children = byParent.get(task.parentTaskId) ?? [];
      children.push(task);
      byParent.set(task.parentTaskId, children);
    } else roots.push(task);
  }
  for (const [id, children] of byParent) byParent.set(id, sortTasks(children));

  const positions = new Map<string, { x: number; y: number }>();
  let leafCursor = 0;
  const laneGap = orientation === "horizontal" ? 142 : 286;
  const depthGap = orientation === "horizontal" ? 300 : 170;
  const laneStart = 90;
  const depthStart = 90;

  function place(task: Task, depth: number): number {
    const children = byParent.get(task.id) ?? [];
    let lane: number;
    if (!children.length) {
      lane = laneStart + leafCursor * laneGap;
      leafCursor += 1;
    } else {
      const childLanes = children.map(child => place(child, depth + 1));
      lane = (childLanes[0] + childLanes[childLanes.length - 1]) / 2;
    }
    if (orientation === "horizontal") positions.set(task.id, { x: depthStart + depth * depthGap, y: lane });
    else positions.set(task.id, { x: lane, y: depthStart + depth * depthGap });
    return lane;
  }

  for (const root of sortTasks(roots)) {
    place(root, 0);
    leafCursor += 0.35;
  }
  return positions;
}

export default function MindMapView({ tasks, projects, onSelect }: { tasks: Task[]; projects: Project[]; onSelect: (id: string) => void }) {
  const layouts = useLiveQuery(() => db.taskLayouts.toArray(), [], []);
  const [scope, setScope] = useState<MapScope>("all");
  const [projectId, setProjectId] = useState<string>("");
  const [parentId, setParentId] = useState<string>("");
  const [orientation, setOrientation] = useState<MapOrientation>("horizontal");
  const [completedMode, setCompletedMode] = useState<CompletedMode>("dim");
  const [traySearch, setTraySearch] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [instance, setInstance] = useState<ReactFlowInstance<TaskNode, Edge> | null>(null);

  useEffect(() => {
    if (scope === "project" && !projectId && projects[0]) setProjectId(projects[0].id);
    if (scope === "parent" && !parentId && tasks[0]) setParentId(tasks[0].id);
  }, [scope, projectId, projects, parentId, tasks]);

  const scopedTasks = useMemo(() => {
    if (scope === "project") return projectId ? tasks.filter(task => task.projectId === projectId) : [];
    if (scope === "parent") {
      if (!parentId) return [];
      const ids = new Set([parentId, ...descendants(tasks, parentId)]);
      return tasks.filter(task => ids.has(task.id));
    }
    return tasks;
  }, [tasks, scope, projectId, parentId]);

  const layoutById = useMemo(() => new Map(layouts.map(layout => [layout.taskId, layout])), [layouts]);
  const collapsedIds = useMemo(() => new Set(layouts.filter(layout => layout.collapsed).map(layout => layout.taskId)), [layouts]);
  const collapsedHiddenIds = useMemo(() => hiddenByCollapsed(scopedTasks, collapsedIds), [scopedTasks, collapsedIds]);
  const canvasTasks = useMemo(() => scopedTasks.filter(task => !collapsedHiddenIds.has(task.id) && (completedMode !== "hide" || task.status !== "done")), [scopedTasks, collapsedHiddenIds, completedMode]);
  const canvasIds = useMemo(() => new Set(canvasTasks.map(task => task.id)), [canvasTasks]);
  const scopedIds = useMemo(() => new Set(scopedTasks.map(task => task.id)), [scopedTasks]);
  const availableTasks = useMemo(() => tasks.filter(task => !scopedIds.has(task.id) && task.title.toLowerCase().includes(traySearch.trim().toLowerCase())), [tasks, scopedIds, traySearch]);
  const autoPositions = useMemo(() => buildTreeLayout(canvasTasks, orientation), [canvasTasks, orientation]);

  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of scopedTasks) if (task.parentTaskId) counts.set(task.parentTaskId, (counts.get(task.parentTaskId) ?? 0) + 1);
    return counts;
  }, [scopedTasks]);

  const handleToggleCollapse = useCallback(async (taskId: string) => {
    const layout = layoutById.get(taskId);
    const currentNode = instance?.getNode(taskId);
    const fallback = currentNode?.position ?? autoPositions.get(taskId) ?? { x: 0, y: 0 };
    await setTaskNodeCollapsed(taskId, !(layout?.collapsed ?? false), fallback.x, fallback.y);
  }, [layoutById, instance, autoPositions]);

  const handleAddChild = useCallback(async (taskId: string) => {
    const parent = tasks.find(task => task.id === taskId);
    if (!parent) return;
    const child = await createTask({ title: "New subtask", parentTaskId: parent.id, projectId: parent.projectId, priority: "normal" });
    onSelect(child.id);
  }, [tasks, onSelect]);

  const handleDropOnNode = useCallback(async (targetId: string, taskId: string) => {
    if (targetId === taskId) return;
    const target = tasks.find(task => task.id === targetId);
    const dragged = tasks.find(task => task.id === taskId);
    if (!target || !dragged || descendants(tasks, dragged.id).has(target.id)) return;
    await updateTask(dragged.id, { parentTaskId: target.id, projectId: target.projectId ?? dragged.projectId }, "MAP_TASK_NESTED");
  }, [tasks]);

  const mapped = useMemo<TaskNode[]>(() => canvasTasks.map(task => {
    const saved = layoutById.get(task.id);
    const generated = autoPositions.get(task.id) ?? { x: 100, y: 100 };
    const project = projects.find(item => item.id === task.projectId) ?? null;
    return {
      id: task.id,
      type: "taskNode",
      position: saved ? { x: saved.x, y: saved.y } : generated,
      data: {
        taskId: task.id,
        label: task.title,
        priority: task.priority,
        done: task.status === "done",
        dimCompleted: task.status === "done" && completedMode === "dim",
        projectName: project?.name ?? null,
        dueDate: task.dueDate,
        tags: task.tags ?? [],
        recurring: Boolean(task.recurrence?.enabled),
        childCount: childCounts.get(task.id) ?? 0,
        collapsed: saved?.collapsed ?? false,
        orientation,
        onToggleCollapse: taskId => void handleToggleCollapse(taskId),
        onAddChild: taskId => void handleAddChild(taskId),
        onDropTask: (targetId, taskId) => void handleDropOnNode(targetId, taskId),
      },
    };
  }), [canvasTasks, layoutById, autoPositions, projects, childCounts, completedMode, orientation, handleToggleCollapse, handleAddChild, handleDropOnNode]);

  const [nodes, setNodes] = useState<TaskNode[]>(mapped);
  useEffect(() => setNodes(mapped), [mapped]);

  const edges = useMemo<Edge[]>(() => canvasTasks
    .filter(task => task.parentTaskId && canvasIds.has(task.parentTaskId))
    .map(task => {
      const id = `hierarchy:${task.parentTaskId}:${task.id}`;
      const selected = selectedEdgeId === id;
      return {
        id,
        source: task.parentTaskId!,
        target: task.id,
        type: "smoothstep",
        deletable: true,
        selectable: true,
        selected,
        className: "hierarchy-edge",
        style: selected ? { stroke: "#5B5BD6", strokeWidth: 3 } : { stroke: "#8F97A3", strokeWidth: 2 },
      };
    }), [canvasTasks, canvasIds, selectedEdgeId]);

  const onNodesChange = useCallback((changes: NodeChange<TaskNode>[]) => setNodes(current => applyNodeChanges(changes, current)), []);

  async function onConnect(connection: Connection) {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const source = tasks.find(task => task.id === connection.source);
    const target = tasks.find(task => task.id === connection.target);
    if (!source || !target || descendants(tasks, target.id).has(source.id)) return;
    await updateTask(target.id, { parentTaskId: source.id, projectId: source.projectId ?? target.projectId }, "TASK_PARENT_CONNECTED");
  }

  async function disconnectEdge(edge: Edge) {
    const target = tasks.find(task => task.id === edge.target);
    if (target && target.parentTaskId === edge.source) await updateTask(target.id, { parentTaskId: null }, "TASK_PARENT_DISCONNECTED");
    if (selectedEdgeId === edge.id) setSelectedEdgeId(null);
  }

  async function onEdgesDelete(deleted: Edge[]) {
    for (const edge of deleted) await disconnectEdge(edge);
  }

  async function deleteSelectedEdge() {
    const edge = edges.find(candidate => candidate.id === selectedEdgeId);
    if (edge) await disconnectEdge(edge);
  }

  async function handleTrayDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const taskId = event.dataTransfer.getData("application/taskmap-task") || event.dataTransfer.getData("text/plain");
    const task = tasks.find(candidate => candidate.id === taskId);
    if (!task || !instance) return;
    const position = instance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (scope === "project" && projectId) await updateTask(task.id, { projectId }, "MAP_TASK_ADDED_TO_PROJECT_SCOPE");
    if (scope === "parent" && parentId && !descendants(tasks, task.id).has(parentId)) await updateTask(task.id, { parentTaskId: parentId }, "MAP_TASK_ADDED_TO_PARENT_SCOPE");
    await moveTaskNode(task.id, position.x, position.y);
  }

  async function autoArrange() {
    const positions = buildTreeLayout(canvasTasks, orientation);
    const nextNodes = nodes.map(node => ({ ...node, position: positions.get(node.id) ?? node.position }));
    setNodes(nextNodes);
    await arrangeTaskNodes(nextNodes.map(node => ({ taskId: node.id, x: node.position.x, y: node.position.y })));
    requestAnimationFrame(() => instance?.fitView({ padding: 0.18, duration: 350 }));
  }

  const scopeLabel = scope === "project" ? projects.find(project => project.id === projectId)?.name ?? "Project" : scope === "parent" ? tasks.find(task => task.id === parentId)?.title ?? "Parent" : "All Tasks";

  return (
    <section className="map-view planning-map-view">
      <div className="map-toolbar map-toolbar-rich planning-map-toolbar">
        <div><p className="eyebrow">Visual planning</p><h1>Mind Map</h1><p className="map-scope-summary"><GitBranch size={13}/> {scopeLabel} · {canvasTasks.length} visible task{canvasTasks.length === 1 ? "" : "s"}</p></div>
        <div className="map-filter-controls">
          <label>Scope
            <select value={scope} onChange={event => { setScope(event.target.value as MapScope); setSelectedEdgeId(null); }}>
              <option value="all">All tasks</option>
              <option value="project">By project</option>
              <option value="parent">By parent</option>
            </select>
          </label>
          {scope === "project" && <label>Project<select value={projectId} onChange={event => setProjectId(event.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
          {scope === "parent" && <label>Parent<select value={parentId} onChange={event => setParentId(event.target.value)}>{tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>}
          <label>Layout<select value={orientation} onChange={event => setOrientation(event.target.value as MapOrientation)}><option value="horizontal">Left → right</option><option value="vertical">Top → bottom</option></select></label>
          <label>Completed<select value={completedMode} onChange={event => setCompletedMode(event.target.value as CompletedMode)}><option value="dim">Dim</option><option value="show">Show normally</option><option value="hide">Hide</option></select></label>
          <button className="ghost-button compact map-auto-arrange" onClick={() => void autoArrange()}><LayoutTree size={15}/> Auto Arrange</button>
          {selectedEdgeId && <button className="delete-edge-button" onClick={() => void deleteSelectedEdge()}><Trash2 size={15} /> Delete connection</button>}
        </div>
      </div>

      <div className="map-workspace planning-map-workspace">
        <div className="flow-wrap planning-flow-wrap" onDragOver={event => event.preventDefault()} onDrop={event => void handleTrayDrop(event)}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onInit={setInstance}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onEdgesDelete={onEdgesDelete}
            onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)}
            onPaneClick={() => setSelectedEdgeId(null)}
            onNodeClick={(_, node) => onSelect(node.id)}
            onNodeDragStop={(_, node) => void moveTaskNode(node.id, node.position.x, node.position.y)}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            minZoom={0.2}
            maxZoom={2}
            deleteKeyCode={["Backspace", "Delete"]}
            elementsSelectable
          >
            <Background gap={24} size={1} />
            <Controls />
            <MiniMap pannable zoomable nodeStrokeWidth={2} />
          </ReactFlow>
        </div>

        {scope !== "all" && (
          <aside className="map-task-tray planning-task-tray">
            <div className="map-task-tray-heading"><div><strong>Available tasks</strong><small>Outside this scope</small></div><span>{availableTasks.length}</span></div>
            <div className="map-tray-search"><Search size={14} /><input value={traySearch} onChange={event => setTraySearch(event.target.value)} placeholder="Search available tasks" /></div>
            <p>Drag onto empty canvas to add to this scope, or drop directly on a node to make it a child.</p>
            <div className="map-tray-list">
              {availableTasks.map(task => (
                <button
                  key={task.id}
                  draggable
                  className="map-tray-task planning-tray-task"
                  onDragStart={event => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/taskmap-task", task.id); event.dataTransfer.setData("text/plain", task.id); }}
                  onClick={() => onSelect(task.id)}
                >
                  <span className={`tray-priority ${task.priority}`} />
                  <span><strong>{task.title}</strong>{task.projectId && <small>{projects.find(project => project.id === task.projectId)?.name ?? "Project"}</small>}</span>
                </button>
              ))}
              {availableTasks.length === 0 && <div className="map-tray-empty">No tasks outside this filter.</div>}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
