export function taskMapRestOpenApi(origin: string) {
  const taskProps = {
    id:{type:"string",format:"uuid"}, title:{type:"string"}, notes:{type:"string"}, tags:{type:"array",items:{type:"string"}},
    status:{type:"string",enum:["not_started","in_progress","blocked","done"]}, priority:{type:"string",enum:["urgent","high","normal","low"]},
    projectId:{type:"string",format:"uuid",nullable:true}, parentTaskId:{type:"string",format:"uuid",nullable:true},
    startDate:{type:"string",format:"date",nullable:true}, startTime:{type:"string",nullable:true,description:"HH:MM"}, estimatedMinutes:{type:"number",nullable:true},
    dueDate:{type:"string",format:"date",nullable:true}, dueTime:{type:"string",nullable:true,description:"HH:MM"},
    completedAt:{type:"string",format:"date-time",nullable:true}, deletedAt:{type:"string",format:"date-time",nullable:true}
  } as const;
  const taskWriteProps = {
    title:{type:"string"}, notes:{type:"string"}, tags:{type:"array",items:{type:"string"}}, priority:{type:"string",enum:["urgent","high","normal","low"]},
    projectId:{type:"string",format:"uuid",nullable:true}, projectName:{type:"string",nullable:true}, parentTaskId:{type:"string",format:"uuid",nullable:true}, parentTitle:{type:"string",nullable:true},
    startDate:{type:"string",format:"date",nullable:true}, startTime:{type:"string",nullable:true,description:"HH:MM"}, estimatedMinutes:{type:"number",nullable:true,minimum:0},
    dueDate:{type:"string",format:"date",nullable:true}, dueTime:{type:"string",nullable:true,description:"HH:MM"}, recurrence:{type:"object",nullable:true,properties:{},additionalProperties:true}
  } as const;
  const responseSchema = { type:"object", properties:{ ok:{type:"boolean"}, data:{type:"object",properties:{},additionalProperties:true}, error:{type:"string"} }, additionalProperties:true };
  const responses = {
    "200":{description:"Success",content:{"application/json":{schema:responseSchema}}},
    "201":{description:"Created",content:{"application/json":{schema:responseSchema}}},
    "400":{description:"Invalid request",content:{"application/json":{schema:responseSchema}}},
    "401":{description:"Invalid or revoked API key",content:{"application/json":{schema:responseSchema}}},
    "403":{description:"API key does not have write permission",content:{"application/json":{schema:responseSchema}}},
    "404":{description:"Resource not found",content:{"application/json":{schema:responseSchema}}},
    "409":{description:"Ambiguous or duplicate resource",content:{"application/json":{schema:responseSchema}}},
  };
  const bearer = [{TaskMapApiKey:[]}];
  return {
    openapi:"3.1.0",
    info:{title:"TaskMap GPT Actions API",version:"1.5.0",description:"REST-style workspace-scoped TaskMap API. Each operation is a separate GPT Action. Use task IDs after searching when names are ambiguous."},
    servers:[{url:origin}],
    components:{
      securitySchemes:{TaskMapApiKey:{type:"http",scheme:"bearer",bearerFormat:"TMAPI1",description:"TaskMap External API key from Settings > External API."}},
      schemas:{
        Task:{type:"object",properties:taskProps,additionalProperties:true},
        TaskCreate:{type:"object",required:["title"],properties:{...taskWriteProps,status:{type:"string",enum:["not_started","in_progress","blocked","done"]}},additionalProperties:false},
        TaskPatch:{type:"object",properties:taskWriteProps,additionalProperties:false,description:"Do not change completion state here; use completeTask or reopenTask."},
        Project:{type:"object",properties:{id:{type:"string",format:"uuid"},name:{type:"string"},color:{type:"string"}},additionalProperties:true},
        ProjectCreate:{type:"object",required:["name"],properties:{name:{type:"string"},color:{type:"string",pattern:"^#[0-9A-Fa-f]{6}$"}},additionalProperties:false},
        ProjectPatch:{type:"object",properties:{name:{type:"string"},color:{type:"string",pattern:"^#[0-9A-Fa-f]{6}$"}},additionalProperties:false},
      }
    },
    security:bearer,
    paths:{
      "/api/taskmap/workspace":{get:{operationId:"getWorkspaceInfo",summary:"Get connected TaskMap workspace",responses}},
      "/api/taskmap/tasks":{
        get:{operationId:"searchTasks",summary:"Search and filter tasks",parameters:[
          {name:"query",in:"query",schema:{type:"string"},description:"Search title, notes, and tags."},
          {name:"status",in:"query",schema:{type:"string",enum:["not_started","in_progress","blocked","done"]}},
          {name:"priority",in:"query",schema:{type:"string",enum:["urgent","high","normal","low"]}},
          {name:"projectId",in:"query",schema:{type:"string",format:"uuid"}}, {name:"projectName",in:"query",schema:{type:"string"}},
          {name:"parentTaskId",in:"query",schema:{type:"string",format:"uuid"}}, {name:"tag",in:"query",schema:{type:"string"}},
          {name:"limit",in:"query",schema:{type:"integer",minimum:1,maximum:200,default:100}}, {name:"offset",in:"query",schema:{type:"integer",minimum:0,default:0}},
          {name:"includeDeleted",in:"query",schema:{type:"boolean",default:false}}
        ],responses},
        post:{operationId:"createTask",summary:"Create a task or subtask",requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/TaskCreate"}}}},responses}
      },
      "/api/taskmap/tasks/{taskId}":{
        get:{operationId:"getTask",summary:"Get a task",parameters:[{name:"taskId",in:"path",required:true,schema:{type:"string",format:"uuid"}},{name:"includeDeleted",in:"query",schema:{type:"boolean",default:false}}],responses},
        patch:{operationId:"updateTask",summary:"Update task fields",parameters:[{name:"taskId",in:"path",required:true,schema:{type:"string",format:"uuid"}}],requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/TaskPatch"}}}},responses},
        delete:{operationId:"deleteTask",summary:"Soft-delete a task",description:"orphan keeps children; cascade deletes all nested descendants.",parameters:[{name:"taskId",in:"path",required:true,schema:{type:"string",format:"uuid"}},{name:"childMode",in:"query",schema:{type:"string",enum:["orphan","cascade"],default:"orphan"}}],responses}
      },
      "/api/taskmap/tasks/{taskId}/complete":{post:{operationId:"completeTask",summary:"Complete a task",description:"Completes incomplete descendants and advances recurring tasks when applicable.",parameters:[{name:"taskId",in:"path",required:true,schema:{type:"string",format:"uuid"}}],responses}},
      "/api/taskmap/tasks/{taskId}/reopen":{post:{operationId:"reopenTask",summary:"Reopen a completed task",parameters:[{name:"taskId",in:"path",required:true,schema:{type:"string",format:"uuid"}}],responses}},
      "/api/taskmap/tasks/{taskId}/restore":{post:{operationId:"restoreTask",summary:"Restore a task from Trash",parameters:[{name:"taskId",in:"path",required:true,schema:{type:"string",format:"uuid"}}],responses}},
      "/api/taskmap/projects":{
        get:{operationId:"listProjects",summary:"List projects",responses},
        post:{operationId:"createProject",summary:"Create a project",requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/ProjectCreate"}}}},responses}
      },
      "/api/taskmap/projects/{projectId}":{
        patch:{operationId:"updateProject",summary:"Rename or recolor a project",parameters:[{name:"projectId",in:"path",required:true,schema:{type:"string",format:"uuid"}}],requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/ProjectPatch"}}}},responses},
        delete:{operationId:"deleteProject",summary:"Delete a project",description:"detach keeps tasks and makes project tasks unassigned. cascade soft-deletes project tasks plus all nested descendants.",parameters:[{name:"projectId",in:"path",required:true,schema:{type:"string",format:"uuid"}},{name:"taskMode",in:"query",schema:{type:"string",enum:["detach","cascade"],default:"detach"}}],responses}
      }
    }
  };
}
