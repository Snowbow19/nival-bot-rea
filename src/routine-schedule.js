export function scheduleFromSpec(spec) {
  const source = spec.schedule ?? spec.trigger?.schedule;
  if (
    spec.trigger?.type &&
    !["schedule", "cron", "once"].includes(spec.trigger.type)
  )
    throw new Error("暂不支持此触发方式，请选择定时运行。");
  if (typeof source !== "string") throw new Error("请填写运行时间。");
  const cron = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(source.trim());
  if (cron && +cron[1] < 60 && +cron[2] < 24)
    return {
      type: "daily",
      time: `${cron[2].padStart(2, "0")}:${cron[1].padStart(2, "0")}`,
      timeZone: spec.timeZone ?? "Asia/Shanghai",
    };
  const interval = /^every (\d+) minutes$/i.exec(source.trim());
  if (interval && +interval[1] >= 1 && +interval[1] <= 525600)
    return { type: "interval", minutes: +interval[1] };
  if (
    /^\d{4}-\d\d-\d\dT/.test(source) &&
    /(Z|[+-]\d\d:\d\d)$/.test(source) &&
    Date.parse(source) > Date.now()
  )
    return { type: "once", at: new Date(source).toISOString() };
  throw new Error(
    "当前支持一次性、每天固定时间和间隔运行；也可以直接在聊天中描述运行时间。",
  );
}
