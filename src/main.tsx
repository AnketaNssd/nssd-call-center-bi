import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import './style.css'

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])
const sections = [
  ['home','Главная'],['funnel','Воронка продаж'],['cc','Колл-центр'],['sales','Менеджеры продаж'],
  ['regions','Регионы'],['consultations','Консультации'],['finance','Финансы и зарплата'],
  ['forecast','Прогнозы'],['compare','Сравнение периодов'],['quality','Контроль качества'],
] as const
type Metric = {key:string; label:string; value:number|null; plan?:number|null; delta?:number|null; unit?:string}
type Point = {date:string; processed:number|null; transfers:number|null; contracts:number|null; paid:number|null}
type Table = {title:string; columns:string[]; rows:(string|number|null)[][]}
type View = {syncedAt:string; stale:boolean; coverage:string[]; metrics:Metric[]; daily:Point[]; tables:Table[]; signals:{message:string; link:string}[]}
type Session = {email:string; role:string; csrf:string; range:{start:string;end:string}; filters:{agents:string[];managers:string[];regions:string[]}}
const client = new QueryClient({defaultOptions:{queries:{retry:false}}})
const fmt = new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1})
function currentSection() {
  const key = location.hash.slice(1)
  return sections.find(([id])=>id===key)?.[0] ?? 'home'
}
type ScriptRunner = {
  withSuccessHandler: (fn:(value:unknown)=>void)=>ScriptRunner
  withFailureHandler: (fn:(error:Error)=>void)=>ScriptRunner
  rpc: (action:string,payload:unknown)=>void
}
const scriptWindow=window as Window & {google?:{script?:{run?:ScriptRunner}}}
const getRunner=()=>scriptWindow.google?.script?.run
const inAppsScript=document.documentElement.dataset.host==='apps-script'
function readTheme() {
  try { return localStorage.getItem('nssd-theme') } catch { return null }
}
function saveTheme(theme:string) {
  try { localStorage.setItem('nssd-theme',theme) } catch { /* Theme still applies for this session. */ }
}
async function api<T>(path:string, init?:RequestInit):Promise<T> {
  if (inAppsScript) {
    const runner=getRunner()
    if (!runner) throw new Error('Google Apps Script не подключил интерфейс. Откройте ссылку /exec из настроек развёртывания.')
    const url=new URL(path,'https://apps-script.invalid')
    const actions:Record<string,string>={'/api/session':'session','/api/dashboard':'dashboard','/api/refresh':'refresh','/api/targets':init?.method==='PUT'?'saveTargets':'targets'}
    const payload=init?.body?JSON.parse(String(init.body)):Object.fromEntries(url.searchParams)
    return new Promise<T>((resolve,reject)=>runner.withSuccessHandler(value=>resolve(value as T)).withFailureHandler(reject).rpc(actions[url.pathname],payload))
  }
  const response = await fetch(path, init)
  if (!response.ok) throw new Error(String(response.status))
  return response.json()
}
function Chart({daily,dark}:{daily:Point[];dark:boolean}) {
  const ref=useRef<HTMLDivElement>(null)
  useEffect(()=>{
    if (!ref.current) return
    const chart=echarts.init(ref.current)
    const palette=['#2784ff','#36bc9a','#e2a645','#9975fa']
    chart.setOption({
      color:palette, tooltip:{trigger:'axis'}, legend:{textStyle:{color:dark?'#b2bfd6':'#536584'}},
      grid:{left:54,right:20,top:54,bottom:42},
      xAxis:{type:'category',data:daily.map(p=>p.date.slice(5)),axisLabel:{color:dark?'#b2bfd6':'#536584'}},
      yAxis:{type:'value',splitLine:{lineStyle:{color:dark?'#27344d':'#e4eaf2'}},axisLabel:{color:dark?'#b2bfd6':'#536584'}},
      series:([['processed','Обработано'],['transfers','Направлено'],['contracts','Договоры'],['paid','Оплачено']] as const)
        .filter(([key])=>daily.some(p=>p[key]!==null))
        .map(([key,name])=>({name,type:'line',data:daily.map(p=>p[key]),showSymbol:daily.length<8,connectNulls:false})),
    })
    const observer=new ResizeObserver(()=>chart.resize())
    observer.observe(ref.current)
    return ()=>{observer.disconnect();chart.dispose()}
  },[daily,dark])
  return <div className="graph" ref={ref} role="img" aria-label="Динамика показателей по дням"/>
}
function Value({value,unit=''}:{value:number|null;unit?:string}) {
  return value===null ? <span title="Нет подтверждённых данных">—</span> : <>{fmt.format(value)}{unit}</>
}
function Grid({table}:{table:Table}) {
  return <section className="panel"><h2>{table.title}</h2>{table.rows.length?
    <div className="table-scroll"><table><thead><tr>{table.columns.map(label=><th key={label}>{label}</th>)}</tr></thead>
    <tbody>{table.rows.map((row,index)=><tr key={index}>{row.map((value,col)=><td key={col}>{typeof value==='number'?<Value value={value}/>:value??'—'}</td>)}</tr>)}</tbody></table></div>
    :<p className="muted">Нет подтверждённых данных для выбранного периода.</p>}</section>
}
function Targets({csrf}:{csrf:string}) {
  const goals=useQuery({queryKey:['targets'],queryFn:()=>api<{contracts:number;paid:number}>('/api/targets')})
  const [status,setStatus]=useState('')
  if (!goals.data) return null
  return <form className="panel filters" onSubmit={async event=>{
    event.preventDefault()
    const values=new FormData(event.currentTarget)
    try {
      await api('/api/targets',{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({contracts:Number(values.get('contracts')),paid:Number(values.get('paid'))})})
      await client.invalidateQueries({queryKey:['view']})
      setStatus('Цели сохранены')
    } catch {setStatus('Не удалось сохранить цели')}
  }}>
    <label>Цель по договорам<input name="contracts" type="number" min="1" max="1000000" required defaultValue={goals.data.contracts}/></label>
    <label>Цель по оплатам<input name="paid" type="number" min="1" max="1000000" required defaultValue={goals.data.paid}/></label>
    <button>Сохранить цели</button><span role="status">{status}</span>
  </form>
}
function Dashboard({session}:{session:Session}) {
  const [section,setSection]=useState(currentSection)
  const [dark,setDark]=useState(readTheme()==='dark')
  const [start,setStart]=useState(session.range.start)
  const [end,setEnd]=useState(session.range.end)
  const [agent,setAgent]=useState('')
  const [manager,setManager]=useState('')
  const [region,setRegion]=useState('')
  const [compare,setCompare]=useState(false)
  const [refreshError,setRefreshError]=useState('')
  const [refreshing,setRefreshing]=useState(false)
  useEffect(()=>{const update=()=>setSection(currentSection());window.addEventListener('hashchange',update);return ()=>window.removeEventListener('hashchange',update)},[])
  useEffect(()=>{document.documentElement.dataset.theme=dark?'dark':'light';saveTheme(dark?'dark':'light')},[dark])
  const query=new URLSearchParams({start,end,agent,manager,region,compare:String(compare||section==='compare'),section})
  const view=useQuery({queryKey:['view',query.toString()],queryFn:()=>api<View>('/api/dashboard?'+query),refetchInterval:60_000,enabled:!!start&&!!end&&start<=end})
  async function refresh() {
    setRefreshing(true);setRefreshError('')
    try {
      await api('/api/refresh',{method:'POST',headers:{'X-CSRF-Token':session.csrf}})
      await client.invalidateQueries({queryKey:['view']})
    } catch {setRefreshError('Обновление не удалось. Проверьте статус источников.')}
    finally {setRefreshing(false)}
  }
  function preset(days:number) {
    const date=new Date(session.range.end+'T00:00:00Z')
    if(days===0) date.setUTCDate(1)
    else date.setUTCDate(date.getUTCDate()-days+1)
    setStart(date.toISOString().slice(0,10));setEnd(session.range.end)
  }
  const data=view.data
  const headline=section==='home' ? data?.metrics.filter(m=>['processed','transfers','contracts','paid'].includes(m.key)) ?? [] : []
  const remaining=section==='home' ? data?.metrics.filter(m=>!headline.includes(m)) ?? [] : data?.metrics ?? []
  return <div className="shell">
    <aside><div className="brand"><span>Н</span><div>НССД<small>Аналитика колл-центра</small></div></div>
      <nav aria-label="Разделы">{sections.filter(([id])=>id!=='finance'||session.role!=='viewer').map(([id,label])=><a key={id} href={'#'+id} aria-current={id===section?'page':undefined}>{label}</a>)}</nav>
    </aside>
    <main>
      <header className="top"><div><div className="eyebrow">Управленческая аналитика</div><h1>{sections.find(([id])=>id===section)?.[1]}</h1></div>
      <div className="top-actions"><button onClick={()=>setDark(!dark)}>{dark?'Светлая тема':'Тёмная тема'}</button><button onClick={refresh} disabled={refreshing}>{refreshing?'Обновление…':'Обновить данные'}</button>
      {!inAppsScript&&<form action="/auth/logout" method="post"><input name="csrf" type="hidden" value={session.csrf}/><button>Выйти</button></form>}</div></header>
      <div className="panel filters">
        <div className="presets">{[[1,'Последний день'],[7,'7 дней'],[0,'Месяц']].map(([days,label])=><button key={days} onClick={()=>preset(Number(days))}>{label}</button>)}</div>
        <label>С даты<input type="date" value={start} onChange={e=>setStart(e.target.value)}/></label>
        <label>По дату<input type="date" value={end} onChange={e=>setEnd(e.target.value)}/></label>
        <label>Регион<select value={region} onChange={e=>setRegion(e.target.value)}><option value="">Все</option>{session.filters.regions.map(x=><option key={x}>{x}</option>)}</select></label>
        <label>Сотрудник КЦ<select value={agent} onChange={e=>setAgent(e.target.value)}><option value="">Все</option>{session.filters.agents.map(x=><option key={x}>{x}</option>)}</select></label>
        <label>Менеджер<select value={manager} onChange={e=>setManager(e.target.value)}><option value="">Все</option>{session.filters.managers.map(x=><option key={x}>{x}</option>)}</select></label>
        <label className="toggle"><input type="checkbox" checked={compare} onChange={e=>setCompare(e.target.checked)}/>Предыдущий период</label>
      </div>
      {section==='forecast'&&session.role==='admin'&&<Targets csrf={session.csrf}/>}
      {refreshError&&<p className="notice" role="alert">{refreshError}</p>}
      {start>end&&<p className="notice">Дата начала должна предшествовать дате окончания.</p>}
      {view.isFetching&&!data&&<p className="muted" role="status">Загрузка показателей…</p>}
      {view.isError&&<p className="notice" role="alert">{view.error.message==='503'?'Синхронизация ещё не завершилась.':'Данные сейчас недоступны.'}</p>}
      {data&&<>
        <p className={data.stale?'notice':'muted'}>{data.stale?'Данные могут быть устаревшими. ':''}Синхронизация: {new Date(data.syncedAt).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК</p>
        {data.coverage.map(x=><p className="notice" key={x}>{x}</p>)}
        {!!headline.length&&<div className="metrics headline">{headline.map(m=><article className="panel kpi" key={m.key}>
          <h2>{m.label}</h2><strong><Value value={m.value}/></strong>
          {m.plan!=null&&m.plan>0&&m.value!=null&&<><progress max={m.plan} value={Math.min(m.plan,m.value)} aria-label="Выполнение плана"/><small className={m.value>=m.plan?'good':'below'}>{fmt.format(m.value/m.plan*100)}% плана · {fmt.format(m.plan)}</small></>}
          {m.delta!=null&&<small>К предыдущему периоду {m.delta>0?'+':''}{fmt.format(m.delta)}</small>}
        </article>)}</div>}
        {!!data.daily.length&&<section className="panel"><h2>Динамика по дням</h2><Chart daily={data.daily} dark={dark}/></section>}
        {!!remaining.length&&<div className="metrics">{remaining.map(m=><article className="panel kpi" key={m.key}><h2>{m.label}</h2><strong><Value value={m.value} unit={m.unit}/></strong>
          {m.plan!=null&&<small>План {fmt.format(m.plan)}{m.plan>0&&m.value!==null?' · '+fmt.format(m.value/m.plan*100)+'%':''}</small>}
          {m.delta!=null&&<small>К предыдущему: {m.delta>0?'+':''}{fmt.format(m.delta)}{m.unit==='%'?' п. п.':''}</small>}</article>)}</div>}

        {!!data.signals.length&&<section className="panel"><h2>Что требует внимания</h2><ul className="signals">{data.signals.map(s=><li key={s.message}><a href={s.link}>{s.message}</a></li>)}</ul></section>}
        {data.tables.map(t=><Grid key={t.title} table={t}/>)}
      </>}
    </main>
  </div>
}
function App() {
  const session=useQuery({queryKey:['session'],queryFn:()=>api<Session>('/api/session'),refetchInterval:60_000})
  if(session.isPending) return <main className="login"><section className="panel" role="status">Проверка доступа…</section></main>
  if(session.isError) return <main className="login"><section className="panel"><div className="eyebrow">НССД</div><h1>Аналитика колл-центра</h1><p>{inAppsScript?"Проверьте настройки источников и попробуйте ещё раз.":"Войдите через допущенную корпоративную учётную запись."}</p>{inAppsScript?<><p role="alert">{session.error.message}</p><button onClick={()=>session.refetch()}>Повторить</button></>:<a className="primary" href="/auth/login">Войти через Google</a>}</section></main>
  return <Dashboard session={session.data}/>
}
function mount() {
  createRoot(document.getElementById('root')!, {
    onUncaughtError: () => {
      const status=document.getElementById('startup-status')
      if(status) status.textContent='Интерфейс остановился. Обновите страницу и проверьте версию развёртывания.'
    },
  }).render(<QueryClientProvider client={client}><App/></QueryClientProvider>)
}
if(inAppsScript&&document.readyState!=='complete') window.addEventListener('load',mount,{once:true})
else mount()
