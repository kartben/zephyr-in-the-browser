import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
const ROOT = process.argv[2], PORT = Number(process.argv[3])
const T = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm',
           '.elf':'application/octet-stream','.dts':'text/plain','.bin':'application/octet-stream',
           '.rom':'application/octet-stream','.woff2':'font/woff2'}
createServer(async (req,res)=>{
  let f = decodeURIComponent(req.url.split('?')[0]); if (f.endsWith('/')) f += 'index.html'
  res.setHeader('Cross-Origin-Opener-Policy','same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
  try { const b = await readFile(path.join(ROOT,f))
        res.setHeader('Content-Type', T[path.extname(f)] ?? 'application/octet-stream'); res.end(b) }
  catch { res.statusCode = 404; res.end('nope') }
}).listen(PORT,'127.0.0.1',()=>console.log(`${ROOT} -> ${PORT}`))
