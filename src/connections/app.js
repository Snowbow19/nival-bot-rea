const $ = (id) => document.getElementById(id);
async function api(url, body) {
  const r = await fetch(
    url,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "操作未完成，请重试。");
  return data;
}
async function refresh() {
  try {
    const s = await api("/api/connections");
    $("notion-status").textContent = s.notion.configured
      ? s.notion.verified === false
        ? "已授权，等待首次连接"
        : "已连接"
      : "尚未连接";
    $("calendar-status").textContent = s.calendar.configured
      ? "已连接"
      : "需要日历完整访问权限";
    if (s.notion.status === "discovery_failed")
      $("notion-notice").textContent =
        "当前网络无法访问 Notion 官方授权服务。你可以稍后重试，或使用已有集成密钥。";
  } catch {
    $("status").textContent = "暂时无法读取连接状态，请刷新重试。";
  }
}
$("notion-connect").onclick = async () => {
  const button = $("notion-connect");
  button.disabled = true;
  try {
    const r = await api("/api/connections/notion/start", {});
    $("notion-notice").textContent =
      "授权范围以 Notion 页面为准。写入内容仍需单独确认。";
    location.assign(r.authorizeUrl);
  } catch (e) {
    $("notion-notice").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
$("token-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button");
  button.disabled = true;
  try {
    await api("/api/connections/notion/token", {
      token: $("notion-token").value,
    });
    $("notion-token").value = "";
    $("notion-notice").textContent = "连接成功。";
    await refresh();
  } catch (e) {
    $("notion-notice").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
$("calendar-connect").onclick = async () => {
  $("calendar-connect").disabled = true;
  try {
    const result = await api("/api/connections/calendar/authorize", {});
    $("calendar-notice").textContent = result.configured
      ? "日历已连接。"
      : "尚未取得完整访问权限，请在系统设置的隐私与安全性中检查日历权限。";
    await refresh();
  } catch (e) {
    $("calendar-notice").textContent = e.message;
  } finally {
    $("calendar-connect").disabled = false;
  }
};
const labels = {
  pages: "页面",
  parent: "保存到",
  properties: "属性",
  content: "正文",
  page_id: "目标页面",
  parent_page_id: "父页面",
  command: "操作",
  new_str: "正文",
  position: "插入位置",
  allow_async: "后台执行",
  data_source_id: "数据表",
  title: "标题",
  name: "名称",
  start: "开始时间",
  end: "结束时间",
  timeZone: "时区",
  calendarId: "目标日历",
  parentPageId: "父页面",
  pageId: "目标页面",
  markdown: "正文",
  text: "正文",
  notes: "备注",
  location: "地点",
  allDay: "全天",
  connectorId: "应用",
  toolName: "操作",
  arguments: "操作内容",
};
function readable(value, level = 0) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value))
    return value.map((v) => readable(v, level)).join("\n");
  if (typeof value === "object")
    return Object.entries(value)
      .map(
        ([key, v]) =>
          `${labels[key] ?? key}：${typeof v === "object" ? "\n" : ""}${readable(v, level + 1)}`,
      )
      .join("\n\n");
  return String(value);
}
const approvalId = new URLSearchParams(location.search).get("approval");
if (approvalId) {
  $("approval").hidden = false;
  api(`/api/approvals/${encodeURIComponent(approvalId)}`)
    .then((item) => {
      $("approval-target").textContent =
        {
          CreateNotionPage: "在 Notion 创建页面",
          AppendNotionPage: "向 Notion 页面追加内容",
          CreateCalendarEvent: "创建日历日程",
          CallMcpTool: "执行应用操作",
        }[item.name] ?? item.name;
      $("approval-content").textContent = readable(item.args);
      if (item.status !== "pending") {
        $("approve").disabled = true;
        $("reject").disabled = true;
        $("approval-status").textContent = "此操作已处理。";
      }
      if (item.result?.conflicts) {
        $("conflict-control").hidden = false;
        $("approval-content").textContent +=
          "\n\n冲突：\n" + readable(item.result.conflicts);
      }
    })
    .catch((e) => ($("approval-status").textContent = e.message));
  const resolve = async (approve) => {
    $("approve").disabled = true;
    $("reject").disabled = true;
    try {
      const result = await api(
        `/api/approvals/${encodeURIComponent(approvalId)}`,
        { approve, allowConflicts: $("allow-conflicts").checked },
      );
      $("approval-status").textContent =
        result.status === "rejected"
          ? "已取消。"
          : result.ok
            ? "操作已完成。"
            : (result.message ??
              result.error?.message ??
              "操作未完成，请检查授权。");
      if (result.status === "requires_confirmation" && result.conflicts) {
        $("conflict-control").hidden = false;
        $("approval-content").textContent +=
          "\n\n冲突：\n" + readable(result.conflicts);
        $("approve").disabled = false;
      }
    } catch (e) {
      $("approval-status").textContent = e.message;
    }
  };
  $("approve").onclick = () => resolve(true);
  $("reject").onclick = () => resolve(false);
}
refresh();
