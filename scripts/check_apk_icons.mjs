import { execSync } from 'child_process';
import fs from 'fs';
import zlib from 'zlib';
import os from 'os';
import path from 'path';

function crc32(buf){let c=~0;for(let i=0;i<buf.length;i++){c^=buf[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c;}
function readPNG(p){
  const buf=fs.readFileSync(p);
  let off=8,width,height,bitDepth,colorType,idat=[],plte=null,trns=null;
  while(off<buf.length){
    const len=buf.readUInt32BE(off); const type=buf.toString('ascii',off+4,off+8);
    const data=buf.subarray(off+8,off+8+len);
    if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);bitDepth=data[8];colorType=data[9];}
    else if(type==='IDAT'){idat.push(data);}
    else if(type==='PLTE'){plte=data;}
    else if(type==='tRNS'){trns=data;}
    else if(type==='IEND'){break;}
    off+=12+len;
  }
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const ch = colorType===6?4:colorType===4?2:colorType===2?3:colorType===3?1:colorType===0?1:3;
  const stride=width*ch;
  const out=Buffer.alloc(height*stride);
  let pos=0;
  for(let y=0;y<height;y++){
    const ft=raw[pos++];
    for(let x=0;x<stride;x++){
      const rb=raw[pos++];
      const a=x>=ch?out[y*stride+x-ch]:0;
      const b=y>0?out[(y-1)*stride+x]:0;
      const c=(x>=ch&&y>0)?out[(y-1)*stride+x-ch]:0;
      let v;
      switch(ft){case 0:v=rb;break;case 1:v=rb+a;break;case 2:v=rb+b;break;case 3:v=rb+((a+b)>>1);break;
        case 4:{const pp=a+b-c;const pa=Math.abs(pp-a),pb=Math.abs(pp-b),pc=Math.abs(pp-c);const pr=pa<=pb&&pa<=pc?a:pb<=pc?b:c;v=rb+pr;break;}
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
    else if(colorType===0){const v=out[i];r=g=b=v;}
    else if(colorType===4){const v=out[i*2];al=out[i*2+1];r=g=b=v;}
    rgba[i*4]=r;rgba[i*4+1]=g;rgba[i*4+2]=b;rgba[i*4+3]=al;
  }
  return {width,height,rgba};
}

const apk=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'apkchk-'));
execSync(`unzip -o -q "${apk}" "res/*.png" -d "${tmp}"`,{stdio:'ignore'});
const files=[];
(function walk(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);const s=fs.statSync(p);if(s.isDirectory())walk(p);else if(p.endsWith('.png'))files.push(p);}})(tmp);
console.log(`APK: ${apk}\nmipmap png entries: ${files.length}\n`);
console.log('file'.padEnd(28),'size'.padEnd(10),'opaque%'.padEnd(8),'red%'.padEnd(7),'transpCorners');
let launcherOk=true, launcherCount=0;
for(const f of files){
  try{
    const {width,height,rgba}=readPNG(f);
    let opaque=0,red=0,corner=0;
    const cs=[[0,0],[width-1,0],[0,height-1],[width-1,height-1]];
    for(const [x,y] of cs){const i=(y*width+x)*4;if(rgba[i+3]<10)corner++;}
    for(let i=0;i<width*height;i++){const o=i*4;if(rgba[o+3]>=128){opaque++;const r=rgba[o],g=rgba[o+1],b=rgba[o+2];if(r>120&&g<90&&b<90&&Math.abs(r-g)>60)red++;}}
    const op=(opaque/(width*height)*100).toFixed(0);
    const rd=(red/(width*height)*100).toFixed(0);
    const name=path.basename(f);
    // only report likely launcher square candidates: full-bleed opaque red squares
    if(op==='100' && Number(rd)>=60){
      console.log(name.padEnd(28),(`${width}x${height}`).padEnd(10),op.padEnd(8),rd.padEnd(7),String(corner));
      launcherCount++;
      if(corner!==0) launcherOk=false;
    }
  }catch(e){/* ignore non-png */}
}
console.log(`\nFull-bleed red-square candidates found: ${launcherCount}`);
console.log('LAUNCHER ICON FULL-BLEED (opaque100 & 0 transparent corners):', launcherOk && launcherCount>0 ? 'YES ✅' : 'NO ❌');
fs.rmSync(tmp,{recursive:true,force:true});
