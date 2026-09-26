// Structural delivery checks; visual/privacy approval is recorded separately after actual inspection.
import { readFile, writeFile, readdir, mkdir, copyFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),output=join(root,'.cache','promo','output')
for(const name of ['captions.zh-CN.srt','copy.zh-CN.md','storyboard.json'])await copyFile(join(root,'marketing',name),join(output,name))
await copyFile(join(root,'marketing','assets','SOURCES.md'),join(output,'SOURCES.md'))
await copyFile(join(root,'marketing','assets','licenses','NotoSansSC-OFL.txt'),join(output,'FONT-LICENSE.txt'))
const images=JSON.parse(await readFile(join(output,'images.json'),'utf8'))
const videos=JSON.parse(await readFile(join(output,'videos.json'),'utf8'))
const capture=JSON.parse(await readFile(join(root,'.cache','promo','capture.json'),'utf8'))
const failures=[]
for(const file of [...images.files,...videos.files]){
  const name=file.name??file.file,bytes=await readFile(join(output,name))
  if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)failures.push(`Hash mismatch: ${name}`)
  if(name.endsWith('.png')&&(bytes.readUInt32BE(16)!==file.width||bytes.readUInt32BE(20)!==file.height))failures.push(`Image dimensions differ: ${name}`)
}
if(images.files.filter(f=>/^0[1-6]-/.test(f.name)&&f.width===1080&&f.height===1440).length!==6)failures.push('Expected six 1080x1440 cards')
for(const name of ['cover-1920x1080.png','share-1280x640.png'])if(!images.files.some(f=>f.name===name))failures.push(`Missing ${name}`)
if(videos.files.length!==2||videos.files.some(v=>v.codec!=='h264'||Math.abs(v.durationSeconds-60)>.08||v.audioStreams!==0||!v.burnedSubtitles))failures.push('Expected two silent 60-second H.264 MP4s with burned-in subtitles')
const captions=await readFile(join(output,'captions.zh-CN.srt'),'utf8')
if((captions.match(/ --> /g)??[]).length!==8||!captions.includes('00:01:00,000'))failures.push('Caption timeline is incomplete')
const files=(await readdir(output)).filter(name=>!name.startsWith('video-')&&!['images.json','videos.json','validation.json','SHA256SUMS.txt'].includes(name))
const sums=[];for(const name of files){const bytes=await readFile(join(output,name));sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`)}
await writeFile(join(output,'SHA256SUMS.txt'),sums.join('\n')+'\n')
const result={version:'1.0.0',checkedAt:new Date().toISOString(),structuralStatus:failures.length?'failed':'passed',failures,sourceVerification:capture.verification,images:images.files.filter(f=>!f.name.startsWith('video-')),videos:videos.files,manualReview:'pending: inspect every image and watch both videos; do not equate structural checks with visual/privacy acceptance.',files}
await writeFile(join(output,'validation.json'),JSON.stringify(result,null,2))
// Only final public deliverables go into the release ZIP. Do not package raw profile paths or layout intermediates.
const delivery=join(root,'.cache','promo','delivery');await mkdir(delivery,{recursive:true})
const publicFiles=[...images.files.filter(f=>!f.name.startsWith('video-')).map(f=>f.name),...videos.files.map(f=>f.file),'captions.zh-CN.srt','copy.zh-CN.md','storyboard.json','SOURCES.md','FONT-LICENSE.txt','SHA256SUMS.txt','validation.json']
for(const name of publicFiles)await copyFile(join(output,name),join(delivery,name))
await writeFile(join(delivery,'README.md'),'# 模型圆桌 1.0.0 宣传素材\n\n- 01—06：六张竖版图卡，1080×1440。\n- cover：横版封面，1920×1080。\n- share：分享图，1280×640。\n- 两个 MP4：60 秒横版与竖版，无配音、无音乐，中文字幕已绘入画面。\n- copy.zh-CN.md：三种长度的文案、标题、视频简介、置顶评论和 FAQ。\n- captions.zh-CN.srt：可编辑字幕；storyboard.json：分镜。\n\n画面来自正式 1.0.0 应用与隔离演示项目。响应为本机受控演示数据，index.html 写入、差异、审阅流程和网页按钮验证实际发生；等待已剪辑。不是模型性能测试。完整第三方声明见项目仓库。发布文案请等正式 Release 可匿名下载后使用。\n\n源码及下载：https://github.com/baibaiyizi/model-roundtable\n')
console.log(JSON.stringify(result,null,2));if(failures.length)process.exitCode=1
