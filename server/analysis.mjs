const DAY=86400000
const BASE=Date.UTC(1899,11,30)
const cities=['Москва','Санкт-Петербург','Самара','Краснодар','Казань','Нижний Новгород','Владивосток','Новосибирск','Иркутск']
export function dateOf(value) {
  return typeof value==='number'&&Number.isFinite(value) ? new Date(BASE+Math.floor(value)*DAY).toISOString().slice(0,10) : null
}
export function shiftDate(date,days) {
  return new Date(Date.parse(date+'T00:00:00Z')+days*DAY).toISOString().slice(0,10)
}
export function today() {
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',dateStyle:'short'}).format(new Date())
}
const txt=x=>String(x??'').trim().replace(/\s+/g,' ')
const region=x=>({'мск':'Москва','спб':'Санкт-Петербург'}[txt(x).toLowerCase()]??txt(x))
const aliases=Object.fromEntries(Object.entries(JSON.parse(process.env.NSSD_AGENT_ALIASES??'{}')).map(([from,to])=>[txt(from).toLowerCase(),txt(to)]))
const agent=x=>Object.hasOwn(aliases,txt(x).toLowerCase())?aliases[txt(x).toLowerCase()]:txt(x)
const num=x=>typeof x==='number'&&Number.isFinite(x)?x:null
const sum=(rows,key)=>rows.some(r=>typeof r[key]==='number')?rows.reduce((a,r)=>a+(num(r[key])??0),0):null
const ratio=(a,b)=>a!==null&&b>0 ? a/b*100 : null
const registered=['home','funnel','cc','sales','regions','consultations','finance','forecast','compare','quality']
const clean=(rows,parse,day=0)=>rows.filter(r=>dateOf(r[day])>='2026-11-01').map(parse)
export function normalize(raw) {
  const [ops,transfers,contracts,ccLoss,salesLoss]=raw.main
  const [leads,...consultationGrids]=raw.calendar
  const [payroll]=raw.payroll
  const [roster]=raw.roster
  const operators=clean(ops,r=>({date:dateOf(r[0]),agent:agent(r[1]),hours:num(r[2]),calls:num(r[3]),callPlan:num(r[4]),processed:num(r[6]),processPlan:num(r[7]),transferPlan:num(r[10])})).filter(r=>r.agent)
  const outgoing=clean(transfers,r=>({date:dateOf(r[0]),agent:agent(r[2]),manager:txt(r[3]),region:region(r[4]),sla:/^(да|yes|true)$/i.test(txt(r[12]))}))
  const agreements=clean(contracts,r=>({date:dateOf(r[0]),agent:agent(r[1]),manager:txt(r[2]),region:region(r[3]),paid:txt(r[4]).toLowerCase()==='оплачено'}))
  const qualityCC=clean(ccLoss,r=>({date:dateOf(r[0]),agent:agent(r[1]),bad:num(r[3]),refused:num(r[4])}))
  const qualitySales=clean(salesLoss,r=>({date:dateOf(r[0]),agent:agent(r[1]),manager:txt(r[2]),region:region(r[3]),bad:num(r[5]),refused:num(r[6])}))
  const leadRecords=clean(leads,r=>({date:dateOf(r[1]),id:txt(r[0]),crm:txt(r[2]).match(/^https:\/\/[a-z0-9-]+\.bitrix24\.ru\/crm\/lead\/details\/(\d+)(?:[/?#]|$)/i)?.[1],manager:txt(r[3]),region:region(r[4]),agent:agent(r[5]),status:txt(r[6])}),1)
  const shifts=[]
  for(const r of roster.slice(1)) {
    if(!agent(r[0])||!(num(r[3])>0)) continue
    for(let day=1;day<=30;day++) if(txt(r[day+3])) shifts.push({date:'2026-11-'+String(day).padStart(2,'0'),agent:agent(r[0]),region:region(r[1]),hours:txt(r[day+3]).toUpperCase()==='РАБОТАЕТ'?r[3]:0})
  }
  const consultationShifts=consultationGrids.flatMap((grid,i)=>{
    const start=grid.findIndex(row=>txt(row[0]).startsWith('ЗАПИСЬ КОНСУЛЬТАЦИЙ'))
    if(start<4) return []
    return grid.slice(3,start).filter(row=>txt(row[0])&&/^\d{2}:\d{2}/.test(txt(row[1]))).flatMap(row=>row.slice(2,32).map((cell,day)=>({
      date:'2026-11-'+String(day+1).padStart(2,'0'),manager:txt(row[0]),region:cities[i],window:txt(row[1]),status:txt(cell)
    })).filter(row=>row.status))
  })
  return {operators,outgoing,agreements,qualityCC,qualitySales,leadRecords,shifts,consultationShifts,
    payroll:payroll.filter(r=>agent(r[0])&&num(r[13])!==null&&num(r[10])!==null).map(r=>({agent:agent(r[0]),region:region(r[1]),shifts:num(r[3]),salary:r[10],bonus:(num(r[11])??0)+(num(r[12])??0),total:r[13]}))}
}
export function filters(data) {
  const vals=(rows,key)=>[...new Set(rows.map(r=>r[key]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'))
  return {agents:vals(data?.operators??[],'agent'),managers:vals(data?.outgoing??[],'manager'),regions:cities}
}
export function parseQuery(input) {
  const {start,end}=input
  for(const d of [start,end]) if(typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||shiftDate(d,0)!==d) return null
  if(start>end||Date.parse(end)-Date.parse(start)>365*DAY) return null
  return {start,end,agent:typeof input.agent==='string'?input.agent:'',manager:typeof input.manager==='string'?input.manager:'',region:typeof input.region==='string'?input.region:'',section:registered.includes(input.section)?input.section:'home',compare:input.compare==='true'}
}
export function dashboard(data,q,season,targets) {
  const {start,end,section}=q
  const covered=new Set(data.operators.filter(r=>r.date<=season).map(r=>r.date))
  function slice(from,to) {
    const byDate=r=>r.date>=from&&r.date<=to&&r.date<=season
    const byAgent=r=>!q.agent||r.agent===q.agent
    const full=r=>byDate(r)&&byAgent(r)&&(!q.manager||r.manager===q.manager)&&(!q.region||r.region===q.region)
    const dayCoverage=[...covered].some(d=>d>=from&&d<=to)
    const operations=q.manager||q.region?[]:data.operators.filter(r=>byDate(r)&&byAgent(r))
    return {operations,sent:data.outgoing.filter(full),contracts:data.agreements.filter(full),cc:q.manager||q.region?[]:data.qualityCC.filter(r=>byDate(r)&&byAgent(r)),sales:data.qualitySales.filter(full),covered:dayCoverage}
  }
  function metrics(group) {
    const {operations,sent,contracts,cc,sales}=group
    const processed=sum(operations,'processed')
    const transfers=group.covered?sent.length:null
    const signed=group.covered?contracts.length:null
    const paid=group.covered?contracts.filter(r=>r.paid).length:null
    const working=operations.length?new Set(operations.filter(r=>r.hours>0).map(r=>r.agent)).size:null
    return [
      {key:'processed',label:'Обработано',value:processed,plan:sum(operations,'processPlan')},
      {key:'transfers',label:'Направления',value:transfers,plan:sum(operations,'transferPlan')},
      {key:'contracts',label:'Договоры',value:signed},{key:'paid',label:'Договоры со статусом «Оплачено»',value:paid},
      {key:'calls',label:'Звонки',value:sum(operations,'calls'),plan:sum(operations,'callPlan')},
      {key:'hours',label:'Часы по графику',value:sum(operations,'hours')},
      {key:'workers',label:'Сотрудники по расчётным часам',value:working},
      {key:'perWorker',label:'Обработка на сотрудника',value:working>0&&processed!==null?processed/working:null},
      {key:'ccBad',label:'Брак КЦ',value:sum(cc,'bad')},{key:'ccRefused',label:'Отказ КЦ',value:sum(cc,'refused')},
      {key:'salesBad',label:'Брак менеджеров',value:sum(sales,'bad')},{key:'salesRefused',label:'Отказ менеджеров',value:sum(sales,'refused')},
      ...[['p2t','Обработка → направление',processed,transfers],['p2c','Обработка → договор',processed,signed],['t2c','Направление → договор',transfers,signed],['c2p','Договор → оплачен',signed,paid],['p2p','Обработка → оплачен',processed,paid]].map(([key,label,a,b])=>({key,label,value:ratio(b,a),unit:'%'})),
    ]
  }
  const groups=slice(start,end)
  const items=metrics(groups)
  const previousEnd=shiftDate(start,-1)
  const previousStart=shiftDate(previousEnd,-Math.round((Date.parse(end)-Date.parse(start))/DAY))
  const fullCoverage=(a,b)=>[...covered].filter(d=>d>=a&&d<=b).length===Math.round((Date.parse(b)-Date.parse(a))/DAY)+1
  const previous=q.compare&&fullCoverage(start,end)&&fullCoverage(previousStart,previousEnd)?metrics(slice(previousStart,previousEnd)):[]
  const output=items.map((m,i)=>({...m,delta:m.value!=null&&previous[i]?.value!=null?m.value-previous[i].value:null}))
  const coverage=[]
  if(!groups.covered) coverage.push('Нет подтверждённых строк за выбранный период.')
  if(groups.covered&&!fullCoverage(start,end)) coverage.push('Покрытие периода неполное. Данные суммируются по доступным датам.')
  if(q.compare&&!previous.length) coverage.push('Для сравнения двух равных периодов требуется полное покрытие обеих датировок.')
  if(q.manager||q.region) coverage.push('Звонки, обработки и часы КЦ недоступны в разрезе менеджера или региона лида.')
  const tables=[]
  const signals=[]
  const daily=[]
  if(section==='home'||section==='compare') {
    for(let day=start;day<=end;day=shiftDate(day,1)) {
      if(!covered.has(day)) continue
      const rows=metrics(slice(day,day))
      daily.push({date:day,processed:rows[0].value,transfers:rows[1].value,contracts:rows[2].value,paid:rows[3].value})
    }
  }
  if(section==='home'||section==='quality') for(const m of items) if(m.plan>0&&m.value!==null&&m.value<m.plan) signals.push({message:m.label+': '+m.value+' при плане '+m.plan,link:'#cc'})
  if(section==='funnel') {
    coverage.push('Воронка показывает объёмы этапов за период. Связь обработки и договора с ID лида отсутствует, поэтому когортная конверсия недоступна.')
    const ids=data.leadRecords.filter(r=>r.date>=start&&r.date<=end&&r.date<=season&&(!q.agent||r.agent===q.agent)&&(!q.manager||r.manager===q.manager)&&(!q.region||r.region===q.region))
    tables.push({title:'Покрытие идентификаторами расписания',columns:['Записи','Со ссылкой CRM','Уникальные CRM ID'],rows:ids.length?[[ids.length,ids.filter(r=>r.crm).length,new Set(ids.map(r=>r.crm).filter(Boolean)).size]]:[]})
  }
  if(section==='cc'||section==='sales'||section==='regions') {
    const property={cc:'agent',sales:'manager',regions:'region'}[section]
    const keys=new Set([...groups.operations,...groups.sent,...groups.contracts].map(r=>r[property]).filter(Boolean))
    const rows=[...keys].map(name=>{
      const operations=groups.operations.filter(r=>r[property]===name)
      const sent=groups.sent.filter(r=>r[property]===name)
      const contracts=groups.contracts.filter(r=>r[property]===name)
      return [name,sum(operations,'processed'),sent.length,contracts.length,contracts.filter(r=>r.paid).length,ratio(contracts.length,sent.length)]
    }).sort((a,b)=>b[2]-a[2])
    tables.push({title:'Результаты по выбранному разрезу',columns:['Название','Обработано','Направлено','Договоры','Оплачено','Направление → договор, %'],rows})
  }
  if(section==='consultations') {
    coverage.push('Читаются статусы смен и направления. Свободные слоты и записи вне рабочего времени требуют сверки матриц расписания.')
    const rows=data.consultationShifts.filter(r=>r.date>=start&&r.date<=end&&(!q.manager||r.manager===q.manager)&&(!q.region||r.region===q.region))
    tables.push({title:'Смены менеджеров',columns:['Дата','Регион','Менеджер','Часы по расписанию','Статус'],rows:q.agent?[]:rows.map(r=>[r.date,r.region,r.manager,r.window,r.status])})
  }
  if(section==='finance') {
    coverage.push('Зарплата — месячные начисления за ноябрь 2026. Для произвольной части месяца распределение не определено.')
    const monthly=start==='2026-11-01'&&end==='2026-11-30'&&!q.manager&&!q.region
    const rows=monthly?data.payroll.filter(r=>!q.agent||r.agent===q.agent):[]
    tables.push({title:'Начисления КЦ',columns:['Сотрудник','Город сотрудника','Смены','Оклад, ₽','Бонусы, ₽','Итого, ₽'],rows:rows.map(r=>[r.agent,r.region,r.shifts,r.salary,r.bonus,r.total])})
  }
  if(section==='forecast') {
    const monthFact=metrics(slice('2026-11-01',season))
    const remaining=data.shifts.filter(r=>r.date>season&&(!q.agent||r.agent===q.agent))
    const hours=sum(remaining,'hours')
    const rate=monthFact[5].value>0&&monthFact[0].value!==null?monthFact[0].value/monthFact[5].value:null
    const opportunity=!q.manager&&!q.region&&hours!==null&&rate!==null
    if(opportunity) {
      const processed=monthFact[0].value
      const y=[monthFact[1].value,monthFact[2].value,monthFact[3].value]
      const candidates=[['Консервативный',0.85,1],['Базовый',1,1],['Оптимистичный',1,1.1]]
      tables.push({title:'Прогноз на 30 ноября по плановым часам',columns:['Сценарий','Обработано','Направлено','Договоры','Оплачено'],rows:candidates.map(([label,productivity,conversion])=>{
        const extension=rate*hours*productivity
        return [label,Math.round(processed+extension),...y.map(result=>processed>0?Math.round(result+extension*Math.min(1,result/processed*conversion)):null)]
      })})
    }
    if(!opportunity) coverage.push('Прогнозу нужны подтверждённые часы графика и факт за ноябрь. Регион лида и менеджер не связаны с часами КЦ.')
    if(!q.agent&&!q.manager&&!q.region) tables.push({title:'Цели на ноябрь',columns:['Цель','План','Осталось'],rows:[['Договоры',targets.contracts,monthFact[2].value===null?null:Math.max(0,targets.contracts-monthFact[2].value)],['Оплаты по статусу договора',targets.paid,monthFact[3].value===null?null:Math.max(0,targets.paid-monthFact[3].value)]]})
  }
  if(section==='quality') tables.push({title:'Нарушения SLA в передачах',columns:['Дата','Регион','Менеджер','Сотрудник КЦ'],rows:groups.sent.filter(r=>r.sla).map(r=>[r.date,r.region,r.manager,r.agent])})
  if(section==='compare'&&previous.length) tables.push({title:'Равные интервалы',columns:['Показатель','Текущий','Предыдущий','Изменение','Относительно, %'],rows:items.map((m,i)=>[m.label,m.value,previous[i].value,output[i].delta,m.unit==='%'?null:ratio(output[i].delta,previous[i].value)])})
  return {metrics:['finance','consultations','forecast'].includes(section)?[]:output,daily,tables,signals,coverage}
}
