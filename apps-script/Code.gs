function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('NSSD · Аналитика колл-центра').addMetaTag('viewport','width=device-width, initial-scale=1');
}

function rpc(action, payload) {
  const props = PropertiesService.getScriptProperties();
  const shared = props.getProperty('NSSD_SHARED_VIEW') === 'true';
  const activeSources = Object.entries(NssdCore.sourceSpec).filter(([key])=>!shared||key!=='payroll');
  const now = Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd');
  const targets = {
    contracts: Number(props.getProperty('TARGET_CONTRACTS')) || 250,
    paid: Number(props.getProperty('TARGET_PAID')) || 125
  };
  if (action === 'targets') return targets;
  if (action === 'saveTargets') {
    if (shared) throw new Error('Изменение целей недоступно в режиме просмотра.');
    const {contracts,paid}=payload || {};
    if (![contracts,paid].every(n=>Number.isSafeInteger(n)&&n>0&&n<=1000000)) throw new Error('Некорректные цели.');
    props.setProperties({TARGET_CONTRACTS:String(contracts),TARGET_PAID:String(paid)});
    return {contracts,paid};
  }
  if (!['session','refresh','dashboard'].includes(action)) throw new Error('Неизвестная операция.');
  const query = action === 'dashboard' ? NssdCore.parseQuery(payload || {}) : null;
  if (action === 'dashboard' && !query) throw new Error('Проверьте даты.');
  if (shared && query && query.section === 'finance') throw new Error('Раздел недоступен в режиме просмотра.');
  const snapshot = readSnapshot_(props, action === 'refresh', activeSources, shared);
  if (action === 'refresh') return {syncedAt:snapshot.syncedAt};
  if (action === 'session') {
    const last = snapshot.data.operators.map(r=>r.date).filter(date=>date<=now).sort().pop() || now;
    return {role:shared?'viewer':'admin',csrf:'',range:{start:last.slice(0,8)+'01',end:last},filters:NssdCore.filters(snapshot.data)};
  }
  return Object.assign(NssdCore.dashboard(snapshot.data,query,now,targets), {
    syncedAt:snapshot.syncedAt, stale:Date.now()-Date.parse(snapshot.syncedAt)>300000
  });
}

function readSnapshot_(props, refresh, activeSources, shared) {
  const cache=CacheService.getUserCache();
  const cacheKey=shared?'nssd-shared-v1':'nssd-owner-v1';
  const old=readCache_(cache,cacheKey);
  if (old&&Date.now()-Date.parse(old.syncedAt)<(refresh?30000:300000)) return old;
  const lock=LockService.getUserLock();
  lock.waitLock(12000);
  try {
    const current=readCache_(cache,cacheKey);
    if (current&&Date.now()-Date.parse(current.syncedAt)<(refresh?30000:300000)) return current;
    const raw={payroll:[[]]};
    for (const [key,spec] of activeSources) {
      const id=props.getProperty(spec.property);
      if (!id) throw new Error('Отсутствует настройка '+spec.property);
      const response=Sheets.Spreadsheets.Values.batchGet(id,{
        ranges:spec.ranges,valueRenderOption:'UNFORMATTED_VALUE',dateTimeRenderOption:'SERIAL_NUMBER'
      });
      const ranges=response.valueRanges||[];
      if (ranges.length!==spec.ranges.length) throw new Error('Неожиданный ответ Google Sheets.');
      raw[key]=ranges.map(r=>r.values||[]);
      if (spec.caps.some((cap,i)=>raw[key][i].length>=cap)) throw new Error('Достигнута граница настроенного диапазона.');
    }
    const data=NssdCore.normalize(raw);
    if (!data.operators.length) throw new Error('Операционные данные отсутствуют.');
    const fresh={syncedAt:new Date().toISOString(),data};
    try { writeCache_(cache,cacheKey,fresh); } catch (_) { console.warn('Кэш Google Apps Script недоступен.'); }
    return fresh;
  } catch (error) {
    console.warn('Синхронизация не выполнена.');
    if (old&&!refresh) return old;
    const configured=activeSources.every(([,s])=>props.getProperty(s.property));
    throw new Error(configured?'Не удалось получить данные из Google Таблиц.':'Добавьте ID источников в свойства проекта.');
  } finally {
    lock.releaseLock();
  }
}

function readCache_(cache,key) {
  try {
    const index=JSON.parse(cache.get(key)||'null');
    if (!index) return null;
    const chunks=cache.getAll(index);
    if (!index.every(k=>chunks[k])) return null;
    const compressed=Utilities.newBlob(Utilities.base64Decode(index.map(k=>chunks[k]).join('')),'application/gzip');
    return JSON.parse(Utilities.ungzip(compressed).getDataAsString('UTF-8'));
  } catch (_) {return null;}
}

function writeCache_(cache,key,snapshot) {
  const encoded=Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(snapshot),'application/json')).getBytes());
  const parts=encoded.match(/.{1,85000}/g);
  if (!parts||parts.length>12) return;
  const token=Utilities.getUuid();
  const keys=parts.map((_,i)=>token+'-'+i);
  cache.putAll(Object.fromEntries(keys.map((k,i)=>[k,parts[i]])),21600);
  cache.put(key,JSON.stringify(keys),21600);
}
