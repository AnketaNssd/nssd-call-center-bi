import { build } from 'esbuild'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const output = resolve('apps-script/dist')
await mkdir(output, { recursive: true })
const html = await readFile('dist/index.html', 'utf8')
const script = html.match(/<script[^>]+src="([^"]+)"[^>]*><\/script>/)
const style = html.match(/<link[^>]+href="([^"]+\.css)"[^>]*>/)
if (!script || !style) throw new Error('Vite entry assets not found')
const js = await readFile(resolve('dist', script[1].replace(/^\//,'')),'utf8')
const css = await readFile(resolve('dist', style[1].replace(/^\//,'')),'utf8')
if (js.includes('<?') || css.includes('<?')) throw new Error('Unexpected Apps Script template delimiter')
await writeFile(resolve(output,'Index.html'),html
  .replace(script[0],'')
  .replace(style[0],()=>'<style>'+css+'</style>')
  .replace('</body>',()=>'<script>'+js.replace(/<\/script/gi,'<\\/script')+'</script></body>'))
await build({entryPoints:['apps-script/core.mjs'],bundle:true,format:'iife',globalName:'NssdCore',outfile:resolve(output,'Core.gs'),platform:'browser',target:'es2020',define:{'process.env.NSSD_AGENT_ALIASES':'"{}"'}})
for (const name of ['Code.gs','appsscript.json']) await copyFile(resolve('apps-script',name),resolve(output,name))
