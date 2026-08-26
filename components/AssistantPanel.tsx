"use client";

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Bug, Lightbulb, Send, Sparkles, X } from "lucide-react";
import { db } from "@/lib/db";
import { updateDevBacklogItem } from "@/lib/task-service";
import type { AssistantAction, Project, Task } from "@/lib/types";

type Message = { role: "user" | "assistant"; text: string };
type DestructiveAction = Extract<AssistantAction, { type: "delete_task" }>;

export default function AssistantPanel({ tasks, projects, onClose, onExecuteAction }: {
  tasks: Task[];
  projects: Project[];
  onClose: () => void;
  onExecuteAction: (action: AssistantAction) => Promise<void>;
}) {
  const backlog = useLiveQuery(() => db.devBacklog.orderBy("createdAt").reverse().toArray(), [], []);
  const templates = useLiveQuery(() => db.taskTemplates.orderBy("createdAt").reverse().toArray(), [], []);
  const [tab, setTab] = useState<"chat" | "backlog">("chat");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", text: "Ask me to create, organize, schedule, complete, or filter work in TaskMap. You can also tell me to remember a bug or feature for a future build." },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDestructive, setPendingDestructive] = useState<DestructiveAction[] | null>(null);

  const compactTasks = useMemo(() => tasks.map(task => ({
    title: task.title, notes: task.notes, tags: task.tags, status: task.status, priority: task.priority,
    projectId: task.projectId, parentTaskId: task.parentTaskId, startDate: task.startDate, startTime: task.startTime,
    estimatedMinutes: task.estimatedMinutes, dueDate: task.dueDate, dueTime: task.dueTime,
  })), [tasks]);

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setError(null);
    setMessages(current => [...current, { role: "user", text: message }]);
    setBusy(true);
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, tasks: compactTasks, projects, backlog, templates: templates.map(template => ({ name: template.name, nodes: template.nodes.map(node => ({ title: node.title, parentTemplateNodeId: node.parentTemplateNodeId })) })) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Assistant request failed.");
      const actions = Array.isArray(data?.actions) ? data.actions as AssistantAction[] : [];
      const destructive = actions.filter((action): action is DestructiveAction => action.type === "delete_task");
      const safe = actions.filter(action => action.type !== "delete_task");
      for (const action of safe) await onExecuteAction(action);
      if (destructive.length) {
        setPendingDestructive(destructive);
        setMessages(current => [...current, { role: "assistant", text: `${String(data?.reply || "I prepared the requested changes.")} I need your confirmation before I run ${destructive.length} destructive action${destructive.length === 1 ? "" : "s"}.` }]);
      } else {
        setMessages(current => [...current, { role: "assistant", text: String(data?.reply || (actions.length ? `Applied ${actions.length} action${actions.length === 1 ? "" : "s"}.` : "No changes made.")) }]);
      }
    } catch (cause) {
      const messageText = cause instanceof Error ? cause.message : "Assistant request failed.";
      setError(messageText);
      setMessages(current => [...current, { role: "assistant", text: messageText }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="assistant-panel">
      <div className="assistant-header">
        <div><Sparkles size={17} /><strong>Ask TaskMap</strong></div>
        <button onClick={onClose} aria-label="Close Ask TaskMap"><X size={18} /></button>
      </div>
      <div className="assistant-tabs">
        <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}><Sparkles size={14} /> Assistant</button>
        <button className={tab === "backlog" ? "active" : ""} onClick={() => setTab("backlog")}><Bug size={14} /> Dev backlog <span>{backlog.filter(item => item.status !== "done").length}</span></button>
      </div>

      {tab === "chat" ? (
        <>
          <div className="assistant-messages">
            {messages.map((message, index) => <div key={index} className={`assistant-message ${message.role}`}>{message.text}</div>)}
            {busy && <div className="assistant-message assistant">Working…</div>}
          </div>
          {error?.includes("OPENAI_API_KEY") && <div className="assistant-config-note">Add <code>OPENAI_API_KEY=...</code> to <code>.env.local</code>, then restart TaskMap. On Vercel, add the same variable in Project Settings → Environment Variables.</div>}
          {pendingDestructive && <div className="assistant-confirm"><strong>Confirm destructive changes?</strong><span>{pendingDestructive.map(action => `Delete task: ${action.taskTitle}`).join(" · ")}</span><div><button className="confirm-danger" onClick={async () => { const actions = pendingDestructive; setPendingDestructive(null); for (const action of actions) await onExecuteAction(action); setMessages(current => [...current, { role: "assistant", text: "Confirmed destructive changes were applied." }]); }}>Confirm</button><button onClick={() => { setPendingDestructive(null); setMessages(current => [...current, { role: "assistant", text: "Destructive changes canceled." }]); }}>Cancel</button></div></div>}
          <div className="assistant-compose">
            <textarea value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="Tell TaskMap what to do…" />
            <button onClick={() => void send()} disabled={!input.trim() || busy} aria-label="Send instruction"><Send size={17} /></button>
          </div>
        </>
      ) : (
        <div className="backlog-list">
          <div className="assistant-backlog-intro"><Lightbulb size={15} /> Hidden from normal task views. Ask the assistant to remember bugs, features, improvements, or ideas.</div>
          {backlog.length === 0 ? <div className="assistant-empty">No hidden development items yet.</div> : backlog.map(item => (
            <article key={item.id} className="backlog-item">
              <div className="backlog-item-top"><span className={`backlog-kind ${item.kind}`}>{item.kind}</span><select value={item.status} onChange={event => void updateDevBacklogItem(item.id, { status: event.target.value as typeof item.status })}><option value="open">Open</option><option value="planned">Planned</option><option value="done">Done</option></select></div>
              <strong>{item.title}</strong>
              {item.details && <p>{item.details}</p>}
              <small>{new Date(item.createdAt).toLocaleString()}</small>
            </article>
          ))}
        </div>
      )}
    </aside>
  );
}
