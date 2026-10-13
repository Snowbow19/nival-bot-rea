import { executeNotionConnection } from "./notion-connection.mjs";
import { randomUUID } from "node:crypto";
import { createWorkspaceStore } from "./workspace-store.mjs";
import { workspaceTools, executeWorkspaceTool } from "./workspace-actions.mjs";
import { webTools, executeWebTool } from "./web-tools.mjs";
import { connectorTools, executeConnectorTool } from "./connector-tools.mjs";
import {
  notionTools,
  executeNotionTool,
  notionConnectionStatus,
} from "./notion-tools.mjs";
import {
  calendarTools,
  executeCalendarTool,
  calendarConnectionStatus,
} from "./calendar-tools.mjs";
import { requestApproval } from "./approval-store.mjs";
import { mergeWorkspace } from "../src/workspace-sync.js";

export const workspaceStore = createWorkspaceStore();
const aliases = {
  list_bots: "ListAgents",
  create_bot: "CreateAgent",
  update_bot: "UpdateAgent",
  create_group: "CreateGroup",
  update_group: "UpdateGroup",
  search_conversations: "SearchConversations",
  read_conversation: "ReadConversation",
  add_memory: "WriteMemory",
  list_memories: "ReadMemory",
  remove_memory: "RemoveMemory",
  create_skill: "CreateSkill",
  list_skills: "ListSkills",
  update_skill: "UpdateSkill",
  create_task: "CreateTask",
  list_tasks: "ListTasks",
  set_task_done: "CompleteTask",
  write_artifact: "WriteArtifact",
  list_artifacts: "ListArtifacts",
  read_artifact: "ReadArtifact",
  create_routine: "CreateRoutine",
  list_routines: "ListRoutines",
  update_routine: "UpdateRoutine",
  enable_routine: "SetRoutineEnabled",
};
const localTools = workspaceTools.map((tool) => ({
  ...tool,
  function: {
    ...tool.function,
    name: aliases[tool.function.name] ?? tool.function.name,
  },
}));
const reverse = Object.fromEntries(
  Object.entries(aliases).map(([a, b]) => [b, a]),
);
const delegate = {
  type: "function",
  function: {
    name: "SendToAgent",
    description:
      "Ask another existing Bot to perform a task and return its actual answer. The target conversation is saved.",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        prompt: { type: "string", minLength: 1, maxLength: 16000 },
      },
      required: ["agentId", "prompt"],
      additionalProperties: false,
    },
  },
};
export const availableTools = [
  ...localTools,
  ...webTools,
  ...connectorTools,
  ...notionTools,
  ...calendarTools,
  delegate,
];
export async function syncWorkspace(base, state) {
  return workspaceStore.update((current) => {
    const merged = base ? mergeWorkspace(base, state, current) : state;
    for (const key of Object.keys(current)) delete current[key];
    Object.assign(current, merged);
  });
}
export async function toolContext(agentId) {
  const { state } = await workspaceStore.read();
  if (!state) return null;
  const agent = state.agents.find((a) => a.id === agentId);
  return {
    agent,
    agents: state.agents
      .filter((a) => !a.archived)
      .map((a) => ({
        id: a.id,
        name: a.name,
        isGroup: a.isGroup,
        memberIds: a.memberIds,
      })),
    memories: state.persistence.memories?.[agentId] ?? [],
    skills: state.workflows[agentId] ?? [],
  };
}
let runAgentHandler = null;
export function registerAgentRunner(fn) {
  runAgentHandler = fn;
}
export async function executeTool(name, args, context) {
  if (
    ["CreateRoutine", "UpdateRoutine"].includes(name) &&
    args.schedule?.type !== "once" &&
    /一次|单次|once|one.time/i.test(context.userRequest ?? "") &&
    !/每天|每日|每周|每月|每隔|重复|daily|weekly|every [0-9]+/i.test(
      context.userRequest ?? "",
    )
  )
    return {
      success: false,
      error:
        "用户要求只运行一次。请改用 schedule:{type:once,afterSeconds:相对秒数}，不要创建重复任务。",
    };
  if (notionTools.some((t) => t.function.name === name)) {
    const result = await executeNotionConnection(name, args, {
      signal: context.signal,
    });
    return result.status === "requires_confirmation"
      ? requestApproval(name, args, context.agentId)
      : result;
  }
  if (calendarTools.some((t) => t.function.name === name)) {
    const status = await calendarConnectionStatus();
    if (!status.configured)
      return {
        ok: false,
        status: "needs_authorization",
        connectionUrl: "/connections",
        message: "请先在连接应用页授权此Mac的日历访问。",
      };
    const result = await executeCalendarTool(name, args, {
      signal: context.signal,
    });
    return result.status === "requires_confirmation"
      ? requestApproval(name, args, context.agentId)
      : result;
  }
  if (reverse[name])
    return executeWorkspaceTool(reverse[name], args, {
      store: workspaceStore,
      agentId: context.agentId,
    });
  if (webTools.some((t) => t.function.name === name))
    return executeWebTool(name, args, { signal: context.signal });
  if (connectorTools.some((t) => t.function.name === name)) {
    const result = await executeConnectorTool(name, args);
    return result.status === "requires_confirmation"
      ? requestApproval(name, args, context.agentId)
      : result;
  }
  if (name === "SendToAgent") {
    if ((context.depth ?? 0) >= 2)
      return {
        success: false,
        error: "委派层级已达到上限，请直接与目标 Bot 对话。",
      };
    const { state } = await workspaceStore.read();
    const target = state.agents.find(
      (a) => a.id === args.agentId || a.name === args.agentId,
    );
    if (!target)
      return {
        success: false,
        error: "找不到目标 Bot，请先使用 ListAgents 查询。",
      };
    if (target.id === context.agentId)
      return { success: false, error: "当前就是这个 Bot，请直接完成任务。" };
    if (!runAgentHandler)
      return { success: false, error: "任务执行器尚未就绪。" };
    return runAgentHandler({
      agentId: target.id,
      prompt: args.prompt,
      signal: context.signal,
      depth: (context.depth ?? 0) + 1,
    });
  }
  return { success: false, error: "未知工具。" };
}
export async function getArtifact(id) {
  const { state } = await workspaceStore.read();
  return (
    Object.values(state?.files ?? {})
      .flat()
      .find((file) => file.id === id) ?? null
  );
}
export async function saveAttachment({ agentId, name, contentType, bytes }) {
  const data = Buffer.from(bytes);
  if (data.length > 8 * 1024 * 1024) throw new Error("附件超过 8 MB");
  if (
    typeof name !== "string" ||
    name.includes("/") ||
    name.includes("\\") ||
    name.length > 180
  )
    throw new Error("文件名无效");
  const text =
    /^(text\/|application\/(json|xml))/.test(contentType) ||
    /\.(md|txt|csv|json|js|ts|py|html|css|log)$/i.test(name)
      ? data.toString("utf8")
      : null;
  const file = {
    id: randomUUID(),
    name,
    fileName: name,
    contentType,
    bytes: data.length,
    size: data.length,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...(text !== null
      ? { content: text }
      : { base64: data.toString("base64") }),
  };
  file.url = `/api/artifacts/${file.id}`;
  await workspaceStore.update((state) => {
    if (!state.agents.some((a) => a.id === agentId))
      throw new Error("Bot 不存在");
    (state.files[agentId] ??= []).push(file);
  });
  return file;
}
