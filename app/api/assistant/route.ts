import { NextResponse } from "next/server";

export const runtime = "nodejs";

const actionGuide = `
Return JSON only with this exact shape:
{"reply":"brief explanation of what you did or plan to do","actions":[...]}

Supported actions:
- {"type":"create_task","title":"...","notes":"...","priority":"urgent|high|normal|low","projectName":"...","parentTitle":"...","startDate":"YYYY-MM-DD|null","startTime":"HH:MM|null","estimatedMinutes":30,"dueDate":"YYYY-MM-DD|null","dueTime":"HH:MM|null","tags":["..."]}
- {"type":"update_task","taskTitle":"existing task","title":"new title","notes":"...","priority":"...","status":"not_started|in_progress|blocked|done","projectName":"name|null","parentTitle":"title|null","startDate":"YYYY-MM-DD|null","startTime":"HH:MM|null","estimatedMinutes":30,"dueDate":"YYYY-MM-DD|null","dueTime":"HH:MM|null","tags":["..."]}
- {"type":"complete_task","taskTitle":"..."}
- {"type":"reopen_task","taskTitle":"..."}
- {"type":"delete_task","taskTitle":"..."}
- {"type":"create_project","name":"..."}
- {"type":"create_category","name":"...","rule":"Project = \\"Name\\" AND Priority = \\"urgent\\""}
- {"type":"delete_category","name":"..."}
- {"type":"remember_backlog","title":"...","details":"...","kind":"bug|feature|improvement|idea"}
- {"type":"set_view","view":"today|inbox|map|calendar|tasks|completed|templates"}
- {"type":"filter_project","projectName":"name|null"}
- {"type":"focus_parent","taskTitle":"..."}
- {"type":"set_sort","sort":"manual|priority|due|start|created|alphabetical"}
- {"type":"set_show_completed","value":true}
- {"type":"open_task","taskTitle":"..."}
- {"type":"set_recurrence","taskTitle":"...","rule":{"enabled":true,"frequency":"minute|hour|day|week|month|year","interval":1,"weekdays":[1,3],"monthDays":[1,15,-1],"months":[1,4,7,10],"ordinal":1,"ordinalWeekday":2,"specialMonthly":"first_weekday|last_weekday|null","excludedDates":["YYYY-MM-DD"],"endMode":"forever|count|until","count":10,"untilDate":"YYYY-MM-DD|null"}}
- {"type":"save_task_as_template","taskTitle":"...","templateName":"..."}
- {"type":"use_template","templateName":"...","projectName":"...|null"}

Translate the user's real-world instruction into the smallest ordered set of supported actions. Use update_task with startTime:null to unschedule. Use parentTitle to establish or clear hierarchy. If the user says to remember/log/track a bug, feature, improvement, or idea for a future build, use remember_backlog rather than creating a normal task. Never invent an existing task/project name when the context does not support it. If clarification is essential, return an empty actions array and ask in reply.`;

function extractOutputText(data: any): string {
  if (typeof data?.output_text === "string") return data.output_text;
  const parts = Array.isArray(data?.output) ? data.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : []) : [];
  return parts.map((part: any) => part?.text ?? "").filter(Boolean).join("\n");
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured. Add it to .env.local (or your Vercel environment variables) and restart TaskMap." }, { status: 503 });
  }

  try {
    const body = await request.json();
    const message = String(body?.message ?? "").trim();
    if (!message) return NextResponse.json({ error: "Message is required." }, { status: 400 });

    const context = {
      today: new Date().toISOString().slice(0, 10),
      tasks: Array.isArray(body?.tasks) ? body.tasks.slice(0, 500) : [],
      projects: Array.isArray(body?.projects) ? body.projects.slice(0, 100) : [],
      backlog: Array.isArray(body?.backlog) ? body.backlog.slice(0, 200) : [],
      templates: Array.isArray(body?.templates) ? body.templates.slice(0, 100) : [],
    };

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.OPENAI_TASKMAP_MODEL || "gpt-5.6-luna",
        instructions: `You are Ask TaskMap, the natural-language control layer for a local-first task manager. ${actionGuide}`,
        input: `Current TaskMap context:\n${JSON.stringify(context)}\n\nUser instruction:\n${message}`,
      }),
    });

    const data = await response.json();
    if (!response.ok) return NextResponse.json({ error: data?.error?.message || "OpenAI request failed." }, { status: response.status });
    const text = extractOutputText(data).trim().replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(text);
    return NextResponse.json({ reply: String(parsed?.reply ?? "Done."), actions: Array.isArray(parsed?.actions) ? parsed.actions : [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Assistant request failed." }, { status: 500 });
  }
}
