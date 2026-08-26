import { taskMapRestOpenApi } from "../rest-openapi";

const DEFAULT_SUPABASE_URL = "https://axlykicsvtpeulshzyol.supabase.co";
const corsHeaders = {
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, x-taskmap-api-key, content-type",
  "Access-Control-Allow-Methods":"GET, POST, PATCH, DELETE, OPTIONS",
  "Cache-Control":"no-store",
};
function supabaseBase(){return (process.env.NEXT_PUBLIC_SUPABASE_URL??DEFAULT_SUPABASE_URL).replace(/\/$/,"");}
function upstreamUrl(){return `${supabaseBase()}/functions/v1/taskmap-api`;}
function projectDeleteUrl(){return `${supabaseBase()}/functions/v1/taskmap-project-delete`;}
function authHeaders(request:Request){const headers=new Headers({"content-type":"application/json"});const a=request.headers.get("authorization"),k=request.headers.get("x-taskmap-api-key");if(a)headers.set("authorization",a);if(k)headers.set("x-taskmap-api-key",k);return headers;}

async function callProjectDelete(request:Request, projectId:string, taskMode:unknown){
  const response=await fetch(projectDeleteUrl(),{method:"POST",headers:authHeaders(request),body:JSON.stringify({projectId,taskMode:taskMode??"detach"}),cache:"no-store"});
  const text=await response.text();const headers=new Headers(corsHeaders);headers.set("content-type",response.headers.get("content-type")??"application/json");
  return new Response(text,{status:response.status,headers});
}
async function callAction(request:Request, action:string, body:Record<string,unknown>={}, statusOverride?:number){
  const response=await fetch(upstreamUrl(),{method:"POST",headers:authHeaders(request),body:JSON.stringify({action,...body}),cache:"no-store"});
  const text=await response.text();const headers=new Headers(corsHeaders);headers.set("content-type",response.headers.get("content-type")??"application/json");
  return new Response(text,{status:statusOverride&&response.ok?statusOverride:response.status,headers});
}
function queryBody(request:Request){const q=new URL(request.url).searchParams;const body:Record<string,unknown>={};for(const [key,value] of q){if(["limit","offset"].includes(key))body[key]=Number(value);else if(["includeDeleted"].includes(key))body[key]=value==="true";else body[key]=value;}return body;}
async function jsonBody(request:Request){return await request.json().catch(()=>({})) as Record<string,unknown>;}
async function parts(context:{params:Promise<{path:string[]}>}){return (await context.params).path??[];}
function openApiResponse(request:Request){const headers=new Headers(corsHeaders);headers.set("content-type","application/json");return new Response(JSON.stringify(taskMapRestOpenApi(new URL(request.url).origin)),{status:200,headers});}

export async function GET(request:Request, context:{params:Promise<{path:string[]}>}){
  const p=await parts(context);
  if(p.length===1&&p[0]==="openapi.json")return openApiResponse(request);
  if(p.length===1&&p[0]==="workspace")return callAction(request,"workspace_info");
  if(p.length===1&&p[0]==="tasks")return callAction(request,"list_tasks",queryBody(request));
  if(p.length===2&&p[0]==="tasks")return callAction(request,"get_task",{taskId:p[1],...queryBody(request)});
  if(p.length===1&&p[0]==="projects")return callAction(request,"list_projects");
  return new Response(JSON.stringify({ok:false,error:"Route not found"}),{status:404,headers:{...corsHeaders,"content-type":"application/json"}});
}
export async function POST(request:Request, context:{params:Promise<{path:string[]}>}){
  const p=await parts(context);const body=await jsonBody(request);
  if(p.length===1&&p[0]==="tasks")return callAction(request,"create_task",body,201);
  if(p.length===3&&p[0]==="tasks"&&p[2]==="complete")return callAction(request,"complete_task",{taskId:p[1]});
  if(p.length===3&&p[0]==="tasks"&&p[2]==="reopen")return callAction(request,"reopen_task",{taskId:p[1]});
  if(p.length===3&&p[0]==="tasks"&&p[2]==="restore")return callAction(request,"restore_task",{taskId:p[1]});
  if(p.length===1&&p[0]==="projects")return callAction(request,"create_project",body,201);
  return new Response(JSON.stringify({ok:false,error:"Route not found"}),{status:404,headers:{...corsHeaders,"content-type":"application/json"}});
}
export async function PATCH(request:Request, context:{params:Promise<{path:string[]}>}){
  const p=await parts(context);const body=await jsonBody(request);
  if(p.length===2&&p[0]==="tasks")return callAction(request,"update_task",{taskId:p[1],changes:body});
  if(p.length===2&&p[0]==="projects")return callAction(request,"update_project",{projectId:p[1],changes:body});
  return new Response(JSON.stringify({ok:false,error:"Route not found"}),{status:404,headers:{...corsHeaders,"content-type":"application/json"}});
}
export async function DELETE(request:Request, context:{params:Promise<{path:string[]}>}){
  const p=await parts(context);const q=queryBody(request);
  if(p.length===2&&p[0]==="tasks")return callAction(request,"delete_task",{taskId:p[1],childMode:q.childMode??"orphan"});
  if(p.length===2&&p[0]==="projects")return callProjectDelete(request,p[1],q.taskMode);
  return new Response(JSON.stringify({ok:false,error:"Route not found"}),{status:404,headers:{...corsHeaders,"content-type":"application/json"}});
}
export async function OPTIONS(){return new Response(null,{status:204,headers:corsHeaders});}
