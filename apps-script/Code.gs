function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('NSSD · Аналитика колл-центра');
}

function rpc(action, payload) {
  const props = PropertiesService.getScriptProperties();
  const now = Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd');
  const targets = {
    contracts: Number(props.getProperty('TARGET_CONTRACTS')) || 250,
    paid: Number(props.getProperty('TARGET_PAID')) || 125
  };
  if (action === 'targets') return targets;
  if (action === 'saveTargets') {
    const {contracts,paid}=payload || {};
    if (![contracts,paid].every(n=>Number.isSafeInteger(n)&&n>0&&n<=1000000)) throw new Error('Некорректные цели.');
    props.setProperties({TARGET_CONTRACTS:String(contracts),TARGET_PAID:String(paid)});
    return {contracts,paid};
  }
  if (!['session','refresh','dashboard'].includes(action)) throw new Error('Неизвестная операция.');
  const snapshot = readSnapshot_(props, action === 'refresh');
  if (action === 'refresh') return {syncedAt:snapshot.syncedAt};
  if (action === 'session') {
    const last = snapshot.data.operators.map(r=>r.date).filter(date=>date<=now).sort().pop() || now;
    return {role:'admin',csrf:'',range:{start:last.slice(0,8)+'01',end:last},filters:NssdCore.filters(snapshot.data)};
  }
  const query = NssdCore.parseQuery(payload || {});
  if (!query) throw new Error('Проверьте даты.');
  return Object.assign(NssdCore.dashboard(snapshot.data,query,now,targets), {
    syncedAt:snapshot.syncedAt, stale:Date.now()-Date.parse(snapshot.syncedAt)>300000
  });
}

function readSnapshot_(props, refresh) {
  const cache=CacheService.getUserCache();
  const old=readCache_(cache);
  if (old&&Date.now()-Date.parse(old.syncedAt)<(refresh?30000:300000)) return old;
  const lock=LockService.getUserLock();
  lock.waitLock(12000);
  try {
    const current=readCache_(cache);
    if (current&&Date.now()-Date.parse(current.syncedAt)<(refresh?30000:300000)) return current;
    const raw={};
    for (const [key,spec] of Object.entries(NssdCore.sourceSpec)) {
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
    try { writeCache_(cache,fresh); } catch (_) { console.warn('Кэш Google Apps Script недоступен.'); }
    return fresh;
  } catch (error) {
    console.warn('Синхронизация не выполнена.');
    if (old&&!refresh) return old;
    const configured=Object.values(NssdCore.sourceSpec).every(s=>props.getProperty(s.property));
    throw new Error(configured?'Не удалось получить данные из Google Таблиц.':'Добавьте четыре ID таблиц в свойства проекта.');
  } finally {
    lock.releaseLock();
  }
}

function readCache_(cache) {
  try {
    const index=JSON.parse(cache.get('nssd-snapshot-v1')||'null');
    if (!index) return null;
    const chunks=cache.getAll(index);
    if (!index.every(k=>chunks[k])) return null;
    const compressed=Utilities.newBlob(Utilities.base64Decode(index.map(k=>chunks[k]).join('')),'application/gzip');
    return JSON.parse(Utilities.ungzip(compressed).getDataAsString('UTF-8'));
  } catch (_) {return null;}
}

function writeCache_(cache,snapshot) {
  const encoded=Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(snapshot),'application/json')).getBytes());
  const parts=encoded.match(/.{1,85000}/g);
  if (!parts||parts.length>12) return;
  const token=Utilities.getUuid();
  const keys=parts.map((_,i)=>token+'-'+i);
  cache.putAll(Object.fromEntries(keys.map((k,i)=>[k,parts[i]])),21600);
  cache.put('nssd-snapshot-v1',JSON.stringify(keys),21600);
}
