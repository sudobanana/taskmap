"use client";

import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, GripVertical } from "lucide-react";
import type { Task } from "@/lib/types";
import { formatDuration, formatTime, localDateOnly } from "@/lib/format";
import { updateTask } from "@/lib/task-service";
import { virtualOccurrencesForDate } from "@/lib/recurrence";

const startHour = 6;
const endHour = 23;
const pxPerMinute = 1.05;
const snapMinutes = 15;
const minDuration = 15;

type CalendarMode = "day" | "week";
type WeekLength = 5 | 7;

type ColumnTarget = { date: string; index: number };

function parseDateOnly(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function formatDateOnly(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateHeading(value: string) {
  return parseDateOnly(value).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function shiftDate(value: string, amount: number) {
  const date = parseDateOnly(value);
  date.setDate(date.getDate() + amount);
  return formatDateOnly(date);
}

function startOfWeek(value: string) {
  const date = parseDateOnly(value);
  const weekday = date.getDay();
  date.setDate(date.getDate() + (weekday === 0 ? -6 : 1 - weekday));
  return formatDateOnly(date);
}

function weekDates(anchor: string, length: WeekLength) {
  const first = startOfWeek(anchor);
  return Array.from({ length }, (_, index) => shiftDate(first, index));
}

function formatWeekHeading(dates: string[]) {
  if (!dates.length) return "";
  const first = parseDateOnly(dates[0]);
  const last = parseDateOnly(dates[dates.length - 1]);
  const sameYear = first.getFullYear() === last.getFullYear();
  const sameMonth = sameYear && first.getMonth() === last.getMonth();
  if (sameMonth) {
    return `${first.toLocaleDateString([], { month: "long" })} ${first.getDate()}–${last.getDate()}, ${last.getFullYear()}`;
  }
  if (sameYear) {
    return `${first.toLocaleDateString([], { month: "short", day: "numeric" })} – ${last.toLocaleDateString([], { month: "short", day: "numeric" })}, ${last.getFullYear()}`;
  }
  return `${first.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })} – ${last.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
}

function formatWeekDay(value: string) {
  const date = parseDateOnly(value);
  return {
    weekday: date.toLocaleDateString([], { weekday: "short" }),
    day: date.toLocaleDateString([], { month: "short", day: "numeric" }),
  };
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

function horizontalBlockStyle(index: number, count: number) {
  if (count <= 1) return { left: "18px", width: "calc(100% - 38px)" };
  const widthPercent = 100 / count;
  return {
    left: `calc(${index * widthPercent}% + 5px)`,
    width: `calc(${widthPercent}% - 10px)`,
  };
}

export default function CalendarView({ tasks, onSelect }: { tasks: Task[]; onSelect: (id: string) => void }) {
  const today = localDateOnly();
  const [selectedDate, setSelectedDate] = useState(today);
  const [calendarMode, setCalendarMode] = useState<CalendarMode>("day");
  const [weekLength, setWeekLength] = useState<WeekLength>(7);
  const [now, setNow] = useState(() => new Date());
  const [timelineDropActive, setTimelineDropActive] = useState(false);
  const [timelineDropDate, setTimelineDropDate] = useState<string | null>(null);
  const [dayDropActive, setDayDropActive] = useState(false);
  const dayZoneRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const savedMode = window.localStorage.getItem("taskmap-calendar-mode");
    const savedWeekLength = Number(window.localStorage.getItem("taskmap-calendar-week-length"));
    if (savedMode === "day" || savedMode === "week") setCalendarMode(savedMode);
    if (savedWeekLength === 5 || savedWeekLength === 7) setWeekLength(savedWeekLength);
  }, []);

  useEffect(() => { window.localStorage.setItem("taskmap-calendar-mode", calendarMode); }, [calendarMode]);
  useEffect(() => { window.localStorage.setItem("taskmap-calendar-week-length", String(weekLength)); }, [weekLength]);

  const visibleDates = calendarMode === "day" ? [selectedDate] : weekDates(selectedDate, weekLength);
  const columnCount = visibleDates.length;
  const visibleSet = new Set(visibleDates);

  const dayTaskEntries: Array<{ task: Task; date: string }> = [];
  for (const task of tasks) {
    if (task.startTime) continue;
    const date = task.startDate && visibleSet.has(task.startDate)
      ? task.startDate
      : task.dueDate && visibleSet.has(task.dueDate)
        ? task.dueDate
        : task.priority === "urgent" && visibleSet.has(today)
          ? today
          : null;
    if (date) dayTaskEntries.push({ task, date });
  }

  const virtualByDate = visibleDates.flatMap(date => virtualOccurrencesForDate(tasks, date).map(item => ({ ...item, date })));
  const virtualDayTasks = virtualByDate.filter(item => !item.startTime);
  const virtualTimed = virtualByDate.filter((item): item is typeof item & { startTime: string } => Boolean(item.startTime));
  const timed = tasks.filter(task => Boolean(task.startTime && task.startDate && visibleSet.has(task.startDate)));

  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const currentLineTop = (currentMinute - startHour * 60) * pxPerMinute;
  const todayColumnIndex = visibleDates.indexOf(today);
  const showCurrentLine = todayColumnIndex >= 0 && currentMinute >= startHour * 60 && currentMinute <= endHour * 60;
  const dateTitle = calendarMode === "day" ? formatDateHeading(selectedDate) : formatWeekHeading(visibleDates);

  function resolveDateAtPoint(clientX: number): ColumnTarget {
    if (calendarMode === "day") return { date: selectedDate, index: 0 };
    const timeline = timelineRef.current;
    if (!timeline) return { date: visibleDates[0], index: 0 };
    const box = timeline.getBoundingClientRect();
    const ratio = box.width > 0 ? (clientX - box.left) / box.width : 0;
    const index = Math.max(0, Math.min(columnCount - 1, Math.floor(ratio * columnCount)));
    return { date: visibleDates[index], index };
  }

  async function scheduleTaskAtPoint(taskId: string, clientX: number, clientY: number) {
    const task = tasks.find(candidate => candidate.id === taskId);
    const timeline = timelineRef.current;
    if (!task || !timeline) return;
    const box = timeline.getBoundingClientRect();
    if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) return;
    const offsetMinutes = snap((clientY - box.top) / pxPerMinute);
    const startMinutes = Math.max(startHour * 60, Math.min(endHour * 60 - minDuration, startHour * 60 + offsetMinutes));
    const target = resolveDateAtPoint(clientX);
    await updateTask(task.id, { startDate: target.date, startTime: minutesToTime(startMinutes) }, "CALENDAR_TASK_SCHEDULED_BY_DROP");
  }

  async function scheduleDroppedTask(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setTimelineDropActive(false);
    setTimelineDropDate(null);
    const taskId = event.dataTransfer.getData("application/taskmap-calendar-task") || event.dataTransfer.getData("application/taskmap-task") || event.dataTransfer.getData("text/plain");
    await scheduleTaskAtPoint(taskId, event.clientX, event.clientY);
  }

  function startUnscheduledPointerDrag(taskId: string, event: ReactPointerEvent<HTMLSpanElement>) {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    let overTimeline = false;
    const onMove = (pointer: PointerEvent) => {
      const timeline = timelineRef.current;
      if (!timeline) return;
      const box = timeline.getBoundingClientRect();
      overTimeline = pointer.clientX >= box.left && pointer.clientX <= box.right && pointer.clientY >= box.top && pointer.clientY <= box.bottom;
      setTimelineDropActive(overTimeline);
      setTimelineDropDate(overTimeline && calendarMode === "week" ? resolveDateAtPoint(pointer.clientX).date : null);
    };
    const onUp = async (pointer: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setTimelineDropActive(false);
      setTimelineDropDate(null);
      if (overTimeline) await scheduleTaskAtPoint(taskId, pointer.clientX, pointer.clientY);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function overDayTasks(clientX: number, clientY: number) {
    const zone = dayZoneRef.current;
    if (!zone) return false;
    const box = zone.getBoundingClientRect();
    return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
  }

  const navigationStep = calendarMode === "day" ? 1 : 7;

  return (
    <section className="calendar-page">
      <div className="page-heading calendar-heading">
        <div>
          <p className="eyebrow">{calendarMode === "day" ? (selectedDate === today ? "Today" : "Daily schedule") : `${weekLength}-day week`}</p>
          <h1>Calendar</h1>
          <p className="subtitle">Drag unscheduled tasks onto a time to schedule them. Drag scheduled blocks back into the task strip to unschedule.</p>
        </div>
        <div className="calendar-heading-controls">
          <div className="calendar-view-toggle" aria-label="Calendar view">
            <button className={calendarMode === "day" ? "active" : ""} onClick={() => setCalendarMode("day")}>Day</button>
            <button className={calendarMode === "week" ? "active" : ""} onClick={() => setCalendarMode("week")}>Week</button>
          </div>
          {calendarMode === "week" && (
            <div className="calendar-view-toggle compact" aria-label="Week length">
              <button className={weekLength === 5 ? "active" : ""} onClick={() => setWeekLength(5)}>5 days</button>
              <button className={weekLength === 7 ? "active" : ""} onClick={() => setWeekLength(7)}>7 days</button>
            </div>
          )}
          <div className="calendar-nav">
            <button onClick={() => setSelectedDate(date => shiftDate(date, -navigationStep))} aria-label={calendarMode === "day" ? "Previous day" : "Previous week"}><ChevronLeft size={17} /></button>
            <button className="calendar-today-button" onClick={() => setSelectedDate(today)}>Today</button>
            <button onClick={() => setSelectedDate(date => shiftDate(date, navigationStep))} aria-label={calendarMode === "day" ? "Next day" : "Next week"}><ChevronRight size={17} /></button>
          </div>
        </div>
      </div>

      <div className="calendar-date-title">{dateTitle}</div>
      <div className={`calendar-card ${calendarMode === "week" ? "week-calendar-card" : ""}`}>
        <div className={calendarMode === "week" ? "week-calendar-inner" : undefined}>
          <div ref={dayZoneRef} className={`all-day-zone ${calendarMode === "week" ? "week-all-day-zone" : ""} ${dayDropActive ? "calendar-drop-active" : ""}`}>
            <div className="all-day-label">{calendarMode === "week" ? "Week tasks" : "Day tasks"}</div>
            <div className="all-day-tasks">
              {dayTaskEntries.map(({ task, date }) => (
                <button
                  key={task.id}
                  draggable
                  onDragStart={event => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("application/taskmap-calendar-task", task.id);
                    event.dataTransfer.setData("text/plain", task.id);
                  }}
                  onDragEnd={() => { setTimelineDropActive(false); setTimelineDropDate(null); }}
                  onClick={() => onSelect(task.id)}
                  className={`all-day-chip ${task.priority} ${task.status === "done" ? "completed-calendar-item" : ""}`}
                  title="Drag onto the timeline to schedule"
                >
                  <span className="calendar-chip-grip" onClick={event => event.stopPropagation()} onPointerDown={event => startUnscheduledPointerDrag(task.id, event)}><GripVertical size={13} /></span>
                  <span>{task.status === "done" ? "✓ " : task.priority === "urgent" ? "!!! " : ""}{task.title}{task.estimatedMinutes ? ` · ${formatDuration(task.estimatedMinutes)}` : ""}</span>
                  {calendarMode === "week" && <small className="week-task-date">{formatWeekDay(date).weekday} {formatWeekDay(date).day}</small>}
                </button>
              ))}
              {virtualDayTasks.map(item => (
                <button key={item.key} className={`all-day-chip virtual-recurring ${item.priority}`} onClick={() => onSelect(item.sourceTaskId)} title="Projected recurring occurrence — not stored yet">
                  <span>↻ {item.title} · projected</span>
                  {calendarMode === "week" && <small className="week-task-date">{formatWeekDay(item.date).weekday} {formatWeekDay(item.date).day}</small>}
                </button>
              ))}
              {dayTaskEntries.length === 0 && virtualDayTasks.length === 0 && <span className="calendar-empty-note">No unscheduled tasks for {calendarMode === "week" ? "this week" : "this day"}.</span>}
            </div>
          </div>

          {calendarMode === "week" && (
            <div className="week-day-headers" style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}>
              {visibleDates.map(date => {
                const label = formatWeekDay(date);
                return (
                  <button key={date} className={date === today ? "today" : ""} onClick={() => { setSelectedDate(date); setCalendarMode("day"); }} title={`Open ${formatDateHeading(date)} in Day view`}>
                    <span>{label.weekday}</span><strong>{label.day}</strong>
                  </button>
                );
              })}
            </div>
          )}

          <div
            ref={timelineRef}
            className={`timeline ${calendarMode === "week" ? "week-timeline" : ""} ${timelineDropActive ? "calendar-timeline-drop-active" : ""}`}
            style={{ height: (endHour - startHour) * 60 * pxPerMinute }}
            onDragOver={event => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setTimelineDropActive(true);
              if (calendarMode === "week") setTimelineDropDate(resolveDateAtPoint(event.clientX).date);
            }}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setTimelineDropActive(false);
                setTimelineDropDate(null);
              }
            }}
            onDrop={event => void scheduleDroppedTask(event)}
          >
            {calendarMode === "week" && visibleDates.map((date, index) => (
              <div key={`column-${date}`} className={`week-day-column ${date === today ? "today" : ""} ${timelineDropDate === date ? "drop-target" : ""}`} style={{ left: `${(index / columnCount) * 100}%`, width: `${100 / columnCount}%` }} />
            ))}
            {Array.from({ length: endHour - startHour + 1 }, (_, index) => startHour + index).map(hour => (
              <div key={hour} className="hour-line" style={{ top: (hour - startHour) * 60 * pxPerMinute }}><span>{new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" })}</span></div>
            ))}
            {calendarMode === "week" && visibleDates.slice(1).map((date, index) => (
              <div key={`divider-${date}`} className="week-day-divider" style={{ left: `${((index + 1) / columnCount) * 100}%` }} />
            ))}
            {showCurrentLine && (
              <div
                className={`current-time-line ${calendarMode === "week" ? "week-current-line" : ""}`}
                style={calendarMode === "week" ? { top: currentLineTop, left: `${(todayColumnIndex / columnCount) * 100}%`, width: `${100 / columnCount}%`, right: "auto" } : { top: currentLineTop }}
              >
                <span>{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              </div>
            )}
            {virtualTimed.map(item => {
              const start = timeToMinutes(item.startTime);
              const top = (start - startHour * 60) * pxPerMinute;
              const height = Math.max(minDuration * pxPerMinute, (item.estimatedMinutes ?? 30) * pxPerMinute);
              const columnIndex = Math.max(0, visibleDates.indexOf(item.date));
              return (
                <button key={item.key} className={`calendar-block virtual-recurring ${item.priority}`} style={{ top, height, ...horizontalBlockStyle(columnIndex, columnCount) }} onClick={() => onSelect(item.sourceTaskId)} title="Projected recurring occurrence — not stored until it becomes active">
                  <strong>↻ {item.title}</strong><span>{formatTime(item.startTime)} · projected</span>
                </button>
              );
            })}
            {timed.map(task => {
              const taskDate = task.startDate!;
              const columnIndex = Math.max(0, visibleDates.indexOf(taskDate));
              return (
                <CalendarTaskBlock
                  key={task.id}
                  task={task}
                  selectedDate={taskDate}
                  columnIndex={columnIndex}
                  columnCount={columnCount}
                  onSelect={onSelect}
                  isOverDayTasks={overDayTasks}
                  onDayDropHover={setDayDropActive}
                  resolveDateAtPoint={resolveDateAtPoint}
                />
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function CalendarTaskBlock({ task, selectedDate, columnIndex, columnCount, onSelect, isOverDayTasks, onDayDropHover, resolveDateAtPoint }: {
  task: Task;
  selectedDate: string;
  columnIndex: number;
  columnCount: number;
  onSelect: (id: string) => void;
  isOverDayTasks: (x: number, y: number) => boolean;
  onDayDropHover: (active: boolean) => void;
  resolveDateAtPoint: (x: number) => ColumnTarget;
}) {
  const startMinutes = timeToMinutes(task.startTime!);
  const baseTop = (startMinutes - startHour * 60) * pxPerMinute;
  const baseHeight = Math.max(minDuration * pxPerMinute, (task.estimatedMinutes ?? 30) * pxPerMinute);
  const [preview, setPreview] = useState({ top: baseTop, height: baseHeight, columnIndex, date: selectedDate });
  const previewRef = useRef(preview);
  const movedRef = useRef(false);

  useEffect(() => {
    const next = { top: baseTop, height: baseHeight, columnIndex, date: selectedDate };
    previewRef.current = next;
    setPreview(next);
  }, [baseTop, baseHeight, columnIndex, selectedDate]);

  function startInteraction(mode: "move" | "resize-top" | "resize-bottom", event: ReactPointerEvent<HTMLDivElement | HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    movedRef.current = false;
    const startY = event.clientY;
    const initial = { ...previewRef.current };
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
      const target = mode === "move" ? resolveDateAtPoint(pointer.clientX) : { date: initial.date, index: initial.columnIndex };
      if (mode === "move" && (target.index !== initial.columnIndex || target.date !== initial.date)) movedRef.current = true;

      if (mode === "move") {
        const top = Math.max(0, Math.min(timelineHeight - initial.height, initial.top + deltaPx));
        const next = { top, height: initial.height, columnIndex: target.index, date: target.date };
        previewRef.current = next;
        setPreview(next);
      } else if (mode === "resize-bottom") {
        const height = Math.max(minDuration * pxPerMinute, Math.min(timelineHeight - initial.top, initial.height + deltaPx));
        const next = { top: initial.top, height, columnIndex: initial.columnIndex, date: initial.date };
        previewRef.current = next;
        setPreview(next);
      } else {
        const maxTop = initial.top + initial.height - minDuration * pxPerMinute;
        const top = Math.max(0, Math.min(maxTop, initial.top + deltaPx));
        const next = { top, height: initial.height + (initial.top - top), columnIndex: initial.columnIndex, date: initial.date };
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
        await updateTask(task.id, { startDate: task.startDate ?? selectedDate, startTime: null }, "CALENDAR_TASK_UNSCHEDULED_BY_DROP");
        return;
      }
      if (!movedRef.current) return;

      const current = previewRef.current;
      const nextStartMinutes = startHour * 60 + snap(current.top / pxPerMinute);
      const nextDuration = Math.max(minDuration, snap(current.height / pxPerMinute));
      if (mode === "move") {
        await updateTask(task.id, { startDate: current.date, startTime: minutesToTime(nextStartMinutes) }, "CALENDAR_TASK_MOVED");
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
      style={{ top: preview.top, height: preview.height, ...horizontalBlockStyle(preview.columnIndex, columnCount) }}
      onPointerDown={event => startInteraction("move", event)}
      onClick={() => { if (!movedRef.current) onSelect(task.id); }}
      title={columnCount > 1 ? "Drag vertically or across days to reschedule, or drag into Week Tasks to unschedule" : "Drag vertically to reschedule, or drag into Day Tasks to unschedule"}
    >
      <button className="calendar-resize-handle top" aria-label={`Adjust start time for ${task.title}`} onPointerDown={event => startInteraction("resize-top", event)} />
      <strong>{task.status === "done" ? "✓ " : ""}{task.title}{task.estimatedMinutes == null && <span className="calendar-duration-warning" title="No duration set — calendar is using the default display length."><AlertTriangle size={13}/><span className="sr-only">No duration set — calendar is using the default display length.</span></span>}</strong>
      <span>{formatTime(minutesToTime(previewStart))} – {formatTime(minutesToTime(previewEnd))} · {formatDuration(previewDuration)}{task.estimatedMinutes == null ? " · default display length" : ""}</span>
      <button className="calendar-resize-handle bottom" aria-label={`Adjust end time for ${task.title}`} onPointerDown={event => startInteraction("resize-bottom", event)} />
    </div>
  );
}
