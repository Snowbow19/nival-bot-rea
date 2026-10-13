import {
  notionConnectionStatus,
  executeNotionTool,
  validateNotionArguments,
} from "./notion-tools.mjs";
import { getAccessToken } from "./notion-oauth.mjs";
import { executeConnectorTool } from "./connector-tools.mjs";
export async function executeNotionConnection(name, args, context = {}) {
  if (notionConnectionStatus().configured)
    return executeNotionTool(name, args, context);
  try {
    args = validateNotionArguments(name, args);
  } catch {
    return {
      ok: false,
      status: "invalid_arguments",
      message: "Notion 参数不完整或格式不正确。",
    };
  }
  try {
    await getAccessToken();
  } catch {
    return {
      ok: false,
      status: "needs_authorization",
      connectionUrl: "/connections",
      message: "请先在连接应用页连接 Notion。",
    };
  }
  const write = ["CreateNotionPage", "AppendNotionPage"].includes(name);
  if (write && context.allowWrite !== true)
    return { ok: false, status: "requires_confirmation" };
  let toolName, parameters;
  if (name === "SearchNotion") {
    if (!args.query?.trim())
      return {
        ok: false,
        status: "needs_query",
        message: "请输入要查找的标题关键词。",
      };
    toolName = "notion-search";
    parameters = {
      query: args.query,
      page_size: Math.min(args.limit ?? 10, 50),
      max_highlight_length: 0,
    };
  } else if (name === "ReadNotionPage") {
    toolName = "notion-fetch";
    parameters = { id: args.pageId };
  } else if (name === "CreateNotionPage") {
    toolName = "notion-create-pages";
    parameters = {
      parent: { page_id: args.parentPageId },
      pages: [
        {
          properties: { title: args.title },
          content: args.markdown ?? args.text,
        },
      ],
      allow_async: false,
    };
  } else if (name === "AppendNotionPage") {
    toolName = "notion-update-page";
    parameters = {
      page_id: args.pageId,
      command: "insert_content",
      content: args.markdown ?? args.text,
      position: { type: "end" },
      allow_async: false,
    };
  } else return { ok: false, status: "unsupported" };
  return executeConnectorTool(
    "CallMcpTool",
    { connectorId: "notion", toolName, arguments: parameters },
    context,
  );
}
