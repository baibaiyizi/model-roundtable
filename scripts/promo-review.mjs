// Decode both finished videos in a browser from start to end. Visual acceptance remains an explicit review step.
import { chromium } from '@playwright/test'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),base=join(root,'.cache','promo'),output=join(base,'output')
const videos=JSON.parse(await readFile(join(output,'videos.json'),'utf8'))
const path=join(base,'playback-review.html')
await writeFile(path,'<!doctype html><meta charset="utf-8"><title>本地视频播放检查</title><style>body{margin:0;background:#f5f3e9}video{display:block;width:100vw;height:100vh;object-fit:contain}</style><video muted playsinline controls></video>')
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--autoplay-policy=no-user-gesture-required']})
const results=[]
try{
  await Promise.all(videos.files.map(async file=>{
    const page=await browser.newPage({viewport:{width:960,height:960}})
    await page.goto(pathToFileURL(path).href)
    const result=await page.evaluate(async src=>{
      const v=document.querySelector('video');v.src=src
      return await new Promise((accept,reject)=>{
        let frames=0;const timeout=setTimeout(()=>reject(Error('Playback did not finish within 100 seconds')),100000)
        const onFrame=()=>{frames++;if(!v.ended)v.requestVideoFrameCallback(onFrame)};v.requestVideoFrameCallback(onFrame)
        v.addEventListener('error',()=>{clearTimeout(timeout);reject(Error(v.error?.message??'Video decode error'))},{once:true})
        v.addEventListener('ended',()=>{clearTimeout(timeout);accept({ended:v.ended,currentTime:v.currentTime,duration:v.duration,width:v.videoWidth,height:v.videoHeight,presentedFrames:frames,decodeError:v.error?.message??null})},{once:true})
        v.play().catch(reject)
      })
    },pathToFileURL(join(output,file.file)).href)
    results.push({file:file.file,...result});await page.close();console.log(`Playback ended: ${file.file}`)
  }))
}finally{await browser.close()}
if(results.some(r=>!r.ended||r.decodeError||r.presentedFrames<100||Math.abs(r.duration-60)>.08))throw Error('Full browser playback failed')
const validation=JSON.parse(await readFile(join(output,'validation.json'),'utf8'))
validation.browserPlayback=results
if(process.argv.includes('--approve-visual'))validation.manualReview={status:'passed',method:'逐张检查六张图卡、横封面与分享图；按分镜与转场抽帧检查两版视频的文字、裁剪和脱敏。两版均由浏览器连续播放至 ended，无解码错误。',privacy:'隔离演示项目与受控服务；未展示真实账号、密钥、订阅、私人对话或用户目录。',limitations:'没有做社交平台上传测试；平台可能再次压缩、裁剪或限制外链。'}
await writeFile(join(output,'validation.json'),JSON.stringify(validation,null,2));await writeFile(join(base,'delivery','validation.json'),JSON.stringify(validation,null,2))
const delivery=join(base,'delivery'),sums=[]
for(const name of (await readdir(delivery)).filter(n=>n!=='SHA256SUMS.txt').sort())sums.push(`${createHash('sha256').update(await readFile(join(delivery,name))).digest('hex')}  ${name}`)
await writeFile(join(delivery,'SHA256SUMS.txt'),sums.join('\n')+'\n')
console.log(JSON.stringify(results,null,2))
