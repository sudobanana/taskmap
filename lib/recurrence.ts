import type { RecurrenceRule, Task } from "./types";

export const defaultRecurrenceRule = (): RecurrenceRule => ({
  enabled: true,
  frequency: "week",
  interval: 1,
  weekdays: [],
  monthDays: [],
  months: [],
  ordinal: null,
  ordinalWeekday: null,
  specialMonthly: null,
  excludedDates: [],
  endMode: "forever",
  count: null,
  untilDate: null,
  anchorDate: null,
  anchorTime: null,
});

function parseDate(value: string) {
  const [y,m,d] = value.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}
function dateOnly(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}
function daysBetween(a: Date, b: Date) { return Math.floor((b.getTime()-a.getTime()) / 86400000); }
function monthsBetween(a: Date, b: Date) { return (b.getFullYear()-a.getFullYear())*12 + b.getMonth()-a.getMonth(); }
function yearsBetween(a: Date, b: Date) { return b.getFullYear()-a.getFullYear(); }
function nthWeekdayOfMonth(date: Date, weekday: number) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1, 12);
  return Math.floor((date.getDate() + ((first.getDay()-weekday+7)%7) - 1) / 7) + 1;
}
function isLastWeekdayOfMonth(date: Date, weekday: number) {
  if (date.getDay() !== weekday) return false;
  const next = new Date(date); next.setDate(next.getDate()+7);
  return next.getMonth() !== date.getMonth();
}
function isWeekday(date: Date) { return date.getDay() >= 1 && date.getDay() <= 5; }
function isFirstBusinessDay(date: Date) {
  if (!isWeekday(date)) return false;
  const cursor = new Date(date.getFullYear(), date.getMonth(), 1, 12);
  while (!isWeekday(cursor)) cursor.setDate(cursor.getDate()+1);
  return cursor.getDate() === date.getDate();
}
function isLastBusinessDay(date: Date) {
  if (!isWeekday(date)) return false;
  const cursor = new Date(date.getFullYear(), date.getMonth()+1, 0, 12);
  while (!isWeekday(cursor)) cursor.setDate(cursor.getDate()-1);
  return cursor.getDate() === date.getDate();
}
function patternMatches(rule: RecurrenceRule, start: Date, target: Date) {
  if (rule.specialMonthly === "first_weekday") return isFirstBusinessDay(target);
  if (rule.specialMonthly === "last_weekday") return isLastBusinessDay(target);
  if (rule.ordinal && rule.ordinalWeekday != null) {
    if (target.getDay() !== rule.ordinalWeekday) return false;
    return rule.ordinal === -1 ? isLastWeekdayOfMonth(target, rule.ordinalWeekday) : nthWeekdayOfMonth(target, rule.ordinalWeekday) === rule.ordinal;
  }
  if (rule.monthDays.length) {
    const last = new Date(target.getFullYear(), target.getMonth()+1, 0, 12).getDate();
    return rule.monthDays.some(day => day === -1 ? target.getDate() === last : target.getDate() === day);
  }
  return target.getDate() === start.getDate();
}

export function recurrenceLabel(rule: RecurrenceRule | null) {
  if (!rule?.enabled) return "";
  const every = rule.interval === 1 ? "Every" : `Every ${rule.interval}`;
  const unit = rule.interval === 1 ? rule.frequency : `${rule.frequency}s`;
  if (rule.frequency === "day" && rule.weekdays.length === 5 && [1,2,3,4,5].every(day => rule.weekdays.includes(day))) return `${every} ${unit} on weekdays`;
  if (rule.frequency === "day" && rule.weekdays.length === 2 && [0,6].every(day => rule.weekdays.includes(day))) return `${every} ${unit} on weekends`;
  if ((rule.frequency === "month" || rule.frequency === "year") && rule.specialMonthly === "first_weekday") return `First weekday of ${rule.months.length ? "selected months" : "each month"}`;
  if ((rule.frequency === "month" || rule.frequency === "year") && rule.specialMonthly === "last_weekday") return `Last weekday of ${rule.months.length ? "selected months" : "each month"}`;
  if ((rule.frequency === "month" || rule.frequency === "year") && rule.ordinal && rule.ordinalWeekday != null) {
    const ord = rule.ordinal === -1 ? "Last" : ["","First","Second","Third","Fourth","Fifth"][rule.ordinal];
    const day = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][rule.ordinalWeekday];
    return `${ord} ${day} of ${rule.months.length ? "selected months" : "every month"}`;
  }
  if ((rule.frequency === "month" || rule.frequency === "year") && rule.monthDays.includes(-1)) return `Last day of ${rule.months.length ? "selected months" : "every month"}`;
  if ((rule.frequency === "month" || rule.frequency === "year") && rule.monthDays.length) return `${every} ${unit} on day ${rule.monthDays.join(", ")}`;
  if ((rule.frequency === "week" || rule.frequency === "day") && rule.weekdays.length) return `${every} ${unit} on ${rule.weekdays.map(d => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d]).join(", ")}`;
  return `${every} ${unit}`;
}

