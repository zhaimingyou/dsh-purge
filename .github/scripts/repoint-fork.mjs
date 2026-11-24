#!/usr/bin/env node
// 把你的 fork 接成「自己的更新/发行通道」：把运行时里的上游仓库常量换成你的 fork。
//
//   node tools/repoint-fork.mjs --repo zhaimingyou/dsh-purge            # 只预览
//   node tools/repoint-fork.mjs --repo zhaimingyou/dsh-purge --write    # 落盘
//
// 改的面：lib/（REPOSITORY、SOURCE_REPO、update 里的 URL 拼装）、scripts/、bin/、
// .github/workflows/、test/（断言跟着换，否则测试失败）、package.json 的 repository /
// dsh.install.tarball / bugs。docs/、market/、packages/purge-panel/src 不动：
// 文档留上游署名，面板源码里的外链等你改 UI 时一起处理。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const UPSTREAM = "kingcharleslzy-ai/dsh-purge";
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const repoSlug = flag("repo");
const write = args.includes("--write");
const repoDir = path.resolve(flag("repo-dir", process.env.GITHUB_WORKSPACE || path.join(import.meta.dirname, "..", "..")));

if (!repoSlug || !/^[\w.-]+\/[\w.-]+$/.test(repoSlug)) {
  console.error("用法: node tools/repoint-fork.mjs --repo <owner>/<name> [--write] [--repo-dir PATH]");
  process.exit(2);
}
if (repoSlug.toLowerCase() === UPSTREAM) {
  console.error("这是上游自己的坐标，换一个 fork 再跑。");
  process.exit(2);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "docs", "market", "screenshots"]);
const TARGET_EXT = new Set([".js", ".mjs", ".cjs", ".yml", ".yaml", ".json", ".sh", ".ps1"]);
// 面板源码不在这里改：它的产物 client.js 由 npm run build:client 重新生成。
const SKIP_PATHS = new Set([
  // client.js 是 src/ 编出来的产物（npm run check:client 会比对），手改会让构建失配。
  "client.js",
  "packages/purge-panel/src",
  "packages/purge-panel/client.js",
  "packages/purge-panel/test",
  // 文档一致性检查跟着 README 走；README 保留上游署名与官方下载地址，所以这里不改。
  "scripts/check-docs.mjs",
]);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(repoDir, abs).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if ([...SKIP_PATHS].some((p) => rel === p || rel.startsWith(p + "/"))) continue;
      yield* walk(abs);
    } else if (TARGET_EXT.has(path.extname(entry.name))) {
      if (SKIP_PATHS.has(rel)) continue;
      yield rel;
    }
  }
}

const touched = [];
for (const rel of walk(repoDir)) {
  if (rel === "package-lock.json" || rel.endsWith("package-lock.json")) continue;
  const abs = path.join(repoDir, rel);
  const text = fs.readFileSync(abs, "utf8");
  if (!text.includes(UPSTREAM)) continue;
  const count = text.split(UPSTREAM).length - 1;
  touched.push({ rel, count });
  if (write) fs.writeFileSync(abs, text.split(UPSTREAM).join(repoSlug));
}

const total = touched.reduce((n, f) => n + f.count, 0);
console.log(`${write ? "已改写" : "将改写"} ${touched.length} 个文件 / ${total} 处：`);
for (const f of touched) console.log(`  ${String(f.count).padStart(3)}  ${f.rel}`);
if (!write) {
  console.log("\n预览模式。加 --write 落盘，然后：");
  console.log("  cd dsh-purge && npm run check:docs && npm test");
  process.exit(0);
}

// 旧版浮动安装地址的识别：不用一刀切成自己的坐标，否则老用户 profile 里的
// ".../releases/latest/download/dsh-purge-community.tgz" 就认不出来、升级不会迁移。
// 放宽成"上游或本 fork 都算"，历史夹具和真实旧安装都能走通。
const [owner, name] = repoSlug.split("/");
const communityPath = path.join(repoDir, "lib/community.js");
const communityText = fs.readFileSync(communityPath, "utf8");
// 源码里的形式是转义正则片段：kingcharleslzy-ai\/dsh-purge
const escapedUpstream = "kingcharleslzy-ai\\/dsh-purge";
const escapedWide = `(?:kingcharleslzy-ai|${owner})\\/${name}`;
if (communityText.includes(escapedUpstream)) {
  fs.writeFileSync(communityPath, communityText.split(escapedUpstream).join(escapedWide));
  console.log("✓ lib/community.js 旧安装地址识别已放宽（上游 / 本 fork 均匹配）");
}

// 测试里还常写成转义正则（/kingcharleslzy-ai\/dsh-purge/），明文替换抓不到。
const escaped = "kingcharleslzy-ai\\/dsh-purge";
const testDir = path.join(repoDir, "test");
if (fs.existsSync(testDir)) {
  for (const name of fs.readdirSync(testDir)) {
    if (!name.endsWith(".mjs")) continue;
    const abs = path.join(testDir, name);
    const text = fs.readFileSync(abs, "utf8");
    if (!text.includes(escaped)) continue;
    fs.writeFileSync(abs, text.split(escaped).join(repoSlug.replace("/", "\\/")));
    console.log(`✓ test/${name} 转义正则同步`);
  }
}

// 顺带核对：fork 的 workflow 守卫、运行时常量、清单里的 tarball 都指向新坐标。
const checks = [
  ["lib/community.js", `export const REPOSITORY = "${repoSlug}";`],
  ["lib/update-net.js", `export const SOURCE_REPO = "${repoSlug}";`],
  [".github/workflows/release.yml", `github.repository == '${repoSlug}'`],
];
for (const [rel, needle] of checks) {
  const text = fs.readFileSync(path.join(repoDir, rel), "utf8");
  console.log(`${text.includes(needle) ? "✓" : "✗"} ${rel}`);
}
try {
  if (!fs.existsSync(path.join(repoDir, ".git"))) throw new Error("not a git checkout");
  const stat = execFileSync("git", ["-C", repoDir, "diff", "--stat"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  console.log("\n" + stat);
} catch {
  /* 不在 git 里就跳过 diff 统计 */
}
