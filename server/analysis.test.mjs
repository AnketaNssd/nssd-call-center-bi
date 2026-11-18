import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalize, dashboard, parseQuery } from './analysis.mjs'

const d=46344
const operations=[d,'Тест КЦ',8,100,300,null,16,24,null,null,10]
const sent=[d,null,'Тест КЦ','Тест ОП','Москва']
const contract=[d,'Тест КЦ','Тест ОП','Москва','Оплачено']
const data=normalize({main:[[operations],[sent],[contract],[[d,'Тест КЦ','да',2,3]],[[d,'Тест КЦ','Тест ОП','Москва',1,0,0]]],calendar:[[[1,d,'https://example.bitrix24.ru/crm/lead/details/1/','Тест ОП','Москва','Тест КЦ','Оплата']]],payroll:[[]],roster:[[]]})
const range={start:'2026-11-18',end:'2026-11-18'}
const goals={contracts:250,paid:125}
function view(params={}) {return dashboard(data,parseQuery({...range,...params}),'2026-11-18',goals)}
test('compiled definitions keep operational counts, transfer rows and payment statuses distinct',()=>{
  const metrics=Object.fromEntries(view().metrics.map(x=>[x.key,x.value]))
  assert.equal(metrics.processed,16)
  assert.equal(metrics.transfers,1)
  assert.equal(metrics.contracts,1)
  assert.equal(metrics.paid,1)
  assert.equal(metrics.p2t,6.25)
  assert.equal(metrics.ccBad,2)
})
test('unsupported dimension is null, and unsupported dates do not become zero',()=>{
  assert.equal(view({manager:'Тест ОП'}).metrics[0].value,null)
  assert.equal(view({start:'2026-11-19',end:'2026-11-19'}).metrics[1].value,null)
})
test('same-length previous comparison refuses incomplete periods',()=>{
  const result=view({compare:'true'})
  assert.equal(result.metrics[0].delta,null)
  assert.ok(result.coverage.some(x=>x.includes('равных')))
  assert.equal(parseQuery({start:'2026-11-31',end:'2026-12-01'}),null)
})
