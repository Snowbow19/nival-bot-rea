import { randomUUID, createHash } from "node:crypto";
import { workspaceStore } from "./workspace-runtime.mjs";
import { executeConnectedTool } from "./connections.mjs";
export async function requestApproval(name, args, agentId) {
  const signature = createHash("sha256")
    .update(JSON.stringify({ name, args, agentId }))
    .digest("hex");
  const saved = await workspaceStore.update((state) => {
    const rows = (state.persistence.externalApprovals ??= []);
    const existing = rows.find(
      (r) => r.signature === signature && r.status === "pending",
    );
    if (existing) return existing;
    const item = {
      id: randomUUID(),
      name,
      args,
      agentId,
      signature,
      status: "pending",
      createdAt: Date.now(),
    };
    rows.push(item);
    return item;
  });
  const item = saved.result;
  return {
    ok: false,
    status: "requires_confirmation",
    approvalId: item.id,
    reviewUrl: `/connections?approval=${item.id}`,
    message:
      "操作已准备好，请用户打开确认页面检查目标和内容，点击确认后才会写入。",
  };
}
export async function getApproval(id) {
  const { state } = await workspaceStore.read();
  return state?.persistence.externalApprovals?.find((x) => x.id === id) ?? null;
}
export async function resolveApproval(id, { approve, allowConflicts = false }) {
  if (typeof approve !== "boolean" || typeof allowConflicts !== "boolean")
    throw new Error("请选择确认或取消。");
  let item;
  await workspaceStore.update((state) => {
    item = state.persistence.externalApprovals?.find((x) => x.id === id);
    if (!item || item.status !== "pending")
      throw new Error("这个操作已处理或不存在。");
    item.status = approve ? "executing" : "rejected";
  });
  if (!approve) return { ok: true, status: "rejected" };
  let result;
  try {
    result = await executeConnectedTool(item.name, item.args, {
      allowWrite: true,
      allowConflicts,
    });
  } catch {
    result = {
      ok: false,
      status: "unknown",
      message: "结果暂时无法确认，请先检查服务中的实际状态。",
    };
  }
  await workspaceStore.update((state) => {
    const current = state.persistence.externalApprovals.find(
      (x) => x.id === id,
    );
    current.status =
      result.status === "requires_confirmation"
        ? "pending"
        : result.ok
          ? "completed"
          : result.outcome === "unknown" || result.status === "unknown"
            ? "unknown"
            : "failed";
    current.result = result;
  });
  return result;
}
