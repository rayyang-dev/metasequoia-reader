// 从模拟器抽屉截图裁剪图标并放大，生成「系统图标 / 相机 / 红杉阅读」并排对比图
// 用法: node scripts/crop_compare.mjs
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

function crc32(buf){let c=~0;for(let i=0;i<buf.length;i++){c^=buf[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c;}
function readPNG(p){
  const buf=fs.readFileSync(p);
  let off=8,width,height,colorType,idat=[],plte=null,trns=null;
  while(off<buf.length){
    const len=buf.readUInt32BE(off), type=buf.toString('ascii',off+4,off+8);
    const data=buf.subarray(off+8,off+8+len);
    if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);colorType=data[9];}
    else if(type==='IDAT')idat.push(data);
    else if(type==='PLTE')plte=data;
    else if(type==='tRNS')trns=data;
    else if(type==='IEND')break;
    off+=12+len;
  }
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const ch=colorType===6?4:colorType===2?3:colorType===4?2:1;
  const stride=width*ch, out=Buffer.alloc(height*stride);
  let pos=0;
  for(let y=0;y<height;y++){
    const ft=raw[pos++];
    for(let x=0;x<stride;x++){
      const rb=raw[pos++], a=x>=ch?out[y*stride+x-ch]:0, b=y>0?out[(y-1)*stride+x]:0,
            c=(x>=ch&&y>0)?out[(y-1)*stride+x-ch]:0;
      let v;
      switch(ft){case 0:v=rb;break;case 1:v=rb+a;break;case 2:v=rb+b;break;case 3:v=rb+((a+b)>>1);break;
        case 4:{const pp=a+b-c,pa=Math.abs(pp-a),pb=Math.abs(pp-b),pc=Math.abs(pp-c);v=rb+(pa<=pb&&pa<=pc?a:pb<=pc?b:c);break;}
        default:v=rb;}
      out[y*stride+x]=v&0xff;
    }
  }
  const rgba=Buffer.alloc(width*height*4);
  for(let i=0;i<width*height;i++){
    let r,g,b,al=255;
    if(colorType===6){r=out[i*4];g=out[i*4+1];b=out[i*4+2];al=out[i*4+3];}
    else if(colorType===2){r=out[i*3];g=out[i*3+1];b=out[i*3+2];}
    else if(colorType===3){const idx=out[i];r=plte[idx*3];g=plte[idx*3+1];b=plte[idx*3+2];if(trns&&idx<trns.length)al=trns[idx];}
    else if(colorType===0){r=g=b=out[i];}
    else if(colorType===4){r=g=b=out[i*2];al=out[i*2+1];}
    rgba[i*4]=r;rgba[i*4+1]=g;rgba[i*4+2]=b;rgba[i*4+3]=al;
  }
  return {width,height,rgba};
}
function writePNG(p,{width,height,rgba}){
  const stride=width*4, raw=Buffer.alloc(height*(stride+1));
  let pos=0;
  for(let y=0;y<height;y++){raw[pos++]=0;for(let x=0;x<stride;x++)raw[pos++]=rgba[y*stride+x];}
  const comp=zlib.deflateSync(raw);
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type,'ascii');
    const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data]))>>>0);return Buffer.concat([len,t,data,crc]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
  fs.writeFileSync(p,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',comp),chunk('IEND',Buffer.alloc(0))]));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.resolve(HERE,'../screenshots');
// 用法: node scripts/crop_compare.mjs [源截图文件名] [输出后缀]
const SRC = path.join(OUTDIR, process.argv[2] || 'launcher_drawer_now.png');
const SUF = process.argv[3] || '';
const {width,height,rgba} = readPNG(SRC);

// 截图为 1080x2340；以下为实际像素坐标（图标本体，不含文字标签）
const BOXES = [
  { name:'calendar', x:63,  y:305, w:124, h:124 },   // 第一行第一列：系统白底图标
  { name:'camera',   x:270, y:305, w:124, h:124 },   // 第一行第二列：相机（用户参照）
  { name:'sequoia',  x:477, y:965, w:124, h:124 },   // 第三行第三列：红杉阅读（红色像素 bbox 实测）
];
const SCALE = 4, GAP = 36, PAD = 40;
const cell = BOXES[0].w*SCALE;
const W = PAD*2 + cell*3 + GAP*2, H = PAD*2 + cell;
const canvas = Buffer.alloc(W*H*4);
for(let i=0;i<W*H;i++){ canvas[i*4]=238; canvas[i*4+1]=238; canvas[i*4+2]=240; canvas[i*4+3]=255; } // 浅灰底，贴近抽屉背景

function paste(box, slot){
  const ox = PAD + slot*(cell+GAP), oy = PAD;
  for(let y=0;y<box.h;y++)for(let x=0;x<box.w;x++){
    const si=((box.y+y)*width+(box.x+x))*4;
    const r=rgba[si],g=rgba[si+1],b=rgba[si+2],a=rgba[si+3];
    for(let dy=0;dy<SCALE;dy++)for(let dx=0;dx<SCALE;dx++){
      const di=((oy+y*SCALE+dy)*W+(ox+x*SCALE+dx))*4;
      // 源像素多半不透明，直接覆盖即可（含半透明时做简单混合）
      if(a===255){canvas[di]=r;canvas[di+1]=g;canvas[di+2]=b;canvas[di+3]=255;}
      else {const t=a/255;canvas[di]=Math.round(r*t+canvas[di]*(1-t));canvas[di+1]=Math.round(g*t+canvas[di+1]*(1-t));
            canvas[di+2]=Math.round(b*t+canvas[di+2]*(1-t));canvas[di+3]=255;}
    }
  }
  // 单独输出该图标的 4x 大图
  const one=Buffer.alloc(cell*cell*4);
  for(let y=0;y<cell;y++)for(let x=0;x<cell;x++){
    const si=(y*W+(ox+x))*4, di=(y*cell+x)*4;
    one[di]=canvas[si];one[di+1]=canvas[si+1];one[di+2]=canvas[si+2];one[di+3]=255;
  }
  writePNG(path.join(OUTDIR,`icon_${box.name}_4x${SUF}.png`),{width:cell,height:cell,rgba:one});
}
BOXES.forEach((b,i)=>paste(b,i));
writePNG(path.join(OUTDIR,`launcher_compare${SUF}.png`),{width:W,height:H,rgba:canvas});
console.log(`source ${width}x${height} (${path.basename(SRC)}) -> compare ${W}x${H}`);
console.log(`outputs: screenshots/launcher_compare${SUF}.png, screenshots/icon_{calendar,camera,sequoia}_4x${SUF}.png`);
