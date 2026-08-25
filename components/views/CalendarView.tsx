"use client";

import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight, GripVertical } from "lucide-react";
import type { Task } from "@/lib/types";
import { formatDuration, formatTime, localDateOnly } from "@/lib/format";
import { updateTask } from "@/lib/task-service";
import { virtualOccurrencesForDate } from "@/lib/recurrence";

const startHour = 6;
const endHour = 23;
const pxPerMinute = 1.05;
const snapMinutes = 15;
const minDuration = 15;

function parseDateOnly(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function formatDateHeading(value: string) {
  return parseDateOnly(value).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function shiftDate(value: string, amount: number) {
  const date = parseDateOnly(value);
  date.setDate(date.getDate() + amount);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timeToMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function minutesToTime(value: number) {
  const minutes = Math.max(0, Math.min(23 * 60 + 59, Math.round(value)));
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function snap(value: number) {
  return Math.round(value / snapMinutes) * snapMinutes;
}

export default function CalendarView({ tasks, onSelect }: { tasks: Task[]; onSelect: (id: string) => void }) {
  const today = localDateOnly();
  const [selectedDate, setSelectedDate] = useState(today);
  const [now, setNow] = useState(() => new Date());
  const [timelineDropActive, setTimelineDropActive] = useState(false);
  const [dayDropActive, setDayDropActive] = useState(false);
  const dayZoneRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const allDay = tasks.filter(task => !task.startTime && (
    task.dueDate === selectedDate ||
    task.startDate === selectedDate ||
    (task.priority === "urgent" && selectedDate === today)
  ));
  const timed = tasks.filter(task => task.startDate === selectedDate && task.startTime);
  const virtualRecurring = virtualOccurrencesForDate(tasks, selectedDate);
  const virtualDayTasks = virtualRecurring.filter(item => !item.startTime);
  const virtualTimed = virtualRecurring.filter((item): item is typeof item & { startTime: string } => Boolean(item.startTime));
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const currentLineTop = (currentMinute - startHour * 60) * pxPerMinute;
  const showCurrentLine = selectedDate === today && currentMinute >= startHour * 60 && currentMinute <= endHour * 60;

  async function scheduleDroppedTask(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setTimelineDropActive(false);
    const taskId = event.dataTransfer.getData("application/taskmap-calendar-task") || event.dataTransfer.getData("application/taskmap-task") || event.dataTransfer.getData("text/plain");
    const task = tasks.find(candidate => candidate.id === taskId);
    const timeline = timelineRef.current;
    if (!task || !timeline) return;
    const box = timeline.getBoundingClientRect();
    const offsetMinutes = snap((event.clientY - box.top) / pxPerMinute);
    const startMinutes = Math.max(startHour * 60, Math.min(endHour * 60 - minDuration, startHour * 60 + offsetMinutes));
    await updateTask(task.id, { startDate: selectedDate, startTime: minutesToTime(startMinutes) }, "CALENDAR_TASK_SCHEDULED_BY_DROP");
  }

  function overDayTasks(clientX: number, clientY: number) {
    const zone = dayZoneRef.current;
    if (!zone) return false;
    const box = zone.getBoundingClientRect();
    return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
  }

  return (
    <section className="calendar-page">
      <div className="page-heading calendar-heading">
        <div>
          <p className="eyebrow">{selectedDate === today ? "Today" : "Daily schedule"}</p>
          <h1>Calendar</h1>
          <p className="subtitle">Drag Day Tasks onto a time to schedule them. Drag scheduled blocks back into Day Tasks to unschedule.</p>
        </div>
        <div className="calendar-nav">
          <button onClick={() => setSelectedDate(date => shiftDate(date, -1))} aria-label="Previous day"><ChevronLeft size={17} /></button>
          <button className="calendar-today-button" onClick={() => setSelectedDate(today)}>Today</button>
          <button onClick={() => setSelectedDate(date => shiftDate(date, 1))} aria-label="Next day"><ChevronRight size={17} /></button>
        </div>
      </div>

      <div className="calendar-date-title">{formatDateHeading(selectedDate)}</div>
      <div className="calendar-card">
        <div ref={dayZoneRef} className={`all-day-zone ${dayDropActive ? "calendar-drop-active" : ""}`}>
          <div className="all-day-label">Day tasks</div>
          <div className="all-day-tasks">
            {allDay.map(task => (
              <button
                key={task.id}
                draggable
                onDragStart={event => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("application/taskmap-calendar-task", task.id);
                  event.dataTransfer.setData("text/plain", task.id);
                }}
                onDragEnd={() => setTimelineDropActive(false)}
                onClick={() => onSelect(task.id)}
                className={`all-day-chip ${task.priority} ${task.status === "done" ? "completed-calendar-item" : ""}`}
                title="Drag onto the timeline to schedule"
              >
                <GripVertical size={13} />
                <span>{task.status === "done" ? "✓ " : task.priority === "urgent" ? "!!! " : ""}{task.title}{task.estimatedMinutes ? ` · ${formatDuration(task.estimatedMinutes)}` : ""}</span>
              </button>
            ))}
            {virtualDayTasks.map(item => <button key={item.key} className={`all-day-chip virtual-recurring ${item.priority}`} onClick={() => onSelect(item.sourceTaskId)} title="Projected recurring occurrence — not stored yet"><span>↻ {item.title} · projected</span></button>)}
            {allDay.length === 0 && virtualDayTasks.length === 0 && <span className="calendar-empty-note">No unscheduled tasks for this day.</span>}
          </div>
        </div>

        <div
          ref={timelineRef}
          className={`timeline ${timelineDropActive ? "calendar-timeline-drop-active" : ""}`}
          style={{ height: (endHour - startHour) * 60 * pxPerMinute }}
          onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setTimelineDropActive(true); }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTimelineDropActive(false); }}
          onDrop={event => void scheduleDroppedTask(event)}
        >
          {Array.from({ length: endHour - startHour + 1 }, (_, index) => startHour + index).map(hour => (
            <div key={hour} className="hour-line" style={{ top: (hour - startHour) * 60 * pxPerMinute }}><span>{new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" })}</span></div>
          ))}
          {showCurrentLine && (
            <div className="current-time-line" style={{ top: currentLineTop }}>
              <span>{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
            </div>
          )}
          {virtualTimed.map(item => { const start = timeToMinutes(item.startTime); const top = (start - startHour * 60) * pxPerMinute; const height = Math.max(minDuration * pxPerMinute, (item.estimatedMinutes ?? 30) * pxPerMinute); return <button key={item.key} className={`calendar-block virtual-recurring ${item.priority}`} style={{ top, height }} onClick={() => onSelect(item.sourceTaskId)} title="Projected recurring occurrence — not stored until it becomes active"><strong>↻ {item.title}</strong><span>{formatTime(item.startTime)} · projected</span></button>; })}
          {timed.map(task => (
            <CalendarTaskBlock
              key={task.id}
              task={task}
              selectedDate={selectedDate}
              onSelect={onSelect}
              isOverDayTasks={overDayTasks}
              onDayDropHover={setDayDropActive}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function CalendarTaskBlock({ task, selectedDate, onSelect, isOverDayTasks, onDayDropHover }: {
  task: Task;
  selectedDate: string;
  onSelect: (id: string) => void;
  isOverDayTasks: (x: number, y: number) => boolean;
  onDayDropHover: (active: boolean) => void;
}) {
  const startMinutes = timeToMinutes(task.startTime!);
  const baseTop = (startMinutes - startHour * 60) * pxPerMinute;
  const baseHeight = Math.max(minDuration * pxPerMinute, (task.estimatedMinutes ?? 30) * pxPerMinute);
  const [preview, setPreview] = useState({ top: baseTop, height: baseHeight });
  const previewRef = useRef(preview);
  const movedRef = useRef(false);

  useEffect(() => {
    const next = { top: baseTop, height: baseHeight };
    previewRef.current = next;
    setPreview(next);
  }, [baseTop, baseHeight]);

  function startInteraction(mode: "move" | "resize-top" | "resize-bottom", event: ReactPointerEvent<HTMLDivElement | HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    movedRef.current = false;
    const startY = event.clientY;
    const initial = { ...preview };
    const timelineHeight = (endHour - startHour) * 60 * pxPerMinute;
    let droppingIntoDayTasks = false;

    const onMove = (pointer: PointerEvent) => {
      droppingIntoDayTasks = mode === "move" && isOverDayTasks(pointer.clientX, pointer.clientY);
      onDayDropHover(droppingIntoDayTasks);
      if (droppingIntoDayTasks) {
        movedRef.current = true;
        return;
      }

      const rawDeltaMinutes = (pointer.clientY - startY) / pxPerMinute;
      const deltaMinutes = snap(rawDeltaMinutes);
      if (Math.abs(deltaMinutes) >= snapMinutes) movedRef.current = true;
      const deltaPx = deltaMinutes * pxPerMinute;

      if (mode === "move") {
        const top = Math.max(0, Math.min(timelineHeight - initial.height, initial.top + deltaPx));
        const next = { top, height: initial.height };
        previewRef.current = next;
        setPreview(next);
      } else if (mode === "resize-bottom") {
        const height = Math.max(minDuration * pxPerMinute, Math.min(timelineHeight - initial.top, initial.height + deltaPx));
        const next = { top: initial.top, height };
        previewRef.current = next;
        setPreview(next);
      } else {
        const maxTop = initial.top + initial.height - minDuration * pxPerMinute;
        const top = Math.max(0, Math.min(maxTop, initial.top + deltaPx));
        const next = { top, height: initial.height + (initial.top - top) };
        previewRef.current = next;
        setPreview(next);
      }
    };

    const onUp = async (pointer: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const dropInDayTasks = mode === "move" && (droppingIntoDayTasks || isOverDayTasks(pointer.clientX, pointer.clientY));
      onDayDropHover(false);
      if (dropInDayTasks) {
        await updateTask(task.id, { startDate: selectedDate, startTime: null }, "CALENDAR_TASK_UNSCHEDULED_BY_DROP");
        return;
      }

      const current = previewRef.current;
      const nextStartMinutes = startHour * 60 + snap(current.top / pxPerMinute);
      const nextDuration = Math.max(minDuration, snap(current.height / pxPerMinute));
      if (mode === "move") {
        await updateTask(task.id, { startTime: minutesToTime(nextStartMinutes) }, "CALENDAR_TASK_MOVED");
      } else if (mode === "resize-bottom") {
        await updateTask(task.id, { estimatedMinutes: nextDuration }, "CALENDAR_TASK_RESIZED");
      } else {
        await updateTask(task.id, { startTime: minutesToTime(nextStartMinutes), estimatedMinutes: nextDuration }, "CALENDAR_TASK_RESIZED");
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  previewRef.current = preview;
  const previewStart = startHour * 60 + snap(preview.top / pxPerMinute);
  const previewDuration = Math.max(minDuration, snap(preview.height / pxPerMinute));
  const previewEnd = previewStart + previewDuration;

  return (
    <div
      className={`calendar-block ${task.priority} ${task.status === "done" ? "completed-calendar-block" : ""}`}
      style={{ top: preview.top, height: preview.height }}
      onPointerDown={event => startInteraction("move", event)}
      onClick={() => { if (!movedRef.current) onSelect(task.id); }}
      title="Drag vertically to reschedule, or drag into Day Tasks to unschedule"
    >
      <button className="calendar-resize-handle top" aria-label={`Adjust start time for ${task.title}`} onPointerDown={event => startInteraction("resize-top", event)} />
      <strong>{task.status === "done" ? "✓ " : ""}{task.title}</strong>
      <span>{formatTime(minutesToTime(previewStart))} – {formatTime(minutesToTime(previewEnd))} · {formatDuration(previewDuration)}</span>
      <button className="calendar-resize-handle bottom" aria-label={`Adjust end time for ${task.title}`} onPointerDown={event => startInteraction("resize-bottom", event)} />
    </div>
  );
}
