import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--no-sandbox','--enable-unsafe-swiftshader'] })
const p = await b.newPage()
const errs=[]; p.on('pageerror',e=>errs.push(String(e).slice(0,200)))
await p.goto('http://localhost:5233/?record&norender&autostart')
await p.waitForFunction(()=>typeof window.__step==='function',null,{timeout:20000})
const step=async(n)=>p.evaluate((k)=>{for(let i=0;i<k;i++)window.__step()},n)
const gap=(a)=>{ if(a.length<2)return 360; const s=[...a].sort((x,y)=>x-y); let mx=0; for(let i=0;i<s.length;i++){const d=(i===s.length-1?s[0]+360-s[s.length-1]:s[i+1]-s[i]); if(d>mx)mx=d} return Math.round(mx) }
const trial = async (label, mods)=>{
  await step(80)
  await p.evaluate((m)=>window.__spawnRing('drone',5,m),mods)
  await p.keyboard.down('KeyA')
  let minNear=99
  const log=[]
  for(let i=0;i<8;i++){ await step(30); const d=await p.evaluate(()=>window.__dbg()); minNear=Math.min(minNear,d.nearest); log.push(`n=${d.nearest}/live=${d.encAngles.length}`) }
  await p.keyboard.up('KeyA')
  console.log(`[${label}] 도주중 접근: ${log.join('  ')}  → 최소거리 ${minNear}`)
  // 남은 적 제거
  await p.evaluate(()=>{ const g=window.__dbg(); })
}
await step(200)
await trial('일반 드론(램프 가속)', [])
await b.close(); console.log('errs', errs.slice(0,3))
