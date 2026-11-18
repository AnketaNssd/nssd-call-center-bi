import { sourceSpec as contracts } from './sources.mjs'
import express from 'express'
import { GoogleAuth, OAuth2Client } from 'google-auth-library'
import { randomBytes } from 'node:crypto'
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { dashboard, filters, normalize, parseQuery, today } from './analysis.mjs'

const app=express()
app.disable('x-powered-by')
app.use(express.urlencoded({extended:false,limit:'4kb'}))
app.use(express.json({limit:'4kb'}))
const origin=new URL(process.env.APP_ORIGIN??'http://localhost:8080')
const secure=origin.protocol==='https:'
if(process.env.NODE_ENV==='production'&&!secure) throw new Error('HTTPS required in production')
const oauth=new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID,process.env.GOOGLE_OAUTH_CLIENT_SECRET,new URL('/auth/callback',origin).href)
const directory=resolve(process.env.NSSD_STATE_DIR??'.state')
const statePath=resolve(directory,'targets.json')
const accounts=new Map(Object.entries(JSON.parse(process.env.NSSD_ACCOUNTS??'{}')).map(([email,role])=>[email.toLowerCase(),role]))
const sessions=new Map()
const states=new Map()
const opaque=()=>randomBytes(32).toString('base64url')
const cookieOptions={httpOnly:true,secure,sameSite:'lax',path:'/'}
const sessionAge=8*60*60*1000
const cookie=(req,name)=>req.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)
app.use(['/auth','/api'],(req,res,next)=>{res.set('Cache-Control','private, no-store');next()})
app.get('/auth/login',(req,res)=>{
  if(!process.env.GOOGLE_OAUTH_CLIENT_ID||!process.env.GOOGLE_OAUTH_CLIENT_SECRET||!accounts.size) return res.status(503).send('Корпоративный вход ещё не настроен.')
  const state=opaque()
  states.set(state,Date.now()+600_000)
  res.cookie('nssd_oauth',state,{...cookieOptions,maxAge:600_000})
  res.redirect(oauth.generateAuthUrl({state,scope:['openid','email'],prompt:'select_account'}))
})
app.get('/auth/callback',async(req,res)=>{
  const state=cookie(req,'nssd_oauth')
  const deadline=states.get(state)
  if(state) states.delete(state)
  res.clearCookie('nssd_oauth',cookieOptions)
  if(!deadline||deadline<Date.now()||state!==req.query.state||typeof req.query.code!=='string') return res.status(403).send('Запрос входа истёк.')
  try {
    const {tokens}=await oauth.getToken(req.query.code)
    const claim=(await oauth.verifyIdToken({idToken:tokens.id_token,audience:process.env.GOOGLE_OAUTH_CLIENT_ID})).getPayload()
    const email=claim?.email_verified&&claim.email?.toLowerCase()
    if(!email||!['viewer','finance','admin'].includes(accounts.get(email))) return res.status(403).send('Доступ к системе не предоставлен.')
    const sid=opaque()
    sessions.set(sid,{email,csrf:opaque(),expires:Date.now()+sessionAge})
    res.cookie('nssd_session',sid,{...cookieOptions,maxAge:sessionAge})
    res.redirect('/')
  } catch { res.status(403).send('Корпоративный вход не выполнен.') }
})
function authorized(req,res,next) {
  const id=cookie(req,'nssd_session')
  const session=sessions.get(id)
  const role=accounts.get(session?.email)
  if(!session||session.expires<Date.now()||!['viewer','finance','admin'].includes(role)) return res.sendStatus(401)
  req.session={...session,role,id}
  next()
}
function csrf(req,res,next) {
  if((req.get('origin')&&req.get('origin')!==origin.origin)||(req.get('X-CSRF-Token')??req.body?.csrf)!==req.session.csrf) return res.sendStatus(403)
  next()
}
app.post('/auth/logout',authorized,csrf,(req,res)=>{
  sessions.delete(req.session.id)
  res.clearCookie('nssd_session',cookieOptions)
  res.redirect('/')
})
app.use('/api',authorized)

