// Encode real Electron captures into silent H.264 deliverables. This is a production tool, not an app dependency.
import { readFile, writeFile, mkdir, access, readdir, copyFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
const exec=promisify(execFile)
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),base=join(root,'.cache','promo'),output=join(base,'output'),temp=join(base,'encoded')
await mkdir(temp,{recursive:true})
const fallback=join(root,'.cache','media','d1be0e64c0fae2e6c2061bd24c6f61e4b4ad9f962d8fd9240731a77a48b06f71','unpacked','ffmpeg-n8.1.3-win64-lgpl-shared-8.1','bin','ffmpeg.exe')
const ffmpeg=process.env.PROMO_FFMPEG??fallback, ffprobe=join(dirname(ffmpeg),'ffprobe.exe')
await access(ffmpeg)
const invoke=async args=>{const result=await exec(ffmpeg,['-hide_banner','-loglevel','error','-y',...args],{windowsHide:true,maxBuffer:4*1024*1024,timeout:300000});return result}
const probe=async path=>JSON.parse((await exec(ffprobe,['-v','error','-show_format','-show_streams','-of','json',path],{windowsHide:true})).stdout)
const capture=JSON.parse(await readFile(join(base,'capture.json'),'utf8'))
if(capture.version!=='1.0.0'||capture.verification.state!=='complete')throw Error('Only successful 1.0.0 captures may be published')
const story=JSON.parse(await readFile(join(root,'marketing','storyboard.json'),'utf8'))
const subtitles=await readFile(join(root,'marketing','captions.zh-CN.srt'),'utf8')
const cues=subtitles.trim().split(/\r?\n\r?\n/).map(block=>{const lines=block.split(/\r?\n/);const [start,end]=lines[1].split(' --> ');return{start,end,text:lines.slice(2).join('\\N')}})
const assTime=time=>time.replace(/^0/,'').replace(/,(\d\d)\d$/,'.$1')
const filterPath=path=>path.replaceAll('\\','/').replaceAll(':','\\:').replaceAll("'","\\'")
const docRoot=join(root,'.cache','components-runtime','documents')
let fontDir
for(const folder of (await readdir(docRoot)).sort().reverse()){try{await access(join(docRoot,folder,'fonts','NotoSansSC.ttf'));fontDir=join(docRoot,folder,'fonts');break}catch{}}
if(!fontDir)throw Error('The existing Noto Sans SC font is required for burned-in Chinese subtitles')
const raw=await probe(capture.rawVideo),stream=raw.streams.find(s=>s.codec_type==='video')
const width=stream.width,height=stream.height,rawDuration=Number(raw.format.duration)
// Closing the app adds trailing frames, so total duration is not a clock offset.
// Leave a small guard before each next UI action; review the resulting scene boundaries.
const results=[]
for(const orientation of ['horizontal','vertical']){
  const vertical=orientation==='vertical',parts=[]
  for(const scene of story.scenes){
    const duration=scene.id==='execution'?4:scene.end-scene.start,bg=join(output,`video-${orientation}-${scene.id}.png`),dest=join(temp,`${orientation}-${scene.id}.mp4`)
    let args
    if(scene.source==='cover')args=['-loop','1','-framerate','30','-i',bg,'-t',String(duration),'-vf','format=yuv420p,setsar=1']
    else{
      const cut=capture.scenes.find(s=>s.id===scene.source);if(!cut)throw Error(`Missing actual recorded scene: ${scene.source}`)
      // Cut setup and real waiting from their start; for completed result views retain the stable ending.
      const stable=['execution','reviews','knowledge'].includes(scene.id)
      const safeEnd=cut.end-Math.min(.8,(cut.end-cut.start)/2)
      const sourceLength=Math.max(.5,Math.min(safeEnd-cut.start-.05,stable?Math.min(6,duration):duration))
      const start=Math.min(rawDuration-sourceLength,stable?safeEnd-sourceLength:cut.start+.05)
      const x=vertical?58:416,y=vertical?430:224,targetW=vertical?964:1088,targetH=vertical?964:680
      const cropX=vertical?Math.min(width-960,scene.id==='execution'?400:scene.id==='reviews'?300:240):0
      const crop=vertical?`crop=${Math.min(960,width)}:${height}:${cropX}:0,`:''
      const timing=sourceLength>duration?`setpts=${(duration/sourceLength).toFixed(8)}*(PTS-STARTPTS),`:'setpts=PTS-STARTPTS,'
      const filter=`[1:v]trim=duration=${sourceLength.toFixed(3)},${timing}${crop}scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=0xfafbf8,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=${duration}[product];[0:v][product]overlay=${x}:${y}:shortest=1,format=yuv420p,setsar=1[v]`
      args=['-loop','1','-framerate','30','-i',bg,'-ss',start.toFixed(3),'-t',sourceLength.toFixed(3),'-i',capture.rawVideo,'-filter_complex',filter,'-map','[v]','-t',String(duration)]
    }
    await invoke([...args,'-an','-r','30','-c:v','libopenh264','-b:v',vertical?'6500k':'8000k','-profile:v','high','-g','60','-movflags','+faststart',dest]);parts.push(dest);console.log(`Encoded ${orientation} ${scene.id}`)
    if(scene.id==='execution'){
      if(!capture.verification.actualBrowserButtonVerified||!capture.resultVideo)throw Error('Actual generated webpage interaction has not been verified')
      const resultDest=join(temp,`${orientation}-actual-webpage.mp4`),rw=vertical?964:1088,rh=vertical?964:680,x=vertical?58:416,y=vertical?430:224
      const filter=`[1:v]setpts=PTS-STARTPTS,${vertical?'crop=1080:900:180:0,':''}scale=${rw}:${rh}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${rw}:${rh}:(ow-iw)/2:(oh-ih)/2:color=0xf6f3eb,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=6[product];[0:v][product]overlay=${x}:${y}:shortest=1,format=yuv420p,setsar=1[v]`
      await invoke(['-loop','1','-framerate','30','-i',bg,'-i',capture.resultVideo.path,'-filter_complex',filter,'-map','[v]','-t','6','-an','-r','30','-c:v','libopenh264','-b:v',vertical?'6500k':'8000k','-profile:v','high','-g','60','-movflags','+faststart',resultDest]);parts.push(resultDest)
    }
  }
  const list=join(temp,`${orientation}-concat.txt`)
  await writeFile(list,parts.map(path=>`file '${path.replaceAll('\\','/').replaceAll("'","'\\''")}'`).join('\n'))
  const filename=`model-roundtable-1.0.0-${vertical?'1080x1920':'1920x1080'}.mp4`,final=join(output,filename)
  const clean=join(temp,`${orientation}-without-subtitles.mp4`),ass=join(temp,`${orientation}-subtitles.ass`)
  const assText=`[Script Info]\nScriptType: v4.00+\nPlayResX: ${vertical?1080:1920}\nPlayResY: ${vertical?1920:1080}\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans SC,${vertical?42:32},&H003C4A25,&H003C4A25,&H00E9F3F5,&H00E9F3F5,0,0,0,0,100,100,0,0,1,1,0,2,50,50,${vertical?300:76},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${cues.map(c=>`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${c.text}`).join('\n')}\n`
  await writeFile(ass,assText)
  await invoke(['-f','concat','-safe','0','-i',list,'-c','copy','-an',clean])
  await invoke(['-i',clean,'-vf',`ass=filename='${filterPath(ass)}':fontsdir='${filterPath(fontDir)}',format=yuv420p`,'-an','-r','30','-c:v','libopenh264','-b:v',vertical?'6500k':'8000k','-profile:v','high','-g','60','-movflags','+faststart',final])
  const meta=await probe(final),video=meta.streams.find(s=>s.codec_type==='video'),duration=Number(meta.format.duration)
  if(video.codec_name!=='h264'||video.pix_fmt!=='yuv420p'||Math.abs(duration-60)>.08||meta.streams.some(s=>s.codec_type==='audio'))throw Error(`Invalid final encode ${filename}`)
  results.push({file:filename,codec:video.codec_name,width:video.width,height:video.height,fps:video.r_frame_rate,durationSeconds:duration,audioStreams:0,burnedSubtitles:true,subtitleSha256:createHash('sha256').update(subtitles).digest('hex'),bytes:(await readFile(final)).length,sha256:createHash('sha256').update(await readFile(final)).digest('hex')})
}
await copyFile(join(root,'marketing','captions.zh-CN.srt'),join(output,'captions.zh-CN.srt'))
await copyFile(join(root,'marketing','copy.zh-CN.md'),join(output,'copy.zh-CN.md'))
await copyFile(join(root,'marketing','storyboard.json'),join(output,'storyboard.json'))
await copyFile(join(root,'marketing','assets','SOURCES.md'),join(output,'SOURCES.md'))
await writeFile(join(output,'videos.json'),JSON.stringify({version:'1.0.0',capture: capture.run,ffmpegSha256:createHash('sha256').update(await readFile(ffmpeg)).digest('hex'),files:results},null,2))
console.log('Both 60-second silent H.264 videos encoded. Manual viewing and privacy review still required.')
