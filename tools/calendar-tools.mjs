import { spawn } from "node:child_process";
import { mkdir, stat, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const source = fileURLToPath(
  new URL("./CalendarBridge.swift", import.meta.url),
);
const info = fileURLToPath(
  new URL("./CalendarBridge.Info.plist", import.meta.url),
);
const binDir = fileURLToPath(new URL("../data/bin/", import.meta.url));
const binary = fileURLToPath(
  new URL("../data/bin/CalendarBridge", import.meta.url),
);
const string = (maxLength, minLength = 1) => ({
  type: "string",
  minLength,
  maxLength,
});
const dates = { start: string(80), end: string(80), timeZone: string(100) };
const specs = {
  ListCalendars: [
    "List calendars accessible through the Mac calendar connection.",
    {},
    [],
  ],
  SearchCalendarEvents: [
    "Read calendar events within an explicit ISO 8601 date range with timezone offsets. Optionally filter by calendar or text.",
    {
      ...dates,
      calendarId: string(500),
      query: string(500),
      limit: { type: "integer", minimum: 1, maximum: 500 },
    },
    ["start", "end"],
  ],
  CreateCalendarEvent: [
    "Create an event after explicit user approval. Checks duplicates and overlapping events first; conflicts require separate confirmation. Calendar update/deletion are not supported.",
    {
      ...dates,
      calendarId: string(500),
      title: string(1000),
      notes: string(16000),
      location: string(2000),
      allDay: { type: "boolean" },
    },
    ["calendarId", "title", "start", "end"],
  ],
};
export const calendarTools = Object.entries(specs).map(
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
const fail = (code, message) =>
  Object.assign(new Error(message), { code, calendarToolError: true });
let compilation;
function run(command, args, { input, signal, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let output = "",
      size = 0,
      settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(fail("cancelled", "Calendar operation was cancelled."));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(fail("timeout", "Calendar operation timed out."));
    }, timeout);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(
          fail(
            "response_too_large",
            "Calendar response exceeded the size limit.",
          ),
        );
      } else output += chunk.toString("utf8");
    });
    // Never expose diagnostics that could contain event data or host paths.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () =>
      finish(
        fail("bridge_unavailable", "Could not start the calendar helper."),
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? finish(null, output)
        : finish(
            fail("bridge_failed", "The calendar helper did not complete."),
          ),
    );
    child.stdin.end(input ?? "");
  });
}
async function ensureBinary() {
  if (process.platform !== "darwin")
    throw fail("unsupported_platform", "Mac calendar access requires macOS.");
  if (compilation) return compilation;
  compilation = (async () => {
    const [s, i, b] = await Promise.all([
      stat(source),
      stat(info),
      stat(binary).catch(() => null),
    ]);
    if (b && b.mtimeMs >= Math.max(s.mtimeMs, i.mtimeMs)) return;
    await mkdir(binDir, { recursive: true, mode: 0o700 });
    await run(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-parse-as-library",
        "-O",
        "-target",
        `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
        source,
        "-o",
        binary,
        "-framework",
        "EventKit",
        "-Xlinker",
        "-sectcreate",
        "-Xlinker",
        "__TEXT",
        "-Xlinker",
        "__info_plist",
        "-Xlinker",
        info,
      ],
      { timeout: 120000 },
    );
    await chmod(binary, 0o700);
  })();
  try {
    await compilation;
  } catch (error) {
    compilation = null;
    throw error;
  }
}
async function bridge(input, { signal, timeout } = {}) {
  await ensureBinary();
  const text = await run(binary, [], {
    input: JSON.stringify(input),
    signal,
    timeout,
  });
  try {
    return JSON.parse(text);
  } catch {
    throw fail("invalid_response", "Calendar helper returned invalid JSON.");
  }
}
function errorResult(error, write = false) {
  return {
    ok: false,
    status: error.calendarToolError ? error.code : "calendar_error",
    message: error.calendarToolError
      ? error.message
      : "Calendar operation failed.",
    ...(write &&
    ["cancelled", "timeout", "bridge_failed", "invalid_response"].includes(
      error.code,
    )
      ? { outcome: "unknown", readBeforeRetry: true }
      : {}),
  };
}
export async function calendarConnectionStatus() {
  try {
    return await bridge({ operation: "status" });
  } catch (error) {
    return { ...errorResult(error), configured: false };
  }
}
// Call exclusively from an explicit user-click connection route, never from model tools.
export async function authorizeCalendar({ signal } = {}) {
  try {
    return await bridge(
      { operation: "authorize", userInitiated: true },
      { signal, timeout: 120000 },
    );
  } catch (error) {
    return errorResult(error);
  }
}
export async function executeCalendarTool(name, args = {}, context = {}) {
  let writing = false;
  try {
    const spec = specs[name];
    if (!spec)
      throw fail(
        "unsupported",
        "Unsupported calendar tool. Update and deletion are not implemented.",
      );
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        throw fail("invalid_arguments", "Arguments must be valid JSON.");
      }
    }
    if (
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      Object.keys(args).some((k) => !Object.hasOwn(spec[1], k)) ||
      spec[2].some((k) => !Object.hasOwn(args, k))
    )
      throw fail(
        "invalid_arguments",
        "Missing or unsupported calendar arguments.",
      );
    for (const [k, v] of Object.entries(args)) {
      const s = spec[1][k];
      if (
        s.type === "string"
          ? typeof v !== "string" || !v.trim() || v.length > s.maxLength
          : s.type === "boolean"
            ? typeof v !== "boolean"
            : !Number.isInteger(v) || v < s.minimum || v > s.maximum
      )
        throw fail("invalid_arguments", `Invalid ${k}.`);
    }
    writing = name === "CreateCalendarEvent";
    if (writing && context.allowWrite !== true)
      return {
        ok: false,
        status: "requires_confirmation",
        message:
          "Confirm the destination calendar and event details before creating it. No event was created.",
      };
    if (
      args.start &&
      (!/(Z|[+-]\d\d:\d\d)$/.test(args.start) ||
        !/(Z|[+-]\d\d:\d\d)$/.test(args.end) ||
        !Number.isFinite(Date.parse(args.start)) ||
        !Number.isFinite(Date.parse(args.end)) ||
        Date.parse(args.end) <= Date.parse(args.start) ||
        Date.parse(args.end) - Date.parse(args.start) > 366 * 86400000)
    )
      throw fail(
        "invalid_arguments",
        "Use a positive ISO date range with timezone offsets, at most 366 days.",
      );
    if (args.timeZone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: args.timeZone });
      } catch {
        throw fail("invalid_arguments", "Invalid timeZone.");
      }
    }
    return await bridge(
      {
        ...args,
        timeZone: args.timeZone ?? "Asia/Shanghai",
        operation: {
          ListCalendars: "listCalendars",
          SearchCalendarEvents: "listEvents",
          CreateCalendarEvent: "createEvent",
        }[name],
        ...(writing
          ? {
              allowWrite: true,
              allowConflicts: context.allowConflicts === true,
            }
          : {}),
      },
      { signal: context.signal },
    );
  } catch (error) {
    return errorResult(error, writing);
  }
}
