"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronDown, ChevronRight } from "lucide-react";
import { db } from "@/lib/db";

export default function HistoryPanel({ taskId }: { taskId: string }) {
  const [open,setOpen] = useState(false);
  const txs = useLiveQuery(()=>db.transactions.where("entityId").equals(taskId).reverse().sortBy("clientTimestamp"),[taskId],[]);
  const changes = useLiveQuery(()=>db.transactionChanges.toArray(),[],[]);
  return <div className={`history ${open ? "open" : "collapsed"}`}>
    <button className="history-toggle" onClick={()=>setOpen(value=>!value)} aria-expanded={open}>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<span>Transaction history</span><small>{txs.length}</small></button>
    {open && <div className="history-body">{txs.slice(0,8).map(tx=>{const rows=changes.filter(c=>c.transactionId===tx.id && c.fieldName!=="updatedAt" && c.fieldName!=="revision");return <div className="history-item" key={tx.id}><div><strong>{tx.actionType.replaceAll("_"," ").toLowerCase()}</strong><span>{new Date(tx.clientTimestamp).toLocaleTimeString([], {hour:"numeric",minute:"2-digit"})}</span></div>{rows.slice(0,4).map(c=><small key={c.id}>{c.fieldName}: {String(c.oldValue ?? "—")} → {typeof c.newValue === "object" ? "created/updated" : String(c.newValue ?? "—")}</small>)}</div>})}{!txs.length && <div className="history-empty">No transactions yet.</div>}</div>}
  </div>;
}