export function occursOnDate(task: Task, targetDate: string, occurrenceHint = 1) {
  const rule = task.recurrence;
  if (!rule?.enabled || !task.startDate) return false;
  if ((rule.excludedDates ?? []).includes(targetDate)) return false;
  if (rule.untilDate && targetDate > rule.untilDate) return false;
  if (rule.endMode === "count" && rule.count != null && occurrenceHint > rule.count) return false;
  const start = parseDate(rule.anchorDate ?? task.startDate);
  const target = parseDate(targetDate);
  if (target < start) return false;
  if (rule.months.length && !rule.months.includes(target.getMonth()+1)) return false;

  if (rule.frequency === "minute" || rule.frequency === "hour") return targetDate === task.startDate;
  if (rule.frequency === "day") {
    const cadence = daysBetween(start,target) % Math.max(1,rule.interval) === 0;
    const allowedDay = !rule.weekdays.length || rule.weekdays.includes(target.getDay());
    return cadence && allowedDay;
  }
  if (rule.frequency === "week") {
    const weeks = Math.floor(daysBetween(start,target)/7);
    const validDay = rule.weekdays.length ? rule.weekdays.includes(target.getDay()) : target.getDay() === start.getDay();
    return weeks % Math.max(1,rule.interval) === 0 && validDay;
  }
  if (rule.frequency === "month") {
    if (monthsBetween(start,target) % Math.max(1,rule.interval) !== 0) return false;
    return patternMatches(rule,start,target);
  }
  if (rule.frequency === "year") {
    if (yearsBetween(start,target) % Math.max(1,rule.interval) !== 0) return false;
    const allowedMonth = rule.months.length ? rule.months.includes(target.getMonth()+1) : target.getMonth() === start.getMonth();
    if (!allowedMonth) return false;
    return patternMatches(rule,start,target);
  }
  return false;
}

export function nextOccurrence(task: Task): { date: string; time: string | null } | null {
  const rule = task.recurrence;
  if (!rule?.enabled || !task.startDate) return null;
  const currentOccurrence = task.recurrenceOccurrence ?? 1;
  if (rule.endMode === "count" && rule.count != null && currentOccurrence >= rule.count) return null;

  if (rule.frequency === "minute" || rule.frequency === "hour") {
    const current = parseDate(task.startDate);
    const currentMinutes = timeMinutes(task.startTime);
    current.setHours(Math.floor(currentMinutes / 60), currentMinutes % 60, 0, 0);
    const step = Math.max(1, rule.interval) * (rule.frequency === "hour" ? 60 : 1);
    for (let tries=0; tries<100000; tries++) {
      current.setMinutes(current.getMinutes() + step);
      const candidateDate = dateOnly(current);
      if (rule.endMode === "until" && rule.untilDate && candidateDate > rule.untilDate) return null;
      if (!(rule.excludedDates ?? []).includes(candidateDate)) return { date: candidateDate, time: minutesTime(current.getHours() * 60 + current.getMinutes()) };
    }
    return null;
  }

  let cursor = parseDate(task.startDate);
  const maxDays = 366 * 100;
  for (let i = 0; i < maxDays; i++) {
    cursor.setDate(cursor.getDate() + 1);
    const candidate = dateOnly(cursor);
    if (rule.endMode === "until" && rule.untilDate && candidate > rule.untilDate) return null;
    if (occursOnDate(task, candidate, currentOccurrence + 1)) return { date: candidate, time: task.startTime };
  }
  return null;
}

