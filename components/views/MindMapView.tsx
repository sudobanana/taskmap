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
import { Search, Trash2 } from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { moveTaskNode, updateTask } from "@/lib/task-service";
import type { Project, Task } from "@/lib/types";

interface TaskNodeData extends Record<string, unknown> {
  label: string;
  priority: Task["priority"];
  done: boolean;
}

type TaskNode = Node<TaskNodeData, "taskNode">;
type MapScope = "all" | "project" | "parent";

function TaskFlowNode({ data }: NodeProps<TaskNode>) {
  return (
    <div className={`task-flow-node priority-${data.priority} ${data.done ? "done" : ""}`}>
      <Handle type="target" position={Position.Left} className="task-handle target-handle" />
      <span>{data.label}</span>
      <Handle type="source" position={Position.Right} className="task-handle source-handle" />
    </div>
  );
}

const nodeTypes = { taskNode: TaskFlowNode };

function descendants(tasks: Task[], parentId: string) {
  const result = new Set<string>();
  const queue = [parentId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const child of tasks.filter(task => task.parentTaskId === id)) {
      if (result.has(child.id)) continue;
      result.add(child.id);
      queue.push(child.id);
    }
  }
  return result;
}

export default function MindMapView({ tasks, projects, onSelect }: { tasks: Task[]; projects: Project[]; onSelect: (id: string) => void }) {
  const layouts = useLiveQuery(() => db.taskLayouts.toArray(), [], []);
  const [scope, setScope] = useState<MapScope>("all");
  const [projectId, setProjectId] = useState<string>("");
  const [parentId, setParentId] = useState<string>("");
  const [traySearch, setTraySearch] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [instance, setInstance] = useState<ReactFlowInstance<TaskNode, Edge> | null>(null);

  useEffect(() => {
    if (scope === "project" && !projectId && projects[0]) setProjectId(projects[0].id);
    if (scope === "parent" && !parentId && tasks[0]) setParentId(tasks[0].id);
  }, [scope, projectId, projects, parentId, tasks]);

  const mappedTasks = useMemo(() => {
    if (scope === "project") return projectId ? tasks.filter(task => task.projectId === projectId) : [];
    if (scope === "parent") {
      if (!parentId) return [];
      const ids = new Set([parentId, ...descendants(tasks, parentId)]);
      return tasks.filter(task => ids.has(task.id));
    }
    return tasks;
  }, [tasks, scope, projectId, parentId]);

  const mappedIds = useMemo(() => new Set(mappedTasks.map(task => task.id)), [mappedTasks]);
  const availableTasks = useMemo(() => tasks.filter(task => !mappedIds.has(task.id) && task.title.toLowerCase().includes(traySearch.trim().toLowerCase())), [tasks, mappedIds, traySearch]);

  const mapped = useMemo<TaskNode[]>(() => mappedTasks.map((task, index) => {
    const layout = layouts.find(item => item.taskId === task.id);
    return {
      id: task.id,
      type: "taskNode",
      position: { x: layout?.x ?? 100 + (index % 4) * 260, y: layout?.y ?? 100 + Math.floor(index / 4) * 150 },
      data: { label: task.title, priority: task.priority, done: task.status === "done" },
    };
  }), [mappedTasks, layouts]);

  const [nodes, setNodes] = useState<TaskNode[]>(mapped);
  useEffect(() => setNodes(mapped), [mapped]);

  const edges = useMemo<Edge[]>(() => mappedTasks
    .filter(task => task.parentTaskId && mappedIds.has(task.parentTaskId))
    .map(task => {
      const id = `${task.parentTaskId}-${task.id}`;
      const selected = selectedEdgeId === id;
      return {
        id,
        source: task.parentTaskId!,
        target: task.id,
        type: "smoothstep",
        deletable: true,
        selectable: true,
        selected,
        style: selected ? { stroke: "#5B5BD6", strokeWidth: 3 } : { stroke: "#A9AFB8", strokeWidth: 1.8 },
      };
    }), [mappedTasks, mappedIds, selectedEdgeId]);

  const onNodesChange = useCallback((changes: NodeChange<TaskNode>[]) => setNodes(current => applyNodeChanges(changes, current)), []);

  async function onConnect(connection: Connection) {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const source = tasks.find(task => task.id === connection.source);
    const target = tasks.find(task => task.id === connection.target);
    if (!source || !target) return;
    if (descendants(tasks, target.id).has(source.id)) return;
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
    if (scope === "parent" && parentId) {
      if (!descendants(tasks, task.id).has(parentId)) await updateTask(task.id, { parentTaskId: parentId }, "MAP_TASK_ADDED_TO_PARENT_SCOPE");
    }
    await moveTaskNode(task.id, position.x, position.y);
  }

  return (
    <section className="map-view">
      <div className="map-toolbar map-toolbar-rich">
        <div><p className="eyebrow">Visual planning</p><h1>Mind Map</h1></div>
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
          {selectedEdgeId && <button className="delete-edge-button" onClick={() => void deleteSelectedEdge()}><Trash2 size={15} /> Delete connection</button>}
        </div>
      </div>

      <div className="map-workspace">
        <div className="flow-wrap" onDragOver={event => event.preventDefault()} onDrop={event => void handleTrayDrop(event)}>
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
            minZoom={0.25}
            maxZoom={2}
            deleteKeyCode={["Backspace", "Delete"]}
            elementsSelectable
          >
            <Background gap={22} size={1} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        {scope !== "all" && (
          <aside className="map-task-tray">
            <div className="map-task-tray-heading"><strong>Available tasks</strong><span>{availableTasks.length}</span></div>
            <div className="map-tray-search"><Search size={14} /><input value={traySearch} onChange={event => setTraySearch(event.target.value)} placeholder="Search outside scope" /></div>
            <p>Drag a task onto the map to add it to the current {scope} scope.</p>
            <div className="map-tray-list">
              {availableTasks.map(task => (
                <button
                  key={task.id}
                  draggable
                  className="map-tray-task"
                  onDragStart={event => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/taskmap-task", task.id); event.dataTransfer.setData("text/plain", task.id); }}
                  onClick={() => onSelect(task.id)}
                >
                  <span className={`tray-priority ${task.priority}`} />
                  <span>{task.title}</span>
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