const sourceSpec=Object.fromEntries(Object.entries(contracts).map(([key,spec])=>[key,{...spec,id:process.env[spec.property]}]))
const google=new GoogleAuth({scopes:['https://www.googleapis.com/auth/spreadsheets.readonly']})
let data=null
let syncedAt=null
let lastAttempt=0
let failed=false
let pending=null
let targets={contracts:250,paid:125}
try {targets=JSON.parse(await readFile(statePath,'utf8'))} catch(error) {if(error.code!=='ENOENT') throw error}
const scheduleMs=300_000
const isConfigured=Object.values(sourceSpec).every(s=>s.id)
async function fetchSource(client,spec) {
  const url=new URL('https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(spec.id)+'/values:batchGet')
  for(const range of spec.ranges) url.searchParams.append('ranges',range)
  url.searchParams.set('valueRenderOption','UNFORMATTED_VALUE')
  url.searchParams.set('dateTimeRenderOption','SERIAL_NUMBER')
  const {data:result}=await client.request({url:url.href,timeout:25000,retry:true,retryConfig:{retry:2,retryDelay:1500}})
  const valueRanges=result.valueRanges
  if(!Array.isArray(valueRanges)||valueRanges.length!==spec.ranges.length) throw new Error('Unexpected range response')
  const rows=valueRanges.map(x=>x.values??[])
  if(spec.caps.some((cap,i)=>rows[i].length>=cap)) throw new Error('Configured range reached capacity')
  return rows
}
async function sync() {
  if(pending) return pending
  if(Date.now()-lastAttempt<30_000) return !failed
  lastAttempt=Date.now()
  pending=(async()=>{
    try {
      if(!isConfigured) throw new Error('Sheets unavailable')
      const client=await google.getClient()
      const pairs=await Promise.all(Object.entries(sourceSpec).map(async ([key,spec])=>[key,await fetchSource(client,spec)]))
      const next=normalize(Object.fromEntries(pairs))
      if(!next.operators.length) throw new Error('Operational sheet empty or schema changed')
      data=next
      syncedAt=new Date().toISOString()
      failed=false
      return true
    } catch(error) {
      failed=true
      console.error('NSSD synchronization failed',error.response?.status??error.code??error.name)
      return false
    }
  })().finally(()=>{pending=null})
  return pending
}
if(isConfigured) void sync()
setInterval(()=>{if(isConfigured) void sync()},scheduleMs).unref()
setInterval(()=>{
  for(const [key,value] of sessions) if(value.expires<Date.now()) sessions.delete(key)
  for(const [key,value] of states) if(value<Date.now()) states.delete(key)
},60_000).unref()
app.get('/api/session',(req,res)=>{
  const dates=data?.operators.map(r=>r.date).filter(d=>d<=today()).sort()??[]
  const end=dates.at(-1)??today()
  res.json({email:req.session.email,role:req.session.role,csrf:req.session.csrf,range:{start:end.slice(0,8)+'01',end},filters:filters(data)})
})
app.get('/api/dashboard',(req,res)=>{
  const query=parseQuery(req.query)
  if(!query) return res.sendStatus(400)
  if(query.section==='finance'&&req.session.role==='viewer') return res.sendStatus(403)
  if(!data) return res.sendStatus(503)
  res.json({...dashboard(data,query,today(),targets),syncedAt,stale:failed||Date.now()-Date.parse(syncedAt)>scheduleMs*2})
})
app.post('/api/refresh',csrf,async(req,res)=>res.status(await sync()?200:503).json({syncedAt}))
let writing=false
app.put('/api/targets',csrf,async(req,res)=>{
  if(req.session.role!=='admin') return res.sendStatus(403)
  const {contracts,paid}=req.body??{}
  if(![contracts,paid].every(x=>Number.isSafeInteger(x)&&x>0&&x<=1_000_000)) return res.sendStatus(400)
  if(writing) return res.sendStatus(409)
  writing=true
  const next={contracts,paid}
  try {
    await mkdir(directory,{recursive:true})
    await writeFile(statePath+'.tmp',JSON.stringify(next),{mode:0o600})
    await rename(statePath+'.tmp',statePath)
    targets=next
    res.json(targets)
  } finally {writing=false}
})
app.get('/api/targets',(req,res)=>res.json(targets))
app.use('/api',(_req,res)=>res.sendStatus(404))
app.use(express.static(resolve('dist')))
app.use((_error,_req,res,_next)=>res.sendStatus(500))
app.listen(Number(process.env.PORT??8080),process.env.HOST??'127.0.0.1',()=>console.log('NSSD BI listening'))

