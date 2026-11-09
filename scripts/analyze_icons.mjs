import fs from 'fs';
import zlib from 'zlib';
import path from 'path';

function readPNG(p){
  const buf=fs.readFileSync(p);
  if(buf.readUInt32BE(0)!==0x89504e47) throw new Error('not png '+p);
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
      switch(ft){
        case 0:v=rb;break;
        case 1:v=rb+a;break;
        case 2:v=rb+b;break;
        case 3:v=rb+((a+b)>>1);break;
        case 4:{const pp=a+b-c;const pa=Math.abs(pp-a),pb=Math.abs(pp-b),pc=Math.abs(pp-c);const pr=pa<=pb&&pa<=pc?a:pb<=pc?b:c;v=rb+pr;break;}
        default:v=rb;
      }
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

const RED=[0xa8,0x1f,0x1f];
function analyze(file){
  const {width,height,rgba}=readPNG(file);
  let opaque=0, redish=0;
  let minX=width,minY=height,maxX=0,maxY=0;
  let cornerTransparent=0;
  const cs=[[0,0],[width-1,0],[0,height-1],[width-1,height-1]];
  for(const [cx,cy] of cs){
    const i=(cy*width+cx)*4;
    if(rgba[i+3]<10) cornerTransparent++;
  }
  for(let y=0;y<height;y++){
    for(let x=0;x<width;x++){
      const i=(y*width+x)*4;
      const a=rgba[i+3];
      if(a>=128){opaque++; if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;
        const r=rgba[i],g=rgba[i+1],b=rgba[i+2];
        if(r>120&&g<90&&b<90&&Math.abs(r-g)>60) redish++;
      }
    }
  }
  const total=width*height;
  const opFrac=(opaque/total*100).toFixed(1);
  const redFrac=(redish/total*100).toFixed(1);
  // content bbox as fraction of canvas (detect "logo floating in center")
  const bboxW=((maxX-minX+1)/width*100).toFixed(0);
  const bboxH=((maxY-minY+1)/height*100).toFixed(0);
  return {file:path.basename(file),w:width,h:height,opFrac,redFrac,bboxW,bboxH,cornerTransparent};
}

import { fileURLToPath } from 'url';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../android/app/src/main/res');
const dens=['mdpi','hdpi','xhdpi','xxhdpi','xxxhdpi'];
console.log('file'.padEnd(24),'size'.padEnd(10),'opaque%'.padEnd(8),'red%'.padEnd(7),'bboxW%'.padEnd(7),'bboxH%'.padEnd(7),'transpCorners');
for(const d of dens){
  for(const n of ['ic_launcher.png','ic_launcher_round.png','ic_launcher_foreground.png']){
    const f=path.join(base,`mipmap-${d}`,n);
    if(!fs.existsSync(f)){console.log((d+'/'+n).padEnd(24),'MISSING');continue;}
    const a=analyze(f);
    console.log(a.file.padEnd(24),(`${a.w}x${a.h}`).padEnd(10),a.opFrac.padEnd(8),a.redFrac.padEnd(7),a.bboxW.padEnd(7),a.bboxH.padEnd(7),String(a.cornerTransparent));
  }
}
