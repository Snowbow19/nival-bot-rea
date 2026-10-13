import { executeNotionConnection } from "./notion-connection.mjs";
import fs from "node:fs/promises";
import {
  executeConnectorTool,
  connectorVerification,
} from "./connector-tools.mjs";
import path from "node:path";
import { notionConnectionStatus, executeNotionTool } from "./notion-tools.mjs";
import {
  status as notionOAuthStatus,
  start as startNotionOAuth,
  finish as finishNotionOAuth,
} from "./notion-oauth.mjs";
import {
  calendarConnectionStatus,
  authorizeCalendar,
  executeCalendarTool,
} from "./calendar-tools.mjs";
const root = path.resolve(import.meta.dirname, "..");
export async function connectionStatus() {
  const api = notionConnectionStatus();
  const notion = api.configured
    ? { status: "connected", configured: true, mode: "integration" }
    : await notionOAuthStatus().catch(() => ({
        status: "unavailable",
        configured: false,
      }));
  const calendar = await calendarConnectionStatus();
  return {
    notion: {
      ...notion,
      ...(connectorVerification("notion") ?? {}),
      configured: api.configured || notion.status === "connected",
    },
    calendar,
  };
}
export async function saveNotionToken(token) {
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 1000 ||
    /[\r\n\0]/.test(token)
  )
    throw new Error("密钥格式不正确。");
  const r = await fetch("https://api.notion.com/v1/users/me", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2026-03-11",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error("Notion 未接受此密钥，请检查密钥和集成权限。");
  let content = "";
  try {
    content = await fs.readFile(path.join(root, ".env"), "utf8");
  } catch {}
  const line = `NOTION_API_KEY=${JSON.stringify(token)}`;
  content = /^NOTION_API_KEY=.*$/m.test(content)
    ? content.replace(/^NOTION_API_KEY=.*$/m, line)
    : content.trimEnd() + "\n" + line + "\n";
  const temp = path.join(root, ".env.new");
  await fs.writeFile(temp, content, { mode: 0o600 });
  await fs.rename(temp, path.join(root, ".env"));
  await fs.chmod(path.join(root, ".env"), 0o600);
  process.env.NOTION_API_KEY = token;
  return { configured: true, status: "connected", mode: "integration" };
}
export { startNotionOAuth, finishNotionOAuth, authorizeCalendar };
export async function executeConnectedTool(name, args, context = {}) {
  if (name === "CallMcpTool") return executeConnectorTool(name, args, context);
  if (name.includes("Notion"))
    return executeNotionConnection(name, args, context);
  return executeCalendarTool(name, args, context);
}
