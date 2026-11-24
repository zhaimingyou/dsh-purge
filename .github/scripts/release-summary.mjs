#!/usr/bin/env node
// 发版摘要：把「这一版到底改了什么」写进 release notes，让人装之前就能看见。
// 只用仓库内数据（git + 源码文本），不需要宿主，所以能在 CI 里跑。
//
//   node .github/scripts/release-summary.mjs --version 1.7.22 --out summary.md [--tests tests.txt]
//
// 输出：补丁普查 + 权限类补丁清单 + 与上一版的补丁增删改 + 注入指纹 + 宿主兼容范围。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d = "") => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const repoDir = path.resolve(opt("repo-dir", process.env.GITHUB_WORKSPACE || path.join(import.meta.dirname, "..", "..")));
const version = opt("version", JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8")).version);
const outFile = opt("out");
const testsFile = opt("tests");
const git = (...a) => execFileSync("git", a, { cwd: repoDir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();

// ---- 补丁表普查 ----
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
      const id = Number(factory ? hit[2] : hit[1]);
      const name = factory ? `${hit[1]}()` : /name:\s*"([^"]+)"/.exec(chunk)?.[1] || "";
      const layer = /layer:\s*"([^"]+)"/.exec(chunk)?.[1] || "";
      const permission = /permissionOverride:\s*true/.test(chunk);
      out.set(id, { id, name, layer, permission, sig: chunk.replace(/\s+/g, " ").trim() });
    });
  }
  return out;
}

// 当前版本优先用真实模块导入（精确）；失败再退回文本解析（近似）。
let census = null;
try {
  const mod = await import(pathToFileURL(path.join(repoDir, "lib/patches/index.mjs")).href);
  const list = mod.ALL_PATCHES;
  const layers = {};
  for (const p of list) layers[p.layer || "?"] = (layers[p.layer || "?"] || 0) + 1;
  census = {
    total: list.length,
    optional: list.filter((p) => p.optional).length,
    byLayer: layers,
    permissionIds: list.filter((p) => p.permissionOverride).map((p) => p.id).sort((a, b) => a - b),
  };
} catch (e) {
  console.error("（模块导入失败，退回文本解析）", e.message);
}

const current = patchTable("HEAD");
const byLayer = census ? census.byLayer : (() => {
  const o = {};
  for (const p of current.values()) o[p.layer || "?"] = (o[p.layer || "?"] || 0) + 1;
  return o;
})();
const permissionIds = census ? census.permissionIds : [...current.values()].filter((p) => p.permission).map((p) => p.id).sort((a, b) => a - b);

// ---- 与上一版对比 ----
const vOf = (ref) => (/^v(\d+)\.(\d+)\.(\d+)$/.exec(ref) || []).slice(1).map(Number);
const tags = git("tag", "--sort=-v:refname").split("\n").filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
const cur = vOf(`v${version}`);
const prev = tags.find((t) => {
  const v = vOf(t);
  if (v.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== cur[i]) return v[i] < cur[i];
  return false;
});
let delta = null;
if (prev) {
  const before = patchTable(prev);
  delta = {
    prev,
    added: [...current.keys()].filter((id) => !before.has(id)).map((id) => current.get(id)),
    removed: [...before.keys()].filter((id) => !current.has(id)).map((id) => before.get(id)),
    changed: [...current.keys()].filter((id) => before.has(id) && before.get(id).sig !== current.get(id).sig).map((id) => current.get(id)),
    files: git("diff", "--name-only", prev, "HEAD").split("\n").filter(Boolean),
  };
}

// ---- 注入指纹 / 兼容范围 ----
const fingerprint = (rel) => {
  try {
    return createHash("sha256").update(fs.readFileSync(path.join(repoDir, rel))).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
};
const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8"));
const assetNow = fingerprint("lib/asset-table.js");
const assetPrev = prev ? (() => {
  try {
    return createHash("sha256").update(execFileSync("git", ["show", `${prev}:lib/asset-table.js`], { cwd: repoDir, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
})() : null;
const testsLine = testsFile && fs.existsSync(testsFile)
  ? (fs.readFileSync(testsFile, "utf8").match(/^ℹ (tests|pass|fail) \d+$/gm) || []).join(" · ").replace(/ℹ /g, "")
  : "";

const L = [];
L.push("## 本版摘要（自动生成，装之前先看这段）", "");
L.push(`- **补丁**：${census ? census.total : current.size} 条（optional ${census ? census.optional : countOptional()}）；${Object.entries(byLayer).map(([k, n]) => `${k} ${n}`).join(" / ")}`);
L.push(`- **权限类补丁**：${permissionIds.length} 条（${permissionIds.map((i) => `#${i}`).join(" ")}）——改这类等于改审批/沙箱放行，逐字读`);
if (delta) {
  L.push(`- **相对 ${delta.prev}**：补丁新增 ${delta.added.length} / 移除 ${delta.removed.length} / 改动 ${delta.changed.length}；文件变动 ${delta.files.length} 个`);
  const rows = [
    ...delta.added.map((p) => `| 新增 | #${p.id} | ${p.name} |${p.permission ? " 权限类" : ""} |`),
    ...delta.removed.map((p) => `| 移除 | #${p.id} | ${p.name} | |`),
    ...delta.changed.map((p) => `| 改动 | #${p.id} | ${p.name} |${p.permission ? " 权限类" : ""} |`),
  ];
  if (rows.length) L.push("", "| 变动 | 补丁 | 名称 | 备注 |", "| --- | --- | --- | --- |", ...rows);
} else {
  L.push("- **相对上一版**：没有更早的 tag，跳过对比");
}
L.push(`- **注入正文指纹**：\`${assetNow || "缺失"}\`${assetPrev ? (assetNow === assetPrev ? "（与上一版相同）" : `（上一版 ${assetPrev}，**有变**）`) : ""}`);
L.push(`- **宿主兼容**：\`${pkg.dsh?.compatibility?.dsh || "?"}\``);
if (testsLine) L.push(`- **测试**：${testsLine}（CI，ubuntu）`);
L.push("", "> 本地验收（`selfcheck` + 探针）必须在装了插件的机器上跑：`./tools/dev-loop.sh accept`。摘要只证明仓库变了什么，不证明你的宿主加载成功。");

function countOptional() {
  let n = 0;
  for (const rel of PATCH_FILES) {
    let text;
    try {
      text = fs.readFileSync(path.join(repoDir, rel), "utf8");
    } catch {
      continue;
    }
    n += (text.match(/optional:\s*true/g) || []).length;
  }
  return n;
}

const md = L.join("\n");
if (outFile) fs.writeFileSync(outFile, md + "\n");
console.log(md);
