import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const defaultWorkspaceFile = fileURLToPath(
  new URL("../data/workspace.json", import.meta.url),
);
const empty = () => ({
  agents: [],
  pinned: [],
  sections: [],
  mainAgentId: null,
  transcripts: {},
  automations: {},
  workflows: {},
  files: {},
  preferences: {},
  persistence: {},
  userName: "",
});
export function normalizeWorkspace(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Workspace must be an object");
  const state = { ...empty(), ...structuredClone(input) };
  for (const key of ["agents", "pinned", "sections"])
    if (!Array.isArray(state[key])) throw new Error(`${key} must be an array`);
  for (const key of [
    "transcripts",
    "automations",
    "workflows",
    "files",
    "preferences",
    "persistence",
  ])
    if (
      !state[key] ||
      typeof state[key] !== "object" ||
      Array.isArray(state[key])
    )
      throw new Error(`${key} must be an object`);
  for (const rows of Object.values(state.automations))
    for (const routine of rows) {
      routine.runs ??= [];
      routine.filePath ??= "";
      routine.triggerDescription ??=
        typeof routine.schedule === "string" ? routine.schedule : "";
      routine.schedule =
        typeof routine.schedule === "string"
          ? routine.schedule
          : (routine.trigger?.schedule ?? "");
      routine.trigger ??= { type: "schedule" };
    }
  for (const rows of Object.values(state.workflows))
    for (const skill of rows) {
      skill.body ??= skill.content ?? skill.instructions ?? "";
      skill.trigger ??= null;
      skill.sourceRef ??= null;
    }
  for (const entries of Object.values(state.transcripts))
    for (const entry of entries) {
      const url = entry.message?.type === "attachment" && entry.message.url;
      if (typeof url === "string" && url.startsWith("/api/artifacts/")) {
        try {
          entry.message.url = decodeURI(url);
        } catch {}
      }
    }
  const ids = new Set();
  for (const agent of state.agents) {
    if (
      !agent ||
      typeof agent.id !== "string" ||
      !agent.id ||
      ids.has(agent.id)
    )
      throw new Error("Agents require unique string IDs");
    ids.add(agent.id);
  }
  return state;
}
export function createWorkspaceStore({ filePath = defaultWorkspaceFile } = {}) {
  let queue = Promise.resolve();
  async function load() {
    try {
      const data = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (!Number.isSafeInteger(data.version) || data.version < 0)
        throw new Error("Invalid workspace version");
      return { version: data.version, state: normalizeWorkspace(data.state) };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 0, state: null };
      throw error;
    }
  }
  async function commit(snapshot) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(snapshot));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, filePath);
      await fs.chmod(filePath, 0o600);
    } finally {
      await fs.unlink(temp).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  function update(mutator, { expectedVersion } = {}) {
    const operation = queue.then(async () => {
      const snapshot = await load();
      if (
        expectedVersion !== undefined &&
        expectedVersion !== snapshot.version
      ) {
        const error = new Error("Workspace changed; reload before saving");
        error.code = "VERSION_CONFLICT";
        error.version = snapshot.version;
        throw error;
      }
      snapshot.state ??= empty();
      const result = await mutator(snapshot.state);
      snapshot.state = normalizeWorkspace(snapshot.state);
      snapshot.version += 1;
      await commit(snapshot);
      return { ...snapshot, result };
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    filePath,
    read: async () => {
      await queue;
      return load();
    },
    update,
    replace: (state, options) =>
      update((current) => {
        const normalized = normalizeWorkspace(state);
        for (const key of Object.keys(current)) delete current[key];
        Object.assign(current, normalized);
      }, options),
  };
}
