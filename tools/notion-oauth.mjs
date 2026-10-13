import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const RESOURCE = "https://mcp.notion.com/mcp";
const ROOT = "https://mcp.notion.com";
const STORE = fileURLToPath(
  new URL("../data/notion-oauth.json", import.meta.url),
);
const DIR = fileURLToPath(new URL("../data/", import.meta.url));
const HOSTS = new Set([
  "mcp.notion.com",
  "api.notion.com",
  "www.notion.so",
  "notion.so",
  "www.notion.com",
  "notion.com",
]);
const pending = new Map();
const TTL = 10 * 60 * 1000;
let cachedDiscovery = null,
  refreshing = null,
  starting = null;
const notice =
  "Notion MCP 授权页面可能包含读取与编辑权限，无法保证授权本身仅限只读；本应用应默认只启用读取工具，写入需另行开启。";
function error(code, message) {
  return Object.assign(new Error(message), { code });
}
function official(value) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    !HOSTS.has(u.hostname) ||
    u.username ||
    u.password ||
    u.port ||
    u.hash
  )
    throw error(
      "invalid_endpoint",
      "Notion 返回了非官方授权地址，已停止连接。",
    );
  return u.href;
}
function localRedirect(value) {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw error("invalid_redirect", "授权回调必须是本机 HTTP 地址。");
  return u.href;
}
async function request(url, options = {}) {
  const res = await fetch(official(url), {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: { Accept: "application/json", ...options.headers },
  });
  if (!res.ok)
    throw error(
      res.status === 401
        ? "unauthorized"
        : res.status === 403
          ? "access_denied"
          : "oauth_http_error",
      `Notion 授权服务返回 HTTP ${res.status}。`,
    );
  const text = await res.text();
  if (text.length > 256000)
    throw error("invalid_response", "Notion 授权响应超过大小限制。");
  try {
    return JSON.parse(text);
  } catch {
    throw error("invalid_response", "Notion 授权服务没有返回有效 JSON。");
  }
}
async function discover() {
  if (cachedDiscovery && Date.now() - cachedDiscovery.at < 300000)
    return cachedDiscovery;
  let resource;
  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    try {
      resource = await request(ROOT + path);
      break;
    } catch (e) {
      if (e.code === "access_denied") throw e;
    }
  }
  if (!resource)
    throw error("discovery_failed", "无法读取 Notion 受保护资源元数据。");
  if (
    resource.resource &&
    official(resource.resource).replace(/\/$/, "") !== RESOURCE
  )
    throw error("invalid_resource", "Notion 资源标识与预期不一致。");
  if (
    !Array.isArray(resource.authorization_servers) ||
    !resource.authorization_servers.length
  )
    throw error("discovery_failed", "Notion 未提供授权服务器。");
  const issuer = official(resource.authorization_servers[0]);
  const issuerUrl = new URL(issuer);
  const suffix =
    issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/, "");
  const metadata = await request(
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${suffix}`,
  );
  if (
    official(metadata.issuer).replace(/\/$/, "") !== issuer.replace(/\/$/, "")
  )
    throw error("invalid_issuer", "Notion 授权服务器身份不匹配。");
  official(metadata.authorization_endpoint);
  official(metadata.token_endpoint);
  if (metadata.registration_endpoint) official(metadata.registration_endpoint);
  if (
    metadata.code_challenge_methods_supported &&
    !metadata.code_challenge_methods_supported.includes("S256")
  )
    throw error("pkce_unavailable", "Notion 授权服务不支持 S256 PKCE。");
  const offered = resource.scopes_supported ?? metadata.scopes_supported ?? [];
  const scopes = offered.filter((s) =>
    ["read", "read:content", "read_content", "notion:read"].includes(s),
  );
  cachedDiscovery = {
    metadata,
    scopes: scopes.slice(0, 1),
    permissionNotice: scopes.length
      ? "只请求服务提供的读取权限；具体范围以 Notion 授权页面为准。"
      : notice,
    at: Date.now(),
  };
  return cachedDiscovery;
}
async function load() {
  try {
    return JSON.parse(await readFile(STORE, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw error("storage_error", "无法读取本机 Notion 授权配置。");
  }
}
async function save(data) {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  const temp = `${STORE}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
  await rename(temp, STORE);
  await chmod(STORE, 0o600);
}
function envClient() {
  return process.env.NOTION_OAUTH_CLIENT_ID
    ? {
        client_id: process.env.NOTION_OAUTH_CLIENT_ID,
        client_secret: process.env.NOTION_OAUTH_CLIENT_SECRET,
        token_endpoint_auth_method: process.env.NOTION_OAUTH_CLIENT_SECRET
          ? "client_secret_post"
          : "none",
      }
    : null;
}
export async function status() {
  const data = await load();
  if (data.tokens?.access_token)
    return {
      provider: "Notion",
      status:
        data.tokens.expires_at &&
        data.tokens.expires_at <= Date.now() &&
        !data.tokens.refresh_token
          ? "needs_authorization"
          : "connected",
      configured: true,
      expiresAt: data.tokens.expires_at ?? null,
      scope: data.tokens.scope ?? null,
      permissionNotice: data.permissionNotice ?? notice,
      verified: false,
    };
  try {
    const d = await discover();
    return {
      provider: "Notion",
      status:
        d.metadata.registration_endpoint || envClient() || data.client
          ? "not_connected"
          : "needs_credentials",
      configured: false,
      dynamicRegistration: Boolean(d.metadata.registration_endpoint),
      scopes: d.scopes,
      permissionNotice: d.permissionNotice,
    };
  } catch (e) {
    return {
      provider: "Notion",
      status: "discovery_failed",
      configured: false,
      error: e.message,
      code: e.code,
      permissionNotice: notice,
    };
  }
}
export async function start({ redirectUri }) {
  if (starting) return starting;
  starting = (async () => {
    const redirect = localRedirect(redirectUri),
      d = await discover();
    const data = await load();
    let client =
      envClient() ??
      (data.client?.redirect_uri === redirect ? data.client : null);
    if (!client) {
      if (!d.metadata.registration_endpoint)
        throw error(
          "needs_credentials",
          "Notion 当前未开放动态客户端注册，需要配置 NOTION_OAUTH_CLIENT_ID。",
        );
      const registered = await request(d.metadata.registration_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Nival Bot",
          redirect_uris: [redirect],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          ...(d.scopes.length ? { scope: d.scopes.join(" ") } : {}),
        }),
      });
      if (typeof registered.client_id !== "string" || !registered.client_id)
        throw error("invalid_response", "Notion 没有返回客户端标识。");
      client = {
        client_id: registered.client_id,
        client_secret: registered.client_secret,
        token_endpoint_auth_method:
          registered.token_endpoint_auth_method ?? "none",
        redirect_uri: redirect,
      };
      await save({ ...data, client, permissionNotice: d.permissionNotice });
    }
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url");
    for (const [key, item] of pending)
      if (item.expiresAt < Date.now()) pending.delete(key);
    if (pending.size >= 10) pending.delete(pending.keys().next().value);
    pending.set(state, {
      verifier,
      redirect,
      client,
      metadata: d.metadata,
      permissionNotice: d.permissionNotice,
      expiresAt: Date.now() + TTL,
    });
    const url = new URL(d.metadata.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirect,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: RESOURCE,
      prompt: "consent",
      ...(d.scopes.length ? { scope: d.scopes.join(" ") } : {}),
    }))
      url.searchParams.set(key, value);
    return {
      authorizeUrl: url.href,
      expiresIn: 600,
      permissionNotice: d.permissionNotice,
    };
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}
async function exchange(metadata, client, params) {
  const body = new URLSearchParams({
    ...params,
    client_id: client.client_id,
    resource: RESOURCE,
  });
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (client.client_secret) {
    if (client.token_endpoint_auth_method === "client_secret_basic")
      headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString("base64")}`;
    else body.set("client_secret", client.client_secret);
  }
  const token = await request(metadata.token_endpoint, {
    method: "POST",
    headers,
    body: body.toString(),
  });
  if (
    typeof token.access_token !== "string" ||
    !token.access_token ||
    String(token.token_type ?? "bearer").toLowerCase() !== "bearer"
  )
    throw error("invalid_token", "Notion 没有返回有效访问凭据。");
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: "Bearer",
    scope: token.scope,
    expires_at:
      Number.isFinite(Number(token.expires_in)) && Number(token.expires_in) > 0
        ? Date.now() + Number(token.expires_in) * 1000
        : null,
  };
}
export async function finish({ code, state, redirectUri }) {
  const item = pending.get(state);
  if (!item) throw error("invalid_state", "授权请求无效或已使用，请重新连接。");
  pending.delete(state);
  if (
    item.expiresAt < Date.now() ||
    localRedirect(redirectUri) !== item.redirect
  )
    throw error("expired_state", "授权请求已过期或回调不匹配，请重新连接。");
  if (typeof code !== "string" || !code || code.length > 8192)
    throw error("invalid_code", "缺少有效授权码。");
  const tokens = await exchange(item.metadata, item.client, {
    grant_type: "authorization_code",
    code,
    redirect_uri: item.redirect,
    code_verifier: item.verifier,
  });
  await save({
    client: item.client,
    tokens,
    permissionNotice: item.permissionNotice,
  });
  return {
    provider: "Notion",
    status: "connected",
    configured: true,
    scope: tokens.scope ?? null,
    permissionNotice: item.permissionNotice,
  };
}
export async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const data = await load();
    if (!data.tokens?.refresh_token || !data.client)
      throw error("needs_authorization", "Notion 需要重新授权。");
    const d = await discover();
    const tokens = await exchange(d.metadata, data.client, {
      grant_type: "refresh_token",
      refresh_token: data.tokens.refresh_token,
    });
    tokens.refresh_token ??= data.tokens.refresh_token;
    tokens.scope ??= data.tokens.scope;
    await save({ ...data, tokens });
    return tokens.access_token;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}
export async function getAccessToken() {
  const data = await load();
  if (!data.tokens?.access_token)
    throw error("needs_authorization", "请先连接 Notion。");
  if (data.tokens.expires_at && data.tokens.expires_at < Date.now() + 60000)
    return refresh();
  return data.tokens.access_token;
}
