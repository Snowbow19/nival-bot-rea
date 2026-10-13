import { randomUUID } from "node:crypto";
const str = (maxLength = 2000) => ({ type: "string", minLength: 1, maxLength });
const bool = { type: "boolean" };
const strings = {
  type: "array",
  items: str(200),
  maxItems: 100,
  uniqueItems: true,
};
const botRef = { agentId: str(200) };
const scheduleSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["once", "daily", "interval"] },
    at: str(60),
    afterSeconds: { type: "integer", minimum: 1, maximum: 86400 },
    time: str(5),
    timeZone: str(100),
    minutes: { type: "integer", minimum: 1, maximum: 525600 },
  },
  required: ["type"],
  additionalProperties: false,
};
const specs = {
  list_bots: [
    "List local Bots and groups, including their IDs.",
    { includeArchived: bool },
  ],
  create_bot: [
    "Create a real Bot using the globally configured model.",
    { name: str(100), description: str(8000), instructions: str(16000) },
    ["name"],
  ],
  update_bot: [
    "Update a Bot profile or archive it without deleting its conversations.",
    {
      ...botRef,
      name: str(100),
      description: str(8000),
      instructions: str(16000),
      archived: bool,
    },
  ],
  create_group: [
    "Create a real group from existing Bots. Omit members to use all active individual Bots. Unknown or ambiguous members fail.",
    { name: str(100), memberIds: strings, memberNames: strings },
    ["name"],
  ],
  update_group: [
    "Update a group name or replace its member list with existing individual Bots.",
    { ...botRef, name: str(100), memberIds: strings, memberNames: strings },
  ],
  search_conversations: [
    "Search saved local conversation text, optionally within a Bot.",
    {
      ...botRef,
      query: str(500),
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    ["query"],
  ],
  read_conversation: [
    "Read saved messages for the current or specified Bot.",
    { ...botRef, limit: { type: "integer", minimum: 1, maximum: 200 } },
  ],
  add_memory: [
    "Save a durable memory for a Bot.",
    { ...botRef, content: str(8000) },
    ["content"],
  ],
  list_memories: ["List durable memories for a Bot.", { ...botRef }],
  remove_memory: [
    "Remove one Bot memory by its ID.",
    { ...botRef, memoryId: str(200) },
    ["memoryId"],
  ],
  create_skill: [
    "Save reusable instructions for a Bot; does not install external software or integrations.",
    { ...botRef, name: str(100), instructions: str(16000) },
    ["name", "instructions"],
  ],
  list_skills: ["List reusable instructions for a Bot.", { ...botRef }],
  update_skill: [
    "Update saved reusable Bot instructions.",
    { ...botRef, skillId: str(200), name: str(100), instructions: str(16000) },
    ["skillId"],
  ],
  create_task: [
    "Create a tracked task; creating it does not execute it.",
    { ...botRef, title: str(200), description: str(8000) },
    ["title"],
  ],
  list_tasks: ["List tracked tasks for a Bot.", { ...botRef }],
  set_task_done: [
    "Set whether a tracked task is complete.",
    { ...botRef, taskId: str(200), done: bool },
    ["taskId", "done"],
  ],
  write_artifact: [
    "Create a downloadable text, Markdown, or JSON artifact in the local workspace.",
    {
      ...botRef,
      name: str(160),
      format: { type: "string", enum: ["markdown", "text", "json"] },
      content: str(200000),
    },
    ["name", "format", "content"],
  ],
  list_artifacts: ["List local generated artifacts for a Bot.", { ...botRef }],
  read_artifact: [
    "Read an artifact previously created in this workspace.",
    { ...botRef, artifactId: str(200) },
    ["artifactId"],
  ],
  create_routine: [
    "Save an automated Bot prompt. For a ONE-TIME delay use schedule {type:once,afterSeconds:60}; never use interval for a one-time request. Use daily/interval only for explicitly recurring tasks.",
    {
      ...botRef,
      name: str(100),
      prompt: str(16000),
      schedule: scheduleSchema,
      enabled: bool,
    },
    ["name", "prompt", "schedule"],
  ],
  list_routines: ["List saved routines for a Bot.", { ...botRef }],
  update_routine: [
    "Update a scheduled routine.",
    {
      ...botRef,
      routineId: str(200),
      name: str(100),
      prompt: str(16000),
      schedule: scheduleSchema,
    },
    ["routineId"],
  ],
  enable_routine: [
    "Enable or disable a saved routine.",
    { ...botRef, routineId: str(200), enabled: bool },
    ["routineId", "enabled"],
  ],
};
export const workspaceTools = Object.entries(specs).map(
  ([name, [description, properties, required = []]]) => ({
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  }),
);
const fail = (message, code = "INVALID_ARGUMENT") => {
  const e = new Error(message);
  e.code = code;
  throw e;
};
function validate(value, schema, label = "arguments") {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail(`${label} must be an object`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key))
        fail(`Unknown ${label}.${key}`);
      validate(value[key], schema.properties[key], `${label}.${key}`);
    }
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(value, key)) fail(`Missing ${label}.${key}`);
  } else if (schema.type === "array") {
    if (
      !Array.isArray(value) ||
      value.length > schema.maxItems ||
      new Set(value).size !== value.length
    )
      fail(`Invalid ${label}`);
    value.forEach((v) => validate(v, schema.items, label));
  } else if (schema.type === "string") {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > schema.maxLength
    )
      fail(`Invalid ${label}`);
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") fail(`${label} must be boolean`);
  } else if (schema.type === "integer") {
    if (
      !Number.isInteger(value) ||
      value < schema.minimum ||
      value > schema.maximum
    )
      fail(`Invalid ${label}`);
  }
  if (schema.enum && !schema.enum.includes(value)) fail(`Invalid ${label}`);
}
function resolve(state, reference, { group } = {}) {
  const candidates = state.agents.filter(
    (a) => a.id === reference || a.name === reference,
  );
  const exact = candidates.find((a) => a.id === reference);
  const bot = exact ?? (candidates.length === 1 ? candidates[0] : null);
  if (!bot)
    fail(
      candidates.length > 1
        ? `Ambiguous Bot: ${reference}; use its ID`
        : `Unknown Bot: ${reference}`,
      "BOT_NOT_FOUND",
    );
  if (group !== undefined && Boolean(bot.isGroup) !== group)
    fail(group ? "Expected a group" : "Expected an individual Bot");
  return bot;
}
function members(state, args) {
  const refs = [...(args.memberIds ?? []), ...(args.memberNames ?? [])];
  const selected = refs.length
    ? refs.map((ref) => resolve(state, ref, { group: false }))
    : state.agents.filter((a) => !a.isGroup && !a.archived);
  if (!selected.length)
    fail(
      "No available Bots. Create a Bot or specify existing members first.",
      "NEEDS_INPUT",
    );
  if (selected.some((a) => a.archived))
    fail("Archived Bots cannot join a group");
  return [...new Set(selected.map((a) => a.id))];
}
function schedule(value) {
  const s = structuredClone(value);
  if (s.type === "once") {
    if (s.afterSeconds !== undefined) {
      if (s.at) fail("Provide at or afterSeconds, not both");
      s.at = new Date(Date.now() + s.afterSeconds * 1000).toISOString();
      delete s.afterSeconds;
    }
    if (
      !s.at ||
      !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(s.at) ||
      !Number.isFinite(Date.parse(s.at)) ||
      Date.parse(s.at) <= Date.now()
    )
      fail("once requires a future ISO timestamp including timezone");
  }
  if (s.type === "daily") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time ?? ""))
      fail("daily requires time HH:mm");
    s.timeZone ??= "Asia/Shanghai";
    try {
      new Intl.DateTimeFormat("en", { timeZone: s.timeZone });
    } catch {
      fail("Invalid timezone");
    }
  }
  if (s.type === "interval" && !s.minutes) fail("interval requires minutes");
  const allowed = {
    once: ["type", "at"],
    daily: ["type", "time", "timeZone"],
    interval: ["type", "minutes"],
  }[s.type];
  if (Object.keys(s).some((key) => !allowed.includes(key)))
    fail("Schedule contains fields for a different schedule type");
  return s;
}
const scheduleLabel = (s) =>
  s.type === "daily"
    ? `${Number(s.time.split(":")[1])} ${Number(s.time.split(":")[0])} * * *`
    : s.type === "interval"
      ? `every ${s.minutes} minutes`
      : s.at;
