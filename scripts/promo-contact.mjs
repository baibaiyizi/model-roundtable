// Review sheets are QA artifacts, not additional promotional claims or product screenshots.
import { chromium } from '@playwright/test'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),base=join(root,'.cache','promo'),output=join(base,'output'),review=join(base,'review')
await mkdir(review,{recursive:true})
const ffmpeg=process.env.PROMO_FFMPEG??join(root,'.cache','media','d1be0e64c0fae2e6c2061bd24c6f61e4b4ad9f962d8fd9240731a77a48b06f71','unpacked','ffmpeg-n8.1.3-win64-lgpl-shared-8.1','bin','ffmpeg.exe')
const exec=promisify(execFile),times=[2,8,18,27,33,38,45,52,57]
const images=JSON.parse(await readFile(join(output,'images.json'),'utf8')).files.filter(f=>!f.name.startsWith('video-'))
const uri=async path=>'data:image/png;base64,'+(await readFile(path)).toString('base64')
const sheets=[]
const browser=await chromium.launch({channel:'msedge',headless:true})
try{
  const render=async(name,title,items,cols,itemWidth,itemHeight)=>{
    const width=cols*(itemWidth+24)+48,height=Math.ceil(items.length/cols)*(itemHeight+66)+112
    const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1})
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:#e9ebe2;color:#254a3c;font-family:'Microsoft YaHei',sans-serif}h1{font-size:24px;margin:0 0 24px}main{display:grid;grid-template-columns:repeat(${cols},${itemWidth}px);gap:24px}figure{margin:0}img{display:block;width:${itemWidth}px;height:${itemHeight}px;object-fit:contain;background:#fff;border:1px solid #c3cdbc}figcaption{height:42px;padding-top:8px;font-size:14px}</style><h1>${title}</h1><main>${items.map(i=>`<figure><img src="${i.src}"><figcaption>${i.label}</figcaption></figure>`).join('')}</main>`)
    await page.locator('img').evaluateAll(nodes=>Promise.all(nodes.map(n=>n.decode())))
    const path=join(review,name);await page.screenshot({path});await page.close()
    const bytes=await readFile(path);sheets.push({name,width,height,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
  }
  const cards=[];for(const img of images)cards.push({label:`${img.name} · ${img.width} × ${img.height}`,src:await uri(join(output,img.name))})
  await render('eight-images.png','模型圆桌 1.0.0 · 八张图片复核',cards,4,360,480)
  for(const orientation of ['horizontal','vertical']){
    const video=join(output,`model-roundtable-1.0.0-${orientation==='horizontal'?'1920x1080':'1080x1920'}.mp4`),frames=[]
    for(const second of times){
      const path=join(review,`${orientation}-${second}.png`)
      await exec(ffmpeg,['-hide_banner','-loglevel','error','-y','-ss',String(second),'-i',video,'-frames:v','1',path],{windowsHide:true,maxBuffer:1024*1024})
      frames.push({label:`${second.toString().padStart(2,'0')} 秒 · ${orientation==='horizontal'?'横版':'竖版'}`,src:await uri(path)})
    }
    await render(`${orientation}-video.png`,`模型圆桌 1.0.0 · ${orientation==='horizontal'?'横版':'竖版'}视频关键分镜`,frames,3,orientation==='horizontal'?600:360,orientation==='horizontal'?338:640)
  }
}finally{await browser.close()}
await writeFile(join(review,'manifest.json'),JSON.stringify({version:'1.0.0',files:sheets,frameTimes:times},null,2))
console.log(JSON.stringify(sheets,null,2))
