import type { Project, Task } from "./types";

const FIELD_ALIASES: Record<string, keyof Task | "projectName" | "completed"> = {
  title: "title",
  project: "projectName",
  projectid: "projectId",
  status: "status",
  priority: "priority",
  startdate: "startDate",
  starttime: "startTime",
  duedate: "dueDate",
  duetime: "dueTime",
  duration: "estimatedMinutes",
  estimatedduration: "estimatedMinutes",
  estimatedminutes: "estimatedMinutes",
  createddate: "createdAt",
  createdat: "createdAt",
  completed: "completed",
};

function normalizeField(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeDate(value: string) {
  const trimmed = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (iso.test(trimmed)) return trimmed;
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return trimmed;
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function splitAnd(rule: string) {
  const pieces: string[] = [];
  let buffer = "";
  let quote: string | null = null;
  for (let i = 0; i < rule.length; i += 1) {
    const char = rule[i];
    if ((char === '"' || char === "'") && rule[i - 1] !== "\\") quote = quote === char ? null : quote ?? char;
    const rest = rule.slice(i);
    if (!quote && /^\s+AND\s+/i.test(rest)) {
      const match = rest.match(/^\s+AND\s+/i)!;
      pieces.push(buffer.trim());
      buffer = "";
      i += match[0].length - 1;
      continue;
    }
    buffer += char;
  }
  if (buffer.trim()) pieces.push(buffer.trim());
  return pieces;
}

function compare(left: unknown, operator: string, rightRaw: string) {
  const rightUnquoted = rightRaw.trim().replace(/^("|')|("|')$/g, "");
  const leftString = left == null ? "" : String(left);

  const leftNumber = typeof left === "number" ? left : Number.NaN;
  const rightNumber = Number(rightUnquoted);
  const numeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);

  const leftDateLike = /^\d{4}-\d{2}-\d{2}/.test(leftString);
  const rightDateLike = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})$/.test(rightUnquoted);
  const normalizedLeft = leftDateLike ? leftString.slice(0, 10) : leftString;
  const normalizedRight = rightDateLike ? normalizeDate(rightUnquoted) : rightUnquoted;

  const a: string | number = numeric ? leftNumber : normalizedLeft.toLowerCase();
  const b: string | number = numeric ? rightNumber : normalizedRight.toLowerCase();

  switch (operator) {
    case "=": return a === b;
    case "!=": return a !== b;
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
    default: return false;
  }
}

export function taskMatchesRule(task: Task, rule: string, projects: Project[]) {
  const clauses = splitAnd(rule);
  if (!clauses.length) return false;

  return clauses.every(clause => {
    const match = clause.match(/^(.+?)\s*(<=|>=|!=|=|<|>)\s*(.+)$/);
    if (!match) return false;
    const [, fieldRaw, operator, valueRaw] = match;
    const field = FIELD_ALIASES[normalizeField(fieldRaw)];
    if (!field) return false;

    let value: unknown;
    if (field === "projectName") value = projects.find(project => project.id === task.projectId)?.name ?? "";
    else if (field === "completed") value = task.status === "done";
    else value = task[field];

    return compare(value, operator, valueRaw);
  });
}

export function validateRule(rule: string) {
  const clauses = splitAnd(rule);
  if (!clauses.length) return "Enter at least one rule.";
  for (const clause of clauses) {
    const match = clause.match(/^(.+?)\s*(<=|>=|!=|=|<|>)\s*(.+)$/);
    if (!match) return `Could not parse: ${clause}`;
    const field = FIELD_ALIASES[normalizeField(match[1])];
    if (!field) return `Unknown field: ${match[1].trim()}`;
  }
  return null;
}
