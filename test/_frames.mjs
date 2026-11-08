// 临时视觉诊断工具：把翻页动画按 timeScale 拉长后逐帧截图，供人工目视评估笔触质感。
// 用法：node test/_frames.mjs [前缀]  → docs/screenshots/_diag/<前缀>-<ms>.png
import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 4191;
const BASE = `http://localhost:${PORT}/`;
const TAG = process.argv[2] || 'frame';
const SCALE = 10;
const MARKS = [200, 700, 1400, 2400, 3200, 4200, 5200, 6600];
const server = spawn(process.execPath, ['test/serve.mjs'], {
  env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50; i++) {
  const ok = await new Promise((resolve) => {
    http.get(BASE + 'flip-preview.html', (res) => { res.resume(); resolve(res.statusCode === 200); })
      .on('error', () => resolve(false));
  });
  if (ok) break;
  await sleep(100);
}
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 2 });
await page.goto(BASE + 'flip-preview.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(450);
const outDir = path.join('docs', 'screenshots', '_diag');
fs.mkdirSync(outDir, { recursive: true });

await page.evaluate(async (scale) => {
  const { playInkFlip } = await import('/www/js/inkflip.js');
  const vp = document.getElementById('viewport');
  const pg = document.getElementById('page');
  window.__flipStart = performance.now();
  window.__flipP = playInkFlip({
    viewport: vp, page: pg, dir: 'next', timeScale: scale,
    mutate: () => { window.__mutatedAt = performance.now() - window.__flipStart; },
  });
}, SCALE);

const reader = await page.$('#reader');
const box = await reader.boundingBox();
const clip = { x: box.x, y: box.y, width: box.width, height: box.height };
let prev = 0;
for (const m of MARKS) {
  await sleep(m - prev);
  prev = m;
  await page.screenshot({ path: path.join(outDir, `${TAG}-${m}.png`), clip, captureBeyondViewport: false });
}
await sleep(400);
console.log('mutatedAt =', await page.evaluate(() => window.__mutatedAt));
await browser.close();
server.kill();
console.log('frames:', MARKS.map((m) => `${outDir}/${TAG}-${m}.png`).join('\n'));
