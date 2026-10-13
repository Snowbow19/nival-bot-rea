import { getAccessToken } from "./notion-oauth.mjs";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

const configFile = new URL("../data/connectors.json", import.meta.url);
const sessions = new Map();
const verifiedConnections = new Map();
export const connectorVerification = (id) =>
  verifiedConnections.get(id) ?? null;
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const str = { type: "string", minLength: 1, maxLength: 200 };
const definitions = {
  SearchPlugins: [
    "List locally configured MCP connectors. Does not install or authenticate services.",
    { query: { type: "string", maxLength: 200 } },
    [],
  ],
  GetMcpTools: [
    "List tool names and short summaries. Supply toolName to retrieve the full input schema before calling a tool.",
    { connectorId: str, toolName: str },
    ["connectorId"],
  ],
  CallMcpTool: [
    "Call a discovered MCP tool. Writes require separate trusted user confirmation.",
    {
      connectorId: str,
      toolName: str,
      arguments: { type: "object", additionalProperties: true },
    },
    ["connectorId", "toolName", "arguments"],
  ],
};
export const connectorTools = Object.entries(definitions).map(
  ([name, [description, properties, required]]) => ({
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
const failure = (code, message) => Object.assign(new Error(message), { code });
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function configuration() {
  let bytes;
  try {
    bytes = await readFile(configFile);
  } catch (error) {
    if (error.code === "ENOENT") bytes = Buffer.from("[]");
    else
      throw failure(
        "configuration_error",
        "Cannot read connector configuration.",
      );
  }
  if (bytes.byteLength > MAX_BYTES)
    throw failure(
      "configuration_error",
      "Connector configuration is too large.",
    );
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw failure(
      "configuration_error",
      "Connector configuration must be valid JSON.",
    );
  }
  const rows = Array.isArray(parsed)
    ? [...parsed]
    : Array.isArray(parsed?.connectors)
      ? [...parsed.connectors]
      : null;
  if (rows && !rows.some((r) => r.id === "notion")) {
    try {
      const access = await getAccessToken();
      rows.push({
        id: "notion",
        name: "Notion",
        url: "https://mcp.notion.com/mcp",
        headers: { Authorization: `Bearer ${access}` },
      });
    } catch {}
  }
  if (!Array.isArray(rows))
    throw failure(
      "configuration_error",
      "Expected a connectors array in data/connectors.json.",
    );
  const ids = new Set();
  return rows
    .filter((row) => row?.enabled !== false)
    .map((row) => {
      if (
        !record(row) ||
        typeof row.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(row.id) ||
        ids.has(row.id)
      )
        throw failure(
          "configuration_error",
          "Connector IDs must be unique letters, numbers, dashes or underscores.",
        );
      ids.add(row.id);
      let url;
      try {
        url = new URL(row.url);
      } catch {
        throw failure("configuration_error", `Invalid endpoint for ${row.id}.`);
      }
      if (
        url.username ||
        url.password ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
      )
        throw failure(
          "configuration_error",
          `Connector ${row.id} requires HTTPS or local HTTP, without URL credentials.`,
        );
      if (
        row.headers !== undefined &&
        (!record(row.headers) ||
          Object.values(row.headers).some((value) => typeof value !== "string"))
      )
        throw failure("configuration_error", `Invalid headers for ${row.id}.`);
      return {
        id: row.id,
        name: typeof row.name === "string" ? row.name.slice(0, 200) : row.id,
        description:
          typeof row.description === "string"
            ? row.description.slice(0, 1000)
            : "",
        url: url.href,
        headers: row.headers ?? {},
      };
    });
}

// Headers, URL query credentials and opaque remote errors are never returned to the model.
function redact(value, connector) {
  const secrets = [
    ...Object.values(connector.headers),
    ...new URL(connector.url).searchParams.values(),
  ].filter((value) => value.length > 3);
  const walk = (input) => {
    if (typeof input === "string") {
      let out = input;
      for (const secret of secrets) out = out.split(secret).join("[redacted]");
      return out;
    }
    if (Array.isArray(input)) return input.map(walk);
    if (record(input))
      return Object.fromEntries(
        Object.entries(input).map(([key, val]) => [
          key,
          /^(authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|password|secret)$/i.test(
            key,
          )
            ? "[redacted]"
            : walk(val),
        ]),
      );
    return input;
  };
  return walk(value);
}
function isReadOnly(tool) {
  if (
    tool.annotations?.readOnlyHint === false ||
    tool.annotations?.destructiveHint === true
  )
    return false;
  if (tool.annotations?.readOnlyHint === true) return true;
  if (
    /(?:^|[_-])(send|post|create|write|update|delete|remove|execute|run|publish|archive|submit|install|set|transfer|purchase)(?:[_-]|$)/i.test(
      tool.name,
    )
  )
    return false;
  return /^(?:notion[-_:])?(?:list|get|read|search|find|fetch|lookup|describe|inspect|query)(?:[_-]|[A-Z])/.test(
    tool.name,
  );
}

async function responseMessage(response, id) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = response.headers
    .get("content-type")
    ?.includes("text/event-stream");
  let size = 0,
    buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        size += value.byteLength;
        if (size > MAX_BYTES)
          throw failure("response_too_large", "MCP response exceeded 2 MiB.");
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += decoder.decode();
      if (sse) {
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (!data) continue;
          let message;
          try {
            message = JSON.parse(data);
          } catch {
            continue;
          }
          if (message.id === id) return message;
        }
      }
      if (done) break;
    }
    if (!sse && buffer.trim()) {
      let message;
      try {
        message = JSON.parse(buffer);
      } catch {
        throw failure("invalid_response", "MCP returned invalid JSON.");
      }
      if (id === undefined || message.id === id) return message;
    }
    return null;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function request(
  connector,
  session,
  method,
  params,
  notification = false,
) {
  const id = notification ? undefined : randomUUID();
  let response;
  try {
    response = await fetch(connector.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        ...connector.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session.id ? { "mcp-session-id": session.id } : {}),
        ...(session.protocol
          ? { "mcp-protocol-version": session.protocol }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(id ? { id } : {}),
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw failure(
        response.status === 401 || response.status === 403
          ? "needs_authentication"
          : "connector_http_error",
        `MCP request failed (HTTP ${response.status}).`,
      );
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) session.id = sessionId;
    if (notification) {
      await response.body?.cancel();
      return null;
    }
    const message = await responseMessage(response, id);
    if (!message)
      throw failure(
        "invalid_response",
        "MCP response did not contain the requested result.",
      );
    if (message.error)
      throw failure(
        "mcp_error",
        `MCP rejected ${method} (code ${Number.isFinite(message.error.code) ? message.error.code : "unknown"}).`,
      );
    if (!Object.hasOwn(message, "result"))
      throw failure("invalid_response", "MCP result is missing.");
    return message.result;
  } catch (error) {
    if (error.code && typeof error.code === "string") throw error;
    throw failure(
      error.name === "TimeoutError" || error.name === "AbortError"
        ? "timeout"
        : "connection_failed",
      "MCP connection failed or timed out.",
    );
  }
}
async function connected(connector) {
  const key = createHash("sha256")
    .update(JSON.stringify(connector))
    .digest("hex");
  const cached = sessions.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const session = {};
    const result = await request(connector, session, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "nival-bot", version: "0.3.0" },
    });
    if (!record(result) || typeof result.protocolVersion !== "string")
      throw failure("invalid_response", "MCP initialize response is invalid.");
    session.protocol = result.protocolVersion;
    await request(
      connector,
      session,
      "notifications/initialized",
      undefined,
      true,
    );
    return session;
  })();
  sessions.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    sessions.delete(key);
    throw error;
  }
}
async function discover(connector, session) {
  const tools = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const result = await request(
      connector,
      session,
      "tools/list",
      cursor ? { cursor } : {},
    );
    if (!record(result) || !Array.isArray(result.tools))
      throw failure("invalid_response", "MCP tool listing is invalid.");
    tools.push(
      ...result.tools.filter(
        (tool) =>
          record(tool) &&
          typeof tool.name === "string" &&
          record(tool.inputSchema),
      ),
    );
    if (!result.nextCursor) return tools;
    if (typeof result.nextCursor !== "string" || result.nextCursor === cursor)
      throw failure("invalid_response", "MCP pagination did not advance.");
    cursor = result.nextCursor;
  }
  throw failure("response_too_large", "MCP tool catalog exceeded 20 pages.");
}
export async function executeConnectorTool(name, args = {}, context = {}) {
  try {
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        throw failure("invalid_arguments", "Tool arguments must be JSON.");
      }
    }
    const definition = definitions[name];
    if (!definition) throw failure("unknown_tool", "Unknown connector tool.");
    if (
      !record(args) ||
      Object.keys(args).some((key) => !Object.hasOwn(definition[1], key)) ||
      definition[2].some((key) => !Object.hasOwn(args, key))
    )
      throw failure("invalid_arguments", "Invalid connector tool arguments.");
    for (const [key, value] of Object.entries(args))
      if (
        key === "arguments"
          ? !record(value)
          : typeof value !== "string" || !value.trim() || value.length > 200
      )
        throw failure("invalid_arguments", `Invalid ${key}.`);
    const connectors = await configuration();
    if (!connectors.length)
      return {
        ok: false,
        status: "needs_configuration",
        message:
          "No MCP connectors configured. Add connector IDs, server URLs and optional authentication headers to data/connectors.json.",
      };
    if (name === "SearchPlugins")
      return {
        ok: true,
        connectors: connectors
          .filter(
            (c) =>
              !args.query ||
              `${c.name} ${c.description} ${c.id}`
                .toLowerCase()
                .includes(args.query.toLowerCase()),
          )
          .map(({ id, name, description }) => ({
            id,
            name,
            description,
            status: "configured",
          })),
      };
    const connector = connectors.find((c) => c.id === args.connectorId);
    if (!connector)
      return {
        ok: false,
        status: "needs_configuration",
        message: "The requested connector ID is not configured.",
      };
    const session = await connected(connector);
    const tools = await discover(connector, session);
    verifiedConnections.set(connector.id, {
      verified: true,
      verifiedAt: Date.now(),
    });
    if (name === "GetMcpTools")
      return redact(
        {
          ok: true,
          connectorId: connector.id,
          tools: tools
            .filter((tool) => !args.toolName || tool.name === args.toolName)
            .map((tool) => ({
              name: tool.name,
              description: args.toolName
                ? tool.description
                : tool.description?.slice(0, 260),
              ...(args.toolName
                ? { inputSchema: tool.inputSchema }
                : {
                    parameters: Object.keys(tool.inputSchema.properties ?? {}),
                    required: tool.inputSchema.required ?? [],
                    retrieveSchemaWithToolName: true,
                  }),
              annotations: tool.annotations,
              requiresConfirmation: !isReadOnly(tool),
            })),
        },
        connector,
      );
    const tool = tools.find((tool) => tool.name === args.toolName);
    if (!tool)
      return {
        ok: false,
        status: "unknown_tool",
        message: "Tool was not found in the connector catalog.",
      };
    if (!isReadOnly(tool) && context.allowWrite !== true)
      return {
        ok: false,
        status: "requires_confirmation",
        message:
          "This external tool is not verified read-only. A separate explicit user approval is required; no tool call was sent.",
      };
    const callArguments = { ...args.arguments };
    if (!isReadOnly(tool) && tool.inputSchema.properties?.allow_async)
      callArguments.allow_async = false;
    const result = await request(connector, session, "tools/call", {
      name: tool.name,
      arguments: callArguments,
    });
    return redact(
      {
        ok: result?.isError !== true,
        connectorId: connector.id,
        toolName: tool.name,
        result,
      },
      connector,
    );
  } catch (error) {
    return {
      ok: false,
      status: error.code ?? "connector_error",
      message: error.code ? error.message : "Connector operation failed.",
      ...(context.allowWrite === true &&
      [
        "timeout",
        "connection_failed",
        "invalid_response",
        "connector_http_error",
      ].includes(error.code)
        ? { outcome: "unknown", readBeforeRetry: true }
        : {}),
    };
  }
}
