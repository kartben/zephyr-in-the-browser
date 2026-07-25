import { chromium } from 'playwright'
const PORT = process.env.PORT
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--no-sandbox','--disable-quic','--disable-background-networking'] })
const p = await b.newPage()
await p.goto(`http://127.0.0.1:${PORT}/zephyr-in-the-browser/?board=qemu_cortex_a53&app=accel_chart&backend=qemu&profile=1`,
  {waitUntil:'domcontentloaded', timeout:120000})
await p.waitForTimeout(35000)
const txt = await p.evaluate(()=>document.body.innerText)
console.log('--- terminal / page text (first 1400 chars) ---')
console.log(txt.slice(0,1400))
await p.screenshot({path:`/tmp/claude-0/-home-user-zephyr-in-the-browser/f3125916-9d3f-5ccf-8b12-2573a2c8866f/scratchpad/shot-${PORT}.png`})
await b.close()