const publicBot = (bot) => ({
  id: bot.id,
  name: bot.name,
  description: bot.description ?? "",
  instructions: bot.instructions ?? "",
  isGroup: Boolean(bot.isGroup),
  memberIds: bot.memberIds ?? [],
  archived: Boolean(bot.archived),
});
const textOf = (entry) =>
  typeof entry.content === "string"
    ? entry.content
    : typeof entry.message?.content === "string"
      ? entry.message.content
      : "";
const readOnly = new Set([
  "list_bots",
  "search_conversations",
  "read_conversation",
  "list_memories",
  "list_skills",
  "list_tasks",
  "list_artifacts",
  "read_artifact",
  "list_routines",
]);
export async function executeWorkspaceTool(
  name,
  args,
  { store, agentId } = {},
) {
  try {
    const definition = workspaceTools.find((t) => t.function.name === name);
    if (!definition) fail(`Unknown tool: ${name}`, "UNKNOWN_TOOL");
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        fail("Tool arguments must be valid JSON");
      }
    }
    validate(args, definition.function.parameters);
    const run = (state) => {
      if (!state) fail("Workspace has not been initialized", "WORKSPACE_EMPTY");
      const now = Date.now();
      if (name === "list_bots")
        return state.agents
          .filter((a) => args.includeArchived || !a.archived)
          .map(publicBot);
      if (name === "create_bot" || name === "create_group") {
        const group = name === "create_group";
        const memberIds = group ? members(state, args) : [];
        const bot = {
          id: randomUUID(),
          name: args.name.trim(),
          description: args.description ?? "",
          instructions: args.instructions ?? "",
          harness: "temporal",
          isGroup: group,
          memberIds,
          avatarShape: "squircle",
          avatarColor: "blue",
          isRunning: false,
          isRunningTurn: false,
          awaitingUserResponse: null,
          createdAt: now,
          updatedAt: now,
          hasUnread: false,
          archived: false,
          viewerIsOwner: true,
        };
        state.agents.push(bot);
        state.transcripts[bot.id] = [];
        return publicBot(bot);
      }
      if (name === "search_conversations") {
        const id = args.agentId ? resolve(state, args.agentId).id : null;
        const results = [];
        for (const [key, entries] of Object.entries(state.transcripts))
          if (!id || id === key)
            for (const entry of entries) {
              const content = textOf(entry);
              if (
                content
                  .toLocaleLowerCase()
                  .includes(args.query.toLocaleLowerCase())
              )
                results.push({
                  agentId: key,
                  agentName: state.agents.find((a) => a.id === key)?.name,
                  entryId: entry.id,
                  content: content.slice(0, 4000),
                  timestampMs: entry.timestampMs,
                });
            }
        return results.slice(-(args.limit ?? 30));
      }
      const bot = resolve(state, args.agentId ?? agentId ?? state.mainAgentId);
      const id = bot.id;
      if (name === "read_conversation")
        return {
          agent: publicBot(bot),
          entries: (state.transcripts[id] ?? []).slice(-(args.limit ?? 60)),
        };
      if (name === "update_bot" || name === "update_group") {
        if (name === "update_group" && !bot.isGroup) fail("Expected a group");
        for (const key of ["name", "description", "instructions", "archived"])
          if (args[key] !== undefined) bot[key] = args[key];
        if (args.memberIds !== undefined || args.memberNames !== undefined)
          bot.memberIds = members(state, args);
        bot.updatedAt = now;
        return publicBot(bot);
      }
      state.persistence.memories ??= {};
      state.persistence.tasks ??= {};
      const collections = {
        memory: state.persistence.memories,
        skill: state.workflows,
        task: state.persistence.tasks,
        artifact: state.files,
        routine: state.automations,
      };
      const kind = name.includes("memor")
        ? "memory"
        : name.includes("skill")
          ? "skill"
          : name.includes("task")
            ? "task"
            : name.includes("artifact")
              ? "artifact"
              : "routine";
      const rows = (collections[kind][id] ??= []);
      if (name.startsWith("list_"))
        return kind === "artifact"
          ? rows.map(({ content, base64, ...metadata }) => metadata)
          : rows;
      if (name === "add_memory") {
        const item = {
          id: randomUUID(),
          agentId: id,
          content: args.content,
          createdAt: now,
        };
        rows.push(item);
        return item;
      }
      if (name === "create_skill") {
        const item = {
          id: randomUUID(),
          agentId: id,
          name: args.name,
          description: args.instructions,
          instructions: args.instructions,
          prompt: args.instructions,
          body: args.instructions,
          trigger: null,
          sourceRef: null,
          createdAt: now,
          updatedAt: now,
        };
        rows.push(item);
        return item;
      }
      if (name === "create_task") {
        const item = {
          id: randomUUID(),
          agentId: id,
          title: args.title,
          name: args.title,
          description: args.description ?? "",
          status: "open",
          done: false,
          createdAt: now,
          updatedAt: now,
          updatedAtMs: now,
        };
        rows.push(item);
        return item;
      }
      if (name === "write_artifact") {
        if (
          /[\\/\x00-\x1f]/.test(args.name) ||
          args.name === "." ||
          args.name === ".."
        )
          fail("Artifact name must be a plain filename");
        if (args.format === "json") {
          try {
            JSON.parse(args.content);
          } catch {
            fail("JSON artifact content is invalid");
          }
        }
        const artifactId = randomUUID();
        const extensions = { markdown: ".md", text: ".txt", json: ".json" };
        const fileName = args.name.endsWith(extensions[args.format])
          ? args.name
          : args.name + extensions[args.format];
        const item = {
          id: artifactId,
          agentId: id,
          name: fileName,
          fileName,
          format: args.format,
          content: args.content,
          mimeType: {
            markdown: "text/markdown",
            text: "text/plain",
            json: "application/json",
          }[args.format],
          size: Buffer.byteLength(args.content),
          createdAt: now,
          url: `/api/artifacts/${artifactId}`,
          downloadUrl: `/api/artifacts/${artifactId}`,
        };
        rows.push(item);
        const { content, ...metadata } = item;
        return metadata;
      }
      if (name === "create_routine") {
        const normalized = schedule(args.schedule);
        const item = {
          id: randomUUID(),
          agentId: id,
          name: args.name,
          prompt: args.prompt,
          localSchedule: normalized,
          schedule: scheduleLabel(normalized),
          trigger: { type: "schedule" },
          triggerDescription:
            normalized.type === "daily"
              ? `每天 ${normalized.time}`
              : normalized.type === "interval"
                ? `每 ${normalized.minutes} 分钟`
                : normalized.at,
          filePath: "local-routine",
          runs: [],
          isEnabled: args.enabled ?? true,
          createdAt: now,
          updatedAt: now,
        };
        rows.push(item);
        return item;
      }
      const targetId =
        args.memoryId ??
        args.skillId ??
        args.taskId ??
        args.artifactId ??
        args.routineId;
      const item = rows.find((row) => row.id === targetId);
      if (!item) fail(`Unknown ${kind}: ${targetId}`, "NOT_FOUND");
      if (name === "remove_memory") {
        rows.splice(rows.indexOf(item), 1);
        return { removed: true, id: targetId };
      }
      if (name === "read_artifact") {
        const { base64, ...safe } = item;
        return typeof item.content === "string"
          ? safe
          : {
              ...safe,
              parsed: false,
              message:
                "二进制文件已保存，当前工具不返回二进制内容；图片可在上传消息中交给模型阅读。",
            };
      }
      if (name === "update_skill") {
        if (args.name !== undefined) item.name = args.name;
        if (args.instructions !== undefined)
          item.body =
            item.description =
            item.instructions =
            item.prompt =
              args.instructions;
      }
      if (name === "set_task_done") {
        item.done = args.done;
        item.status = args.done ? "done" : "open";
        item.updatedAtMs = now;
        item.completedAt = args.done ? now : null;
      }
      if (name === "update_routine") {
        for (const key of ["name", "prompt"])
          if (args[key] !== undefined) item[key] = args[key];
        if (args.schedule) {
          item.localSchedule = schedule(args.schedule);
          item.schedule = scheduleLabel(item.localSchedule);
          item.triggerDescription = scheduleLabel(item.localSchedule);
          item.trigger = { type: "schedule" };
          item.nextRunAt = null;
        }
      }
      if (name === "enable_routine") {
        item.isEnabled = args.enabled;
        item.nextRunAt = null;
      }
      item.updatedAt = now;
      return item;
    };
    if (readOnly.has(name)) {
      const snapshot = await store.read();
      return {
        success: true,
        data: run(snapshot.state),
        version: snapshot.version,
        events: [],
      };
    }
    const result = await store.update(run);
    return {
      success: true,
      data: result.result,
      version: result.version,
      events: [
        {
          type: [
            "create_bot",
            "update_bot",
            "create_group",
            "update_group",
          ].includes(name)
            ? "roster-changed"
            : "workspace-changed",
        },
      ],
    };
  } catch (error) {
    return {
      success: false,
      error: { code: error.code ?? "WORKSPACE_ERROR", message: error.message },
    };
  }
}
