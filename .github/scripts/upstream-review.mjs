#!/usr/bin/env node
// 上游更新体检：算出「这次更新动了什么」并给出跟/审/停的建议。
// 不是 diff 阅读器，是把 diff 变成一份能 3 分钟读完的风险清单。
//
//   node tools/review-upstream.mjs                          # upstream 上一个 tag → upstream/master
//   node tools/review-upstream.mjs --from v1.7.19 --to v1.7.20
//   node tools/review-upstream.mjs --from v1.7.11 --to v1.7.20 --json
//
// 只看它自己的仓库（默认 --repo-dir ../dsh-purge），不联网、不写宿主、不装包。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const json = args.includes("--json");
const jsonOut = opt("json-out", "");
const mdOut = opt("markdown-out", "");
const repoDir = path.resolve(opt("repo-dir", process.env.GITHUB_WORKSPACE || path.join(import.meta.dirname, "..", "..")));
const git = (...a) =>
  execFileSync("git", a, { cwd: repoDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();

const tagList = (extra = []) =>
  git("tag", "--sort=-v:refname", ...extra).split("\n").filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
const upstreamRef = opt("upstream-ref", "upstream/master");
const upstreamTags = tagList(["--merged", upstreamRef]);
const from = opt("from", `v${JSON.parse(git("show", "HEAD:package.json")).version}`);
const to = opt("to", upstreamTags[0] || upstreamRef);

const files = git("diff", "--name-status", from, to).split("\n").filter(Boolean).map((line) => {
  const [status, ...rest] = line.split("\t");
  return { status: status[0], file: rest[rest.length - 1] };
});
const touched = new Set(files.map((f) => f.file));

// ---- 1) 补丁表：按 id 对账 ----
const PATCH_FILES = ["prompt", "code", "engine", "new-tools", "opt-in", "stability"].map((n) => `lib/patches/${n}.mjs`);
function patchTable(ref) {
  const out = new Map();
  for (const rel of PATCH_FILES) {
    let text;
    try {
      text = execFileSync("git", ["show", `${ref}:${rel}`], { cwd: repoDir, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      continue;
    }
    // 有的补丁表用工厂函数生成（如 stability.mjs 的 treeBudgetPatch(96, ...)），
    // 没有字面量 id；此时按「函数名(数字,」兜底，name 用函数名代替。
    let hits = [...text.matchAll(/\bid:\s*(\d+),/g)];
    let factory = false;
    if (!hits.length) {
      hits = [...text.matchAll(/\b([A-Za-z_$][\w$]*)\((\d+),/g)];
      factory = true;
    }
    hits.forEach((hit, i) => {
      const start = hit.index;
      const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
      const chunk = text.slice(start, end);
      const id = Number(hit[1]);
      // name 通常在 id 之后；少见的写法在其前面 400 字符内。
      const name = factory
        ? `${hit[1]}()`
        : /name:\s*"([^"]+)"/.exec(chunk)?.[1] || /name:\s*"([^"]+)"[^]*?$/.exec(text.slice(Math.max(0, start - 400), start))?.[1] || "";
      const layer = /layer:\s*"([^"]+)"/.exec(chunk)?.[1] || "";
      const permission = /permissionOverride:\s*true/.test(chunk);
      const body = chunk.replace(/\s+/g, " ").trim();
      out.set(id, { id, name, layer, permission, sig: body });
    });
  }
  return out;
}
const a = patchTable(from);
const b = patchTable(to);
const added = [...b.keys()].filter((id) => !a.has(id)).map((id) => b.get(id));
const removed = [...a.keys()].filter((id) => !b.has(id)).map((id) => a.get(id));
const changed = [...b.keys()].filter((id) => a.has(id) && a.get(id).sig !== b.get(id).sig).map((id) => b.get(id));

// ---- 2) 危险面：新增行里的网络 / 进程 / 删除 / 权限 ----
function addedLines(paths) {
  if (!paths.length) return [];
  const diff = execFileSync("git", ["diff", "--unified=0", from, to, "--", ...paths], {
    cwd: repoDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
  });
  return diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
}
const RISK = {
  network: /fetch\(|https?:\/\/|requestUpdate|net\.connect|tls\.|dns\.|proxy/i,
  process: /spawn\(|execFile|execSync|child_process|\bexec\(/,
  delete: /rmSync|rm\(|unlink|rmdir|renameSync|\bchmod\(/,
  permission: /danger-full-access|approval|permissionOverride|sandbox|allow file-write/,
  prompt: /prompt-inject|boost|section\(|personaPrefix|injectPosition/,
};
const RUNTIME = /^(lib|bin|scripts|packages\/[^/]+\/src)\//;
const runtimeFiles = [...touched].filter((f) => RUNTIME.test(f));
const buckets = Object.fromEntries(Object.keys(RISK).map((k) => [k, []]));
for (const line of addedLines(runtimeFiles)) {
  for (const [k, re] of Object.entries(RISK)) if (re.test(line)) buckets[k].push(line.trim());
}
const KNOWN_HOSTS = new Set(["github.com", "api.github.com", "raw.githubusercontent.com", "codeload.github.com", "objects.githubusercontent.com", "registry.npmjs.org", "npmjs.com", "pnpm.io", "gh-proxy.org", "deepseek.com"]);
const knownHost = (h) =>
  KNOWN_HOSTS.has(h) || h.endsWith(".github.io") || h.endsWith(".githubusercontent.com") || h.endsWith(".deepseek.com") || h.endsWith(".npmjs.org");
const hosts = [...new Set(
  addedLines(runtimeFiles).flatMap((l) => [...l.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase())),
)].filter((h) => !knownHost(h));

// ---- 3) 清单声明 / 提示词 / 面板 / 测试 ----
const pkgAt = (ref) => { try { return JSON.parse(git("show", `${ref}:package.json`)); } catch { return {}; } };
const pkgA = pkgAt(from), pkgB = pkgAt(to);
const surface = {
  version: [pkgA.version, pkgB.version],
  hostRange: [pkgA.dsh?.compatibility?.dsh, pkgB.dsh?.compatibility?.dsh],
  promptDefaultChanged: touched.has("lib/default-prompt-inject.md"),
  panelChanged: [...touched].some((f) => f.startsWith("packages/purge-panel/src/")),
  panelBundleChanged: touched.has("client.js"),
  presetsChanged: [...touched].some((f) => f.startsWith("presets/")),
  skillsTouched: [...touched].filter((f) => f.startsWith("skills/")),
  testsTouched: [...touched].filter((f) => f.startsWith("test/")).length,
  docsTouched: [...touched].filter((f) => f.startsWith("docs/") || f.endsWith(".md")).length,
};

// ---- 4) 结论 ----
const blockers = [];
if (hosts.length) blockers.push(`新增外部域名：${hosts.join(", ")}`);
if (buckets.process.length) blockers.push(`新增进程执行点 ${buckets.process.length} 处`);
if (buckets.delete.length) blockers.push(`新增删除/改权限操作 ${buckets.delete.length} 处`);
if (changed.some((p) => p.permission)) blockers.push(`权限类补丁内容变动：${changed.filter((p) => p.permission).map((p) => `#${p.id} ${p.name}`).join("、")}`);
const needsRead = [];
if (added.length) needsRead.push(`新增补丁 ${added.length} 条`);
if (removed.length) needsRead.push(`移除补丁 ${removed.length} 条`);
if (changed.length) needsRead.push(`改动补丁 ${changed.length} 条`);
if (surface.hostRange[0] !== surface.hostRange[1]) needsRead.push(`宿主兼容范围变化：${surface.hostRange[0]} → ${surface.hostRange[1]}`);
const semver = (ref) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(ref || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmpRef = (x, y) => {
  const a2 = semver(x), b2 = semver(y);
  if (!a2 || !b2) return 0;
  for (let i = 0; i < 3; i++) if (a2[i] !== b2[i]) return a2[i] - b2[i];
  return 0;
};
const upstreamNewer = cmpRef(to, from) > 0;
const verdict = !upstreamNewer && semver(to) && semver(from)
  ? "无需动作：上游没有比当前版本更新的 tag"
  : blockers.length ? "停：人工读完再动" : needsRead.length ? "审：读补丁表与提示词层，跑测试后可跟" : "跟：基本是文档/测试变化";

const report = {
  from, to, verdict, upstreamNewer,
  files: { total: files.length, added: files.filter((f) => f.status === "A").length, removed: files.filter((f) => f.status === "D").length },
  patches: { added, removed, changed },
  risk: {
    unknownHosts: hosts,
    process: buckets.process.slice(0, 10),
    delete: buckets.delete.slice(0, 10),
    permission: buckets.permission.slice(0, 10),
    prompt: buckets.prompt.slice(0, 10),
  },
  surface,
  blockers, needsRead,
};

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2) + "\n");
if (json) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
const md = [];
md.push(`### 上游体检 ${from} → ${to}`, "", `**结论：${verdict}**`, "",
  `- 文件：${report.files.total} 个变动（新增 ${report.files.added}、删除 ${report.files.removed}）`,
  `- 补丁表：新增 ${added.length} / 移除 ${removed.length} / 改动 ${changed.length}`,
  `- 提示词层：默认注入正文${surface.promptDefaultChanged ? "有变" : "未变"} · 预设${surface.presetsChanged ? "有变" : "未变"} · 技能 ${surface.skillsTouched.length} 个变动`,
  `- 面板：源码${surface.panelChanged ? "有变" : "未变"} / bundle${surface.panelBundleChanged ? "有变" : "未变"} · 测试 ${surface.testsTouched} 个文件 · 文档 ${surface.docsTouched} 个`,
  `- 宿主兼容：${surface.hostRange[0] || "?"} → ${surface.hostRange[1] || "?"}`);
if (added.length || removed.length || changed.length) {
  md.push("", "| 变动 | 补丁 |", "| --- | --- |");
  for (const p2 of added) md.push(`| 新增 | #${p2.id} ${p2.name}${p2.permission ? "（权限类）" : ""} |`);
  for (const p2 of removed) md.push(`| 移除 | #${p2.id} ${p2.name} |`);
  for (const p2 of changed) md.push(`| 改动 | #${p2.id} ${p2.name}${p2.permission ? "（权限类）" : ""} |`);
}
if (blockers.length) md.push("", "**必须人工读**：", ...blockers.map((b) => `- ${b}`));
if (needsRead.length) md.push("", "**需要过一眼**：", ...needsRead.map((b) => `- ${b}`));
md.push("", `> 注：补丁计数来自源码文本解析，动态拼装的不计；用途是看变化趋势。`);
const markdown = md.join("\n");
if (mdOut) fs.writeFileSync(mdOut, markdown + "\n");

const line = (s = "") => console.log(s);
line(`上游体检 ${from} → ${to}`);
line(`结论：${verdict}`);
line("");
line(`文件：${report.files.total} 个变动（新增 ${report.files.added}、删除 ${report.files.removed}）`);
line(`补丁表：新增 ${added.length} / 移除 ${removed.length} / 改动 ${changed.length}（目标版本 ${b.size} 条 / 起始 ${a.size} 条）`);
for (const p of added) line(`  + #${p.id} ${p.name}${p.permission ? "（权限类）" : ""}`);
for (const p of removed) line(`  - #${p.id} ${p.name}`);
for (const p of changed) line(`  ~ #${p.id} ${p.name}${p.permission ? "（权限类）" : ""}`);
line("");
line(`提示词层：默认注入正文${surface.promptDefaultChanged ? "有变" : "未变"} · 预设${surface.presetsChanged ? "有变" : "未变"} · 技能 ${surface.skillsTouched.length} 个变动`);
line(`面板：源码${surface.panelChanged ? "有变" : "未变"} / bundle${surface.panelBundleChanged ? "有变" : "未变"} · 测试 ${surface.testsTouched} 个文件 · 文档 ${surface.docsTouched} 个`);
line(`宿主兼容：${surface.hostRange[0] || "?"} → ${surface.hostRange[1] || "?"}`);
if (hosts.length) line(`⚠ 新增外部域名：${hosts.join(", ")}`);
if (buckets.process.length) line(`⚠ 新增进程执行 ${buckets.process.length} 处，例：${buckets.process[0].slice(0, 100)}`);
if (buckets.delete.length) line(`⚠ 新增删除/改权限 ${buckets.delete.length} 处，例：${buckets.delete[0].slice(0, 100)}`);
line("");
if (blockers.length) { line("必须人工读："); blockers.forEach((b) => line(`  · ${b}`)); }
if (needsRead.length) { line("需要过一眼："); needsRead.forEach((b) => line(`  · ${b}`)); }
line("");
line(markdown);
line("");
line("注：补丁计数来自源码文本解析（字面量 id 与 helper(96, …) 工厂调用都算），动态拼装的补丁不计；用途是看变化趋势，不是精确普查。");
line("下一步：npm run check:docs && npm run check:client && npm test → 在副本里 apply + selfcheck → 再决定要不要进你的发行通道。");
process.exitCode = verdict.startsWith("停") ? 4 : verdict.startsWith("审") ? 3 : 0;
