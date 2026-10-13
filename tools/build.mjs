import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "dist", "nival-bot");
const temporary = path.join(root, "dist", `nival-bot-build-${process.pid}`);
const includes = [
  "app",
  "src",
  "tools",
  "docs",
  "README.md",
  "THIRD_PARTY.md",
  "package.json",
  "package-lock.json",
  ".env.example",
  "启动 Nival Bot.command",
  "evidence/rea-summary.json",
  "evidence/readable-build.json",
  "evidence/capabilities-verification.json",
];
await fs.access(path.join(root, "app/index.html"));
for (const dir of ["tools", "src", "src/connections"]) {
  for (const entry of await fs.readdir(path.join(root, dir))) {
    if (!/\.(mjs|js)$/.test(entry)) continue;
    const check = spawnSync(
      process.execPath,
      ["--check", path.join(root, dir, entry)],
      { encoding: "utf8" },
    );
    if (check.status !== 0)
      throw new Error(`Syntax check failed: ${dir}/${entry}\n${check.stderr}`);
  }
}
try {
  await fs.mkdir(temporary, { recursive: true });
  for (const item of includes) {
    await fs.mkdir(path.dirname(path.join(temporary, item)), {
      recursive: true,
    });
    await fs.cp(path.join(root, item), path.join(temporary, item), {
      recursive: true,
      filter: (source) =>
        !source
          .split(path.sep)
          .some((p) => [".codegraph", ".DS_Store", "node_modules"].includes(p)),
    });
  }
  await fs.rm(output, { recursive: true, force: true });
  await fs.rename(temporary, output);
  console.log("Built dist/nival-bot (without credentials or workspace data).");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
