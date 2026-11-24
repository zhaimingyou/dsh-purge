#!/usr/bin/env node
// 版本号一键同步：改版本号在 dsh-purge 里要动 8 个地方，漏一个 check:docs 就红。
//
//   node tools/bump-version.mjs 1.7.22            # 落盘并重编面板 bundle
//   node tools/bump-version.mjs --check           # 只校验当前状态（check:docs + check:client）
//
// 做的事：package.json / package-lock.json / release-notes.md 首段 / docs/releases/<v>.md /
// README + README.zh-CN + docs/README.en.md 的版本行与 tgz 链接 / INSTALLATION / MAINTENANCE /
// AGENTS.md 两处。最后跑 `npm run build:client`（bundle 里嵌了 __PANEL_VERSION__）与 check:docs。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const value = args.find((a) => !a.startsWith("--"));
const repoDir = path.resolve(
  (() => {
    const i = args.indexOf("--repo-dir");
    return i >= 0 ? args[i + 1] : process.env.GITHUB_WORKSPACE || path.join(import.meta.dirname, "..", "..");
  })(),
);
const run = (cmd, cmdArgs) =>
  execFileSync(cmd, cmdArgs, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const pkgFile = path.join(repoDir, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
const old = pkg.version;

if (checkOnly) {
  run("npm", ["run", "check:docs"]);
  run("npm", ["run", "check:client"]);
  console.log(`✓ 当前版本 ${old}：文档与面板 bundle 一致`);
  process.exit(0);
}
if (!value || !/^\d+\.\d+\.\d+$/.test(value)) {
  console.error("用法: node tools/bump-version.mjs <x.y.z> [--repo-dir PATH] | --check");
  process.exit(2);
}
if (value === old) {
  console.error(`版本已经是 ${old}`);
  process.exit(2);
}

const replace = (rel, pairs) => {
  const file = path.join(repoDir, rel);
  let text = fs.readFileSync(file, "utf8");
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw Error(`${rel} 里找不到片段：${from.slice(0, 60)}`);
    text = text.split(from).join(to);
  }
  fs.writeFileSync(file, text);
};
const tgzOld = `releases/download/v${old}/dsh-purge-community-${old}.tgz`;
const tgzNew = `releases/download/v${value}/dsh-purge-community-${value}.tgz`;

// 1) 清单
pkg.version = value;
if (pkg.dsh?.install?.tarball) {
  const repo = /github\.com\/([^/]+)\/([^/]+)\/releases/.exec(pkg.dsh.install.tarball);
  if (!repo) throw Error("package.json 的 dsh.install.tarball 形状不认识");
  pkg.dsh.install.tarball = `https://github.com/${repo[1]}/${repo[2]}/releases/download/v${value}/dsh-purge-community-${value}.tgz`;
}
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
const lockFile = path.join(repoDir, "package-lock.json");
if (fs.existsSync(lockFile)) {
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  lock.version = value;
  if (lock.packages?.[""]) lock.packages[""].version = value;
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");
}

// 2) 发行说明：小段置顶 + 本版摘要文件（check-docs 要求 < 8 KiB）
const note = `# ${value}\n\n- 待补：本版变化。\n`;
fs.mkdirSync(path.join(repoDir, "docs/releases"), { recursive: true });
fs.writeFileSync(path.join(repoDir, `docs/releases/${value}.md`), note);
const notesFile = path.join(repoDir, "release-notes.md");
fs.writeFileSync(notesFile, note + "\n" + fs.readFileSync(notesFile, "utf8"));

// 3) 版本行与链接
for (const rel of ["README.md", "README.zh-CN.md"]) {
  replace(rel, [
    [`当前版本 **${old}**`, `当前版本 **${value}**`],
    [tgzOld, tgzNew],
    [`\`dsh-purge-community\` ${old}`, `\`dsh-purge-community\` ${value}`],
  ]);
}
replace("docs/README.en.md", [
  [`Current version ${old}`, `Current version ${value}`],
  [tgzOld, tgzNew],
  [`Plugin \`dsh-purge-community\` ${old}`, `Plugin \`dsh-purge-community\` ${value}`],
]);
for (const rel of ["docs/INSTALLATION.md", "docs/MAINTENANCE.md"]) {
  replace(rel, [[`当前版本 **${old}**`, `当前版本 **${value}**`]]);
}
replace("AGENTS.md", [
  [`当前版本：**${old}**`, `当前版本：**${value}**`],
  [`\`dsh-purge-community\` ${old}`, `\`dsh-purge-community\` ${value}`],
]);

// 4) 面板 bundle 嵌了版本号，必须重编
run("npm", ["run", "build:client"]);
run("npm", ["run", "check:docs"]);
run("npm", ["run", "check:client"]);
console.log(`✓ ${old} → ${value}：文档一致、bundle 重编完成`);
console.log(`  下一步补齐 docs/releases/${value}.md 与 release-notes.md 首段，再跑 npm test`);
