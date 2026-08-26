const DEFAULT_SUPABASE_URL = "https://axlykicsvtpeulshzyol.supabase.co";

function upstreamUrl() {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? DEFAULT_SUPABASE_URL).replace(/\/$/, "");
  return `${base}/functions/v1/taskmap-api`;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-taskmap-api-key, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "no-store",
};

function publicEndpoint(request: Request) {
  return `${new URL(request.url).origin}/api/taskmap`;
}

async function proxy(request: Request) {
  const url = new URL(request.url);
  const upstream = new URL(upstreamUrl());
  for (const [key, value] of url.searchParams) upstream.searchParams.set(key, value);

  const headers = new Headers();
  const authorization = request.headers.get("authorization");
  const apiKey = request.headers.get("x-taskmap-api-key");
  if (authorization) headers.set("authorization", authorization);
  if (apiKey) headers.set("x-taskmap-api-key", apiKey);
  headers.set("content-type", request.headers.get("content-type") ?? "application/json");

  const response = await fetch(upstream, {
    method: request.method,
    headers,
    body: request.method === "POST" ? await request.text() : undefined,
    cache: "no-store",
  });
  let body = await response.text();
  const contentType = response.headers.get("content-type") ?? "application/json";

  // Keep OpenAPI/tool discovery pointed at the stable TaskMap domain instead of
  // leaking the implementation detail that Supabase hosts the broker function.
  if (request.method === "GET" && response.ok && contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(body);
      const endpoint = publicEndpoint(request);
      if (parsed?.openapi && Array.isArray(parsed.servers)) parsed.servers = [{ url: endpoint }];
      if (parsed?.name === "TaskMap External API") {
        parsed.endpoint = endpoint;
        parsed.openapi = `${endpoint}?openapi=1`;
      }
      body = JSON.stringify(parsed);
    } catch { /* preserve upstream response */ }
  }

  const outHeaders = new Headers(corsHeaders);
  outHeaders.set("content-type", contentType);
  return new Response(body, { status: response.status, headers: outHeaders });
}

export async function GET(request: Request) { return proxy(request); }
export async function POST(request: Request) { return proxy(request); }
export async function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders }); }
