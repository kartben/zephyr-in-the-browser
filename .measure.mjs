import { chromium } from 'playwright'
const PORT = process.env.PORT, LABEL = process.env.LABEL ?? PORT
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--no-sandbox','--disable-quic','--disable-background-networking'] })
const p = await b.newPage()
const t0 = Date.now()
await p.goto(`http://127.0.0.1:${PORT}/zephyr-in-the-browser/?board=qemu_cortex_a53&app=accel_chart&backend=qemu&profile=1`,
  {waitUntil:'domcontentloaded', timeout:120000})
let bootMs = null
const dl = Date.now()+180000
while (Date.now() < dl) {
  const s = await p.evaluate(()=>window.__zephyrProfile?.snapshot() ?? null)
  if (s && (s.display?.available || s.bridgeHz > 0 || s.mips > 0)) { bootMs = Date.now()-t0; break }
  await p.waitForTimeout(1000)
}
if (/mock/i.test(await p.evaluate(()=>document.body.innerText))) { console.log(`${LABEL}: MOCK BACKEND`); await b.close(); process.exit(1) }
const rows = []
for (let i=0;i<10;i++){ await p.waitForTimeout(2500)
  const s = await p.evaluate(()=>window.__zephyrProfile?.snapshot()); if (s) rows.push(s) }
const live = rows.filter(s=>s.i2cHz>0 || s.mips>0)
const avg = f => live.reduce((a,s)=>a+(f(s)??0),0)/Math.max(1,live.length)
console.log(`${LABEL}: boot ${bootMs===null?'n/a':(bootMs/1000).toFixed(1)+'s'}  mips ${avg(s=>s.mips).toFixed(2)}  i2cHz ${avg(s=>s.i2cHz).toFixed(0)}  bridgePollMs ${avg(s=>s.bridgePollMs).toFixed(2)}  guestFps ${avg(s=>s.guestFps).toFixed(1)}`)
await b.close()
