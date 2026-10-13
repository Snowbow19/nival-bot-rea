// Official contracts: developers.notion.com/reference/{post-search,get-block-children,post-page,patch-block-children,update-page-markdown}
const API_VERSION = "2026-03-11";
const API_ROOT = "https://api.notion.com/v1";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const string = (maxLength, minLength = 1) => ({
  type: "string",
  minLength,
  maxLength,
});
const idSchema = {
  ...string(36),
  pattern:
    "^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$",
};
const contentFields = { markdown: string(100000), text: string(100000) };
const specs = {
  SearchNotion: [
    "Search titles of pages shared with the configured Notion integration. This is not full-text search.",
    {
      query: string(200, 0),
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    },
    [],
  ],
  ReadNotionPage: [
    "Read a shared Notion page and recursively paginate its blocks. Returns explicit truncation and omitted-child information.",
    {
      pageId: idSchema,
      maxBlocks: { type: "integer", minimum: 1, maximum: 1000 },
      maxDepth: { type: "integer", minimum: 0, maximum: 8 },
    },
    ["pageId"],
  ],
  CreateNotionPage: [
    "Create a child page under an explicitly selected parent. Requires trusted user approval outside model arguments. Supply exactly one of markdown or text.",
    { parentPageId: idSchema, title: string(2000), ...contentFields },
    ["parentPageId", "title"],
  ],
  AppendNotionPage: [
    "Append content to a shared page without replacing its existing content. Requires trusted user approval outside model arguments. Supply exactly one of markdown or text.",
    { pageId: idSchema, ...contentFields },
    ["pageId"],
  ],
};
export const notionTools = Object.entries(specs).map(
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
const token = () =>
  (process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "").trim();
export const notionConnectionStatus = () => ({ configured: Boolean(token()) });
const fail = (code, message, extra = {}) =>
  Object.assign(new Error(message), { code, notionToolError: true, ...extra });
function validate(name, args) {
  const spec = specs[name];
  if (!spec) throw fail("unknown_tool", "Unknown Notion tool.");
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      throw fail("invalid_arguments", "Arguments must be valid JSON.");
    }
  }
  if (
    !record(args) ||
    Object.keys(args).some((k) => !Object.hasOwn(spec[1], k)) ||
    spec[2].some((k) => !Object.hasOwn(args, k))
  )
    throw fail("invalid_arguments", "Missing or unsupported arguments.");
  for (const [key, value] of Object.entries(args)) {
    const schema = spec[1][key];
    if (
      schema.type === "string"
        ? typeof value !== "string" ||
          value.length < schema.minLength ||
          value.length > schema.maxLength ||
          (schema.minLength > 0 && !value.trim()) ||
          (schema.pattern && !new RegExp(schema.pattern).test(value))
        : !Number.isInteger(value) ||
          value < schema.minimum ||
          value > schema.maximum
    )
      throw fail("invalid_arguments", `Invalid ${key}.`);
  }
  if (name === "CreateNotionPage" || name === "AppendNotionPage")
    if (
      Number(Object.hasOwn(args, "markdown")) +
        Number(Object.hasOwn(args, "text")) !==
      1
    )
      throw fail(
        "invalid_arguments",
        "Provide exactly one of markdown or text.",
      );
  return args;
}
function clean(value, secret) {
  if (typeof value === "string")
    return secret ? value.split(secret).join("[redacted]") : value;
  if (Array.isArray(value)) return value.map((v) => clean(v, secret));
  if (record(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, clean(v, secret)]),
    );
  return value;
}
async function boundedJson(response) {
  if (!response.body)
    throw fail("invalid_response", "Notion returned an empty response.");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let size = 0,
    text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw fail("response_too_large", "Notion response exceeded 4 MiB.");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw fail("invalid_response", "Notion returned invalid JSON.");
  }
}
function client(secret, context) {
  const deadline = AbortSignal.timeout(60000),
    signal = context.signal
      ? AbortSignal.any([context.signal, deadline])
      : deadline;
  let requests = 0;
  return async (path, { method = "GET", body, write = false } = {}) => {
    if (++requests > 60)
      throw fail("request_limit", "Notion read request limit reached.");
    let dispatched = false;
    try {
      const requestSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(20000),
      ]);
      dispatched = true;
      const response = await (context.fetch ?? globalThis.fetch)(
        `${API_ROOT}${path}`,
        {
          method,
          redirect: "error",
          signal: requestSignal,
          headers: {
            Authorization: `Bearer ${secret}`,
            "Notion-Version": API_VERSION,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (!response.ok) {
        // Do not expose upstream bodies: errors may echo submitted content or secrets.
        let errorBody;
        try {
          errorBody = await boundedJson(response);
        } catch {}
        const code =
          {
            400: "validation_error",
            401: "needs_authentication",
            403: "access_denied",
            404: "not_found_or_not_shared",
            409: "conflict",
            429: "rate_limited",
          }[response.status] ?? "notion_http_error";
        const extra = { httpStatus: response.status };
        if (errorBody?.committed_resource_id)
          extra.committedResourceId = String(errorBody.committed_resource_id)
            .replace(/[^0-9a-f-]/gi, "")
            .slice(0, 36);
        if (write && (response.status >= 500 || extra.committedResourceId))
          extra.outcome = "unknown";
        throw fail(
          code,
          `Notion request failed (HTTP ${response.status}); check integration access and request limits.`,
          extra,
        );
      }
      const result = await boundedJson(response);
      if (!record(result))
        throw fail("invalid_response", "Notion returned an invalid result.");
      return result;
    } catch (error) {
      if (error.notionToolError === true) {
        if (
          write &&
          dispatched &&
          ["invalid_response", "response_too_large"].includes(error.code)
        )
          error.outcome = "unknown";
        throw error;
      }
      throw fail(
        signal.aborted ? "cancelled" : "connection_failed",
        write && dispatched
          ? "Notion write outcome is unknown. Read the destination before retrying."
          : "Notion request failed or timed out.",
        write && dispatched ? { outcome: "unknown" } : {},
      );
    }
  };
}
const richText = (list) =>
  Array.isArray(list)
    ? list
        .map(
          (item) =>
            item.plain_text ??
            item.text?.content ??
            item.equation?.expression ??
            "",
        )
        .join("")
    : "";
function pageSummary(page) {
  const titleProperty = Object.values(page.properties ?? {}).find(
    (v) => v?.type === "title" || Array.isArray(v?.title),
  );
  return {
    id: page.id,
    title: richText(titleProperty?.title ?? page.title),
    url: page.url ?? null,
    lastEditedTime: page.last_edited_time ?? null,
    archived: Boolean(page.archived || page.in_trash),
    parent: page.parent ?? null,
  };
}
function blockSummary(block, parentId, depth) {
  const data = block[block.type] ?? {};
  let text = richText(data.rich_text ?? data.caption);
  if (block.type === "table_row")
    text = (data.cells ?? []).map(richText).join(" | ");
  if (block.type === "child_page") text = data.title ?? text;
  if (block.type === "equation") text = data.expression ?? text;
  return {
    id: block.id,
    parentBlockId: parentId,
    depth,
    type: block.type,
    hasChildren: Boolean(block.has_children),
    text,
    data,
  };
}
async function readPage(request, args) {
  const page = await request(`/pages/${args.pageId}`),
    blocks = [],
    omitted = [];
  const maxBlocks = args.maxBlocks ?? 500,
    maxDepth = args.maxDepth ?? 5;
  const seen = new Set();
  async function children(id, depth) {
    if (seen.has(id)) {
      omitted.push({ blockId: id, reason: "cycle" });
      return;
    }
    seen.add(id);
    let cursor;
    do {
      if (blocks.length >= maxBlocks) {
        omitted.push({
          blockId: id,
          reason: "max_blocks",
          nextCursor: cursor ?? null,
        });
        return;
      }
      const params = new URLSearchParams({
        page_size: String(Math.min(100, maxBlocks - blocks.length)),
      });
      if (cursor) params.set("start_cursor", cursor);
      let result;
      try {
        result = await request(`/blocks/${id}/children?${params}`);
      } catch (error) {
        omitted.push({
          blockId: id,
          reason: error.code ?? "read_failed",
          nextCursor: cursor ?? null,
        });
        return;
      }
      if (!Array.isArray(result.results)) {
        omitted.push({ blockId: id, reason: "invalid_response" });
        return;
      }
      const next = [];
      for (const block of result.results) {
        if (blocks.length >= maxBlocks) {
          omitted.push({ blockId: id, reason: "max_blocks" });
          break;
        }
        blocks.push(blockSummary(block, id, depth));
        if (block.has_children) next.push(block.id);
      }
      for (const childId of next)
        if (depth >= maxDepth)
          omitted.push({ blockId: childId, reason: "max_depth" });
        else await children(childId, depth + 1);
      if (!result.has_more) return;
      if (
        typeof result.next_cursor !== "string" ||
        !result.next_cursor ||
        result.next_cursor === cursor
      ) {
        omitted.push({ blockId: id, reason: "invalid_cursor" });
        return;
      }
      cursor = result.next_cursor;
    } while (true);
  }
  await children(args.pageId, 0);
  return {
    ok: true,
    page: pageSummary(page),
    blocks,
    truncated: omitted.length > 0,
    omitted,
    blockCount: blocks.length,
  };
}
function textBlocks(text) {
  const parts = [];
  for (let i = 0; i < text.length; i += 2000)
    parts.push(text.slice(i, i + 2000));
  return parts.map((content) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content } }] },
  }));
}
export async function executeNotionTool(name, args = {}, context = {}) {
  const secret = token();
  try {
    args = validate(name, args);
    const write = name === "CreateNotionPage" || name === "AppendNotionPage";
    if (write && context.allowWrite !== true)
      return {
        ok: false,
        status: "requires_confirmation",
        message:
          "Explicit user approval for this Notion destination and content is required. No write was sent.",
      };
    if (!secret)
      return {
        ok: false,
        status: "needs_configuration",
        message:
          "Set NOTION_API_KEY or NOTION_TOKEN on the local server and share the intended pages with that integration.",
      };
    const request = client(secret, context);
    if (name === "ReadNotionPage")
      return clean(await readPage(request, args), secret);
    if (name === "SearchNotion") {
      const pages = [],
        limit = args.limit ?? 100;
      let cursor;
      do {
        const result = await request("/search", {
          method: "POST",
          body: {
            query: args.query ?? "",
            filter: { property: "object", value: "page" },
            sort: { direction: "descending", timestamp: "last_edited_time" },
            page_size: Math.min(100, limit - pages.length),
            ...(cursor ? { start_cursor: cursor } : {}),
          },
        });
        if (!Array.isArray(result.results))
          throw fail("invalid_response", "Notion search results are invalid.");
        pages.push(
          ...result.results.slice(0, limit - pages.length).map(pageSummary),
        );
        if (!result.has_more)
          return clean(
            { ok: true, pages, truncated: false, nextCursor: null },
            secret,
          );
        if (
          typeof result.next_cursor !== "string" ||
          !result.next_cursor ||
          result.next_cursor === cursor
        )
          throw fail("invalid_response", "Notion pagination did not advance.");
        cursor = result.next_cursor;
      } while (pages.length < limit);
      return clean(
        { ok: true, pages, truncated: true, nextCursor: cursor },
        secret,
      );
    }
    let pageId = args.pageId,
      result;
    if (name === "CreateNotionPage") {
      result = await request("/pages", {
        method: "POST",
        write: true,
        body: {
          parent: { type: "page_id", page_id: args.parentPageId },
          properties: {
            title: {
              type: "title",
              title: [{ type: "text", text: { content: args.title } }],
            },
          },
          ...(args.markdown !== undefined
            ? { markdown: args.markdown }
            : { children: textBlocks(args.text) }),
        },
      });
      if (typeof result.id !== "string")
        throw fail("invalid_response", "Notion create returned no page ID.", {
          outcome: "unknown",
        });
      pageId = result.id;
    } else if (args.markdown !== undefined) {
      result = await request(`/pages/${pageId}/markdown`, {
        method: "PATCH",
        write: true,
        body: {
          type: "insert_content",
          insert_content: { content: args.markdown, position: { type: "end" } },
        },
      });
    } else {
      result = await request(`/blocks/${pageId}/children`, {
        method: "PATCH",
        write: true,
        body: { children: textBlocks(args.text) },
      });
    }
    // Verify through a fresh GET; never retry a write automatically after uncertain outcomes.
    try {
      const readback = await readPage(request, {
        pageId,
        maxBlocks: 1000,
        maxDepth: 8,
      });
      return clean(
        {
          ok: true,
          status: "written",
          page: readback.page,
          verified: !readback.truncated,
          readbackTruncated: readback.truncated,
          readback,
          ...(result.warnings ? { warnings: result.warnings } : {}),
        },
        secret,
      );
    } catch (error) {
      return clean(
        {
          ok: true,
          status: "written",
          pageId,
          verified: false,
          readbackStatus: error.code ?? "read_failed",
          message:
            "Notion accepted the write, but its readback could not be completed. Do not repeat the write blindly.",
        },
        secret,
      );
    }
  } catch (error) {
    return clean(
      {
        ok: false,
        status: error.code ?? "notion_error",
        message: error.code ? error.message : "Notion operation failed.",
        ...(error.outcome ? { outcome: error.outcome } : {}),
        ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
        ...(error.committedResourceId
          ? { committedResourceId: error.committedResourceId }
          : {}),
      },
      secret,
    );
  }
}

export { validate as validateNotionArguments };
