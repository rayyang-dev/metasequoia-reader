// 红杉 Sequoia —— PDF 浏览冒烟测试（puppeteer-core + 系统 Chrome）
// 用途：逐本导入用户提供的 PDF，验证 ① 导入成功 ② 阅读器打开 ③ 首页渲染为图片（非“渲染失败”）④ 翻一页后仍渲染。
// 运行：node test/pdf-smoke.mjs
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('www');
const MIME = {
  '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json',
  '.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp',
  '.woff2':'font/woff2','.wasm':'application/wasm','.ico':'image/x-icon'
};
const server = http.createServer((req,res)=>{ let p=decodeURIComponent(req.url.split('?')[0]); if(p==='/favicon.ico'){res.writeHead(204);res.end();return;} if(p==='/')p='/index.html'; const fp=path.join(ROOT,p); if(!fp.startsWith(ROOT)||!fs.existsSync(fp)){res.writeHead(404);res.end('nf');return;} res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'application/octet-stream'}); fs.createReadStream(fp).pipe(res); });
await new Promise(r=>server.listen(0,r));
const port=server.address().port; const BASE=`http://localhost:${port}/`;

const PDFS = [
  'C:/Users/杨睿/Desktop/036  购买时间：资本主义民主国家如何拖延危机.pdf',
  'C:/Users/杨睿/Desktop/020  海洋帝国：地中海大决战 地中海史诗三部曲之二.pdf',
  'C:/Users/杨睿/Desktop/031  财富之城 威尼斯海洋霸权 地中海史诗三部曲之三.pdf',
  'C:/Users/杨睿/Desktop/019  1453：君士坦丁堡之战 地中海史诗三部曲之一.pdf',
  'C:/Users/杨睿/Desktop/030  俄国与拿破仑的决战：鏖战欧罗巴1807-1814.pdf',
  'C:/Users/杨睿/Desktop/027  天国之秋.pdf',
  'C:/Users/杨睿/Desktop/088  冰雪王国  美国军舰珍妮特号的极地远征.pdf',
];

const browser=await puppeteer.launch({executablePath:(process.env.INK_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'),headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage();
await page.setViewport({width:412,height:892});
const errors=[]; const dialogs=[];
page.on('console',(m)=>{ if(m.type()==='error'){ const t=m.text(); const loc=m.location(); const u=(loc&&loc.url)||''; if(/favicon\.ico/i.test(u)||/favicon/i.test(t))return; errors.push('CONSOLE: '+t);} });
page.on('pageerror',(e)=>errors.push('PAGEERROR: '+(e&&e.message?e.message:e)));
page.on('dialog',async d=>{ dialogs.push(d.message()); try{await d.dismiss();}catch(e){} });
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));

// 打开一本 PDF 并验证渲染：返回 { ok, reason, imgW, failText }
async function testOne(pdfPath, idx){
  const res={ file: path.basename(pdfPath), ok:false };
  try{
    const before=await page.evaluate(()=>document.querySelectorAll('#shelf .book-card').length);
    const input=await page.$('#file-pdf');
    if(!input) throw new Error('#file-pdf 不存在');
    await input.uploadFile(pdfPath);
    // 等待书架新增一本书
    await page.waitForFunction((b)=>document.querySelectorAll('#shelf .book-card').length>b, {timeout:30000}, before).catch(()=>{});
    const after=await page.evaluate(()=>document.querySelectorAll('#shelf .book-card').length);
    if(after<=before) throw new Error('导入后书架未新增（解析/导入失败）');
    // 点击最新的一本
    await page.evaluate(()=>{ const c=document.querySelectorAll('#shelf .book-card'); c[c.length-1].click(); });
    await page.waitForFunction(()=>{ const r=document.querySelector('#reader'); return !!r && !r.classList.contains('hidden'); }, {timeout:15000}).catch(()=>{});
    const open=await page.evaluate(()=>{ const r=document.querySelector('#reader'); return !!r && !r.classList.contains('hidden'); });
    if(!open) throw new Error('阅读器未打开');
    // 等待首页渲染（img.data 或 渲染失败文本）
    await page.waitForFunction(()=>{ const img=document.querySelector('#page .pdfpage img'); const fail=/渲染失败/.test(document.querySelector('#page').innerText||''); return (img&&/^data:/.test(img.getAttribute('src')||''))||fail; }, {timeout:30000}).catch(()=>{});
    const s1=await page.evaluate(()=>{ const img=document.querySelector('#page .pdfpage img'); const fail=/渲染失败/.test((document.querySelector('#page').innerText||'')); return { imgSrc: img?(img.getAttribute('src')||'').slice(0,30):null, natW: img?img.naturalWidth:0, fail }; });
    if(s1.fail) throw new Error('渲染失败：'+ (await page.evaluate(()=>document.querySelector('#page').innerText)).slice(0,80));
    if(!s1.imgSrc||!s1.natW||s1.natW<10) throw new Error('首页未渲染为有效图片（natW='+s1.natW+'）');
    res.page0={ natW:s1.natW };
    // 翻一页（点右侧翻 next）
    await page.evaluate(()=>{ const vp=document.querySelector('#page-viewport'); const r=vp.getBoundingClientRect(); vp.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+r.width*0.85,clientY:r.top+r.height/2})); });
    await wait(800);
    await page.waitForFunction(()=>{ const img=document.querySelector('#page .pdfpage img'); const fail=/渲染失败/.test(document.querySelector('#page').innerText||''); return (img&&/^data:/.test(img.getAttribute('src')||''))||fail; }, {timeout:30000}).catch(()=>{});
    const s2=await page.evaluate(()=>{ const img=document.querySelector('#page .pdfpage img'); const fail=/渲染失败/.test((document.querySelector('#page').innerText||'')); return { natW: img?img.naturalWidth:0, fail }; });
    if(s2.fail) throw new Error('翻页后渲染失败');
    if(!s2.natW||s2.natW<10) throw new Error('翻页后未渲染（natW='+s2.natW+'）');
    res.page1={ natW:s2.natW };
    res.ok=true;
  }catch(e){ res.reason=e.message; }
  return res;
}

const report={ results:[], errors, dialogs };
try{
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:30000});
  await wait(800);
  for(let i=0;i<PDFS.length;i++){
    const r=await testOne(PDFS[i], i);
    report.results.push(r);
    console.log(`[${r.ok?'✅':'❌'}] ${r.file}  ${r.ok?('首页natW='+r.page0.natW+' 翻页natW='+r.page1.natW):('→ '+r.reason)}`);
  }
}catch(e){ report.fatal=e.message; }
const failed=report.results.filter(r=>!r.ok).length;
report.summary={ total:report.results.length, failed, errors:errors.length, dialogs:dialogs.length };
console.log('\n==== PDF 测试汇总 ===='); console.log(JSON.stringify(report.summary,null,2));
if(report.errors.length) console.log('控制台错误:', JSON.stringify(errors,null,2));
if(report.dialogs.length) console.log('弹窗:', JSON.stringify(dialogs,null,2));
await browser.close(); server.close();
process.exit(report.summary.failed===0 && report.summary.errors===0 && report.summary.dialogs===0 && !report.fatal ? 0 : 1);