export function nextOccurrenceDate(task: Task) {
  return nextOccurrence(task)?.date ?? null;
}

export function projectedOccurrencesForDate(tasks: Task[], date: string) {
  return tasks.filter(task => task.recurrence?.enabled && task.startDate && date > task.startDate && occursOnDate(task,date,(task.recurrenceOccurrence ?? 1)+1));
}

export interface VirtualRecurrenceOccurrence {
  key: string;
  sourceTaskId: string;
  title: string;
  startTime: string | null;
  estimatedMinutes: number | null;
  priority: Task["priority"];
}

function timeMinutes(value: string | null) {
  if (!value) return 9 * 60;
  const [h,m] = value.split(":").map(Number);
  return h*60+m;
}
function minutesTime(value: number) {
  const normalized = ((value % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized/60)).padStart(2,"0")}:${String(normalized%60).padStart(2,"0")}`;
}

/** Calendar-only recurrence expansion. These rows are never persisted. */
export function virtualOccurrencesForDate(tasks: Task[], targetDate: string): VirtualRecurrenceOccurrence[] {
  const output: VirtualRecurrenceOccurrence[] = [];
  for (const task of tasks) {
    const rule = task.recurrence;
    if (!rule?.enabled || task.status === "done" || !task.startDate) continue;
    if ((rule.excludedDates ?? []).includes(targetDate)) continue;
    const seriesKey = task.recurrenceSeriesId ?? task.id;
    const startDay = parseDate(task.startDate);
    const targetDay = parseDate(targetDate);
    if (targetDay < startDay) continue;
    if (rule.endMode === "until" && rule.untilDate && targetDate > rule.untilDate) continue;

    if (rule.frequency === "minute" || rule.frequency === "hour") {
      const intervalMinutes = Math.max(1,rule.interval) * (rule.frequency === "hour" ? 60 : 1);
      const startAt = timeMinutes(task.startTime);
      const dayOffset = daysBetween(startDay,targetDay) * 1440;
      let firstIndex = Math.ceil((dayOffset - startAt) / intervalMinutes);
      firstIndex = Math.max(0, firstIndex);
      for (let index=firstIndex; index<firstIndex+2000; index++) {
        const total = startAt + index*intervalMinutes;
        const occurrenceDay = Math.floor(total/1440);
        if (occurrenceDay > daysBetween(startDay,targetDay)) break;
        if (occurrenceDay < daysBetween(startDay,targetDay)) continue;
        const minuteOfDay = ((total%1440)+1440)%1440;
        const occurrenceNumber = (task.recurrenceOccurrence ?? 1) + index;
        if (rule.endMode === "count" && rule.count != null && occurrenceNumber > rule.count) break;
        if (targetDate === task.startDate && minuteOfDay === startAt) continue;
        output.push({ key:`virtual:${seriesKey}:${targetDate}:${minuteOfDay}`, sourceTaskId:task.id, title:task.title, startTime:minutesTime(minuteOfDay), estimatedMinutes:task.estimatedMinutes, priority:task.priority });
      }
      continue;
    }

    if (targetDate === task.startDate || !occursOnDate(task,targetDate)) continue;
    if (rule.endMode === "count" && rule.count != null) {
      let count = task.recurrenceOccurrence ?? 1;
      const cursor = parseDate(task.startDate);
      while (dateOnly(cursor) < targetDate && count <= rule.count) {
        cursor.setDate(cursor.getDate()+1);
        if (occursOnDate(task,dateOnly(cursor),count+1)) count++;
      }
      if (count > rule.count) continue;
    }
    output.push({ key:`virtual:${seriesKey}:${targetDate}`, sourceTaskId:task.id, title:task.title, startTime:task.startTime, estimatedMinutes:task.estimatedMinutes, priority:task.priority });
  }
  return output.slice(0,1500);
}
