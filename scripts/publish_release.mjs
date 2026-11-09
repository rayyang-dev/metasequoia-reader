// 发布 GitHub Release（不落盘任何凭据）
// PAT 从本机 git credential store 动态读取（Windows 凭据管理器里的 x-access-token），只在内存使用，绝不回显。
// 用法: node scripts/publish_release.mjs <tag> <releaseName> <apkWindowsPath> <bodyFilePath>
import fs from 'fs';
import { execFileSync } from 'child_process';

const [TAG, NAME, APK, BODY_FILE] = process.argv.slice(2);
if (!TAG || !NAME || !APK || !BODY_FILE) {
  console.error('用法: node scripts/publish_release.mjs <tag> <name> <apkPath> <bodyFile>');
  process.exit(1);
}
const REPO = 'rayyang-dev/sequoia-reader';
const ASSET_NAME = `Metasequoia-${TAG}-release.apk`;

function getPAT() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\nusername=x-access-token\n\n',
    encoding: 'utf8',
  });
  const m = /^password=(.+)$/m.exec(out);
  if (!m) throw new Error('未能从凭据管理器取得 PAT（git credential fill 未返回 password）');
  return m[1].trim();
}

const TOKEN = getPAT(); // 不打印、不写文件
const BASE = 'https://api.github.com';
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'ink-reader-publish',
};

async function req(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...HEADERS, ...(opts.headers || {}) } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === 'object' && data ? (data.message || JSON.stringify(data)) : String(data);
    throw new Error(`HTTP ${res.status} ${url}\n${msg}`);
  }
  return data;
}

// 1) 校验凭据与仓库权限（只打印登录名，不打印 token）
const me = await req(`${BASE}/user`);
console.log(`凭据有效，当前账号: ${me.login}`);
const repo = await req(`${BASE}/repos/${REPO}`);
console.log(`目标仓库: ${repo.full_name} (default_branch=${repo.default_branch})`);

// 2) 若该 tag 的 Release 已存在则直接报错，避免重复发布
try {
  const existing = await req(`${BASE}/repos/${REPO}/releases/tags/${TAG}`);
  if (existing && existing.id) {
    console.error(`Release ${TAG} 已存在 (id=${existing.id})，请先手动删除或换 tag。`);
    process.exit(2);
  }
} catch (e) {
  if (!String(e.message).includes('HTTP 404')) throw e;
  console.log(`tag ${TAG} 尚无 Release，继续创建。`);
}

// 3) 创建 Release（tag 不存在时 GitHub 会基于 target_commitish 自动创建）
const body = fs.readFileSync(BODY_FILE, 'utf8');
const release = await req(`${BASE}/repos/${REPO}/releases`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tag_name: TAG,
    target_commitish: repo.default_branch,
    name: NAME,
    body,
    draft: false,
    prerelease: false,
  }),
});
console.log(`Release 已创建: ${release.html_url} (id=${release.id})`);

// 4) 上传 APK 资产
const apkBuf = fs.readFileSync(APK);
console.log(`上传资产 ${ASSET_NAME} (${apkBuf.length} bytes) ...`);
const upload = await req(
  `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(ASSET_NAME)}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.android.package-archive' },
    body: apkBuf,
  }
);
console.log(`资产已上传: ${upload.browser_download_url}`);
console.log(`\nDONE\nRELEASE_URL=${release.html_url}\nASSET_URL=${upload.browser_download_url}`);
