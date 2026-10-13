import fs from "node:fs/promises";
import path from "node:path";
import * as prettier from "prettier";
const root = path.resolve(import.meta.dirname, "..");
const original = path.join(root, "extracted/dist/renderer");
const output = path.join(root, "app");
await fs.cp(original, output, { recursive: true });
const files = await fs.readdir(path.join(output, "assets"));
const report = { formatted: [], preserved: [], failed: [] };
for (const file of files) {
  const target = path.join(output, "assets", file);
  if (!/\.(js|mjs|css)$/.test(file)) {
    report.preserved.push(file);
    continue;
  }
  try {
    const text = await fs.readFile(target, "utf8");
    const formatted = await prettier.format(text, {
      filepath: file,
      printWidth: 100,
    });
    await fs.writeFile(target, formatted);
    report.formatted.push(file);
  } catch (error) {
    report.failed.push({ file, error: error.message });
  }
}
await fs.writeFile(
  path.join(root, "evidence/readable-build.json"),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify({
    formatted: report.formatted.length,
    preserved: report.preserved.length,
    failed: report.failed.length,
  }),
);
