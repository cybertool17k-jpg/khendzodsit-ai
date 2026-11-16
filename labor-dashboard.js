const laborSeries={payroll:'PAYEMS',unemployment:'UNRATE',earnings:'CES0500000003'};
const laborCacheKey='khendzodsit-us-labor-v1';
const laborRefreshMs=3*60*1000;
let laborData=[];
let laborCalendarEvents=window.khEconomicEvents||[];
let laborLastUpdate=0;
let laborLastAttempt=0;
let laborLoading=false;
let laborAutoTimer=null;
function laborNumber(value){
  const s=String(value??'').trim().replace(/,/g,'').replace(/[$€£¥%\s]/g,''),m=s.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([KMB])?$/i);
  if(!m)return NaN;return Number(m[1])*({K:1e3,M:1e6,B:1e9}[String(m[2]||'').toUpperCase()]||1);
}
function laborRowsFromCsv(body){
  const lines=body.replace(/^\uFEFF/,'').trim().split(/\r?\n/);if(lines.length<14||/^</.test(lines[0]))throw new Error('FRED returned an invalid labor CSV.');
  const header=lines[0].split(',').map(x=>x.trim()),dateIndex=header.indexOf('observation_date'),indices=Object.fromEntries(Object.entries(laborSeries).map(([key,id])=>[key,header.indexOf(id)]));
  if(dateIndex<0||Object.values(indices).some(i=>i<0))throw new Error('FRED CSV is missing a labor series.');
  const data={payroll:new Map(),unemployment:new Map(),earnings:new Map()};
  for(const line of lines.slice(1)){const fields=line.trim().split(','),date=fields[dateIndex]||'',month=date.slice(0,7);if(!/^\d{4}-\d{2}$/.test(month))continue;for(const key of Object.keys(data)){const raw=(fields[indices[key]]||'').trim(),value=raw===''||raw==='.'?NaN:Number(raw);if(Number.isFinite(value))data[key].set(month,value);}}
  const maps=data,months=[...maps.payroll.keys()].filter(m=>maps.unemployment.has(m)&&maps.earnings.has(m)).sort().reverse();
  if(months.length<13)throw new Error('BLS did not return enough monthly observations.');
  return months.map((month,i)=>{
    const prev=months[i+1],yearAgo=`${Number(month.slice(0,4))-1}${month.slice(4)}`,pay=maps.payroll.get(month),priorPay=prev?maps.payroll.get(prev):NaN,ahe=maps.earnings.get(month),priorAhe=prev?maps.earnings.get(prev):NaN,yearAhe=maps.earnings.get(yearAgo);
    return {month,jobs:Number.isFinite(priorPay)?pay-priorPay:NaN,unemployment:maps.unemployment.get(month),ahe,mom:Number.isFinite(priorAhe)&&priorAhe!==0?(ahe/priorAhe-1)*100:NaN,yoy:Number.isFinite(yearAhe)&&yearAhe!==0?(ahe/yearAhe-1)*100:NaN};
  });
}
function laborCalendarMatch(row,test){
  const candidates=laborCalendarEvents.filter(e=>e.currency==='USD'&&test((e.title||'').toLowerCase()));
  return candidates.find(e=>(e.period||'').slice(0,7)===row.month)||null;
}
function laborSurprise(actual,expected,lowerIsStrong=false){
  if(!Number.isFinite(actual)||!Number.isFinite(expected))return 'NO FORECAST';
  if(Math.abs(actual-expected)<0.0001)return 'IN LINE';
  return (lowerIsStrong?actual<expected:actual>expected)?'STRONG':'WEAK';
}
function laborMedian(values){const clean=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!clean.length)return NaN;const mid=Math.floor(clean.length/2);return clean.length%2?clean[mid]:(clean[mid-1]+clean[mid])/2;}
function laborMean(values){const clean=values.filter(Number.isFinite);return clean.length?clean.reduce((sum,x)=>sum+x,0)/clean.length:NaN;}
function laborFmt(value,decimals=1){return Number.isFinite(value)?value.toLocaleString(undefined,{minimumFractionDigits:decimals,maximumFractionDigits:decimals}):'—';}
function laborCalendarForecast(event,kind){
  if(!event)return NaN;
  const value=laborNumber(event.forecast);if(!Number.isFinite(value))return NaN;
  if(kind==='jobs'&&Math.abs(value)>=10000)return value/1000;
  return value;
}
function laborRender(){
  const rows=document.getElementById('laborRows'),latest=laborData[0];
  if(!latest){rows.innerHTML='<tr><td colspan="6" class="empty-row">No labor history is cached yet. Refresh to load BLS data.</td></tr>';return;}
  const label=month=>{const [year,m]=month.split('-').map(Number);return new Intl.DateTimeFormat('en-US',{month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(year,m-1,1)));};
  rows.innerHTML=laborData.slice(0,12).map(r=>`<tr><td>${label(r.month)}</td><td class="${r.jobs>=0?'up':'down'}">${Number.isFinite(r.jobs)?`${r.jobs>0?'+':''}${laborFmt(r.jobs,0)}K`:'—'}</td><td>${laborFmt(r.unemployment,1)}%</td><td>$${laborFmt(r.ahe,2)}</td><td>${Number.isFinite(r.mom)?`${r.mom>0?'+':''}${laborFmt(r.mom,2)}%`:'—'}</td><td>${Number.isFinite(r.yoy)?`${r.yoy>0?'+':''}${laborFmt(r.yoy,2)}%`:'—'}</td></tr>`).join('');
  document.getElementById('laborReportMonth').textContent=`LATEST REPORT · ${label(latest.month).toUpperCase()}`;
  const nfpEvent=laborCalendarMatch(latest,t=>/non.?farm payroll|employment situation/.test(t)),unempEvent=laborCalendarMatch(latest,t=>/unemployment rate/.test(t)),aheEvent=laborCalendarMatch(latest,t=>/average hourly earnings/.test(t)&&(/m\/m|mom|monthly/.test(t)||!/(yoy|year.?over.?year)/.test(t)));
  const nfpForecast=laborCalendarForecast(nfpEvent,'jobs'),unempForecast=laborCalendarForecast(unempEvent,'rate'),aheForecast=laborCalendarForecast(aheEvent,'rate');
  const trailing=laborData.slice(1,13),nfpTrend=laborMedian(trailing.map(r=>r.jobs)),unempTrend=laborMean(trailing.map(r=>r.unemployment)),aheTrend=laborMedian(trailing.map(r=>r.mom));
  const nfpExpected=Number.isFinite(nfpForecast)?nfpForecast:nfpTrend,unempExpected=Number.isFinite(unempForecast)?unempForecast:unempTrend,aheExpected=Number.isFinite(aheForecast)?aheForecast:aheTrend;
  const nfpSignal=laborSurprise(latest.jobs,nfpExpected),unempSignal=laborSurprise(latest.unemployment,unempExpected,true),aheSignal=laborSurprise(latest.mom,aheExpected);
  const setSignal=(id,signal)=>{const el=document.getElementById(id);el.textContent=signal;el.className=`labor-${signal==='STRONG'?'strong':signal==='WEAK'?'weak':'neutral'}`;};
  setSignal('laborNfpSignal',nfpSignal);setSignal('laborUnempSignal',unempSignal);setSignal('laborAheSignal',aheSignal);
  const basis=(forecast,label)=>Number.isFinite(forecast)?label:'12M trend';
  document.getElementById('laborNfpValues').textContent=`Actual ${Number.isFinite(latest.jobs)?`${latest.jobs>0?'+':''}${laborFmt(latest.jobs,0)}K`:'—'} · ${basis(nfpForecast,'Forecast')} ${Number.isFinite(nfpExpected)?`${nfpExpected>0?'+':''}${laborFmt(nfpExpected,0)}K`:'—'}`;
  document.getElementById('laborUnempValues').textContent=`Actual ${laborFmt(latest.unemployment,1)}% · ${basis(unempForecast,'Forecast')} ${Number.isFinite(unempExpected)?`${laborFmt(unempExpected,1)}%`:'—'}`;
  document.getElementById('laborAheValues').textContent=`Actual ${Number.isFinite(latest.mom)?`${latest.mom>0?'+':''}${laborFmt(latest.mom,2)}%`:'—'} · ${basis(aheForecast,'12M trend')} ${Number.isFinite(aheExpected)?`${aheExpected>0?'+':''}${laborFmt(aheExpected,2)}%`:'—'}`;
  const signals=[nfpSignal,unempSignal,aheSignal],strong=signals.filter(x=>x==='STRONG').length,weak=signals.filter(x=>x==='WEAK').length,overall=strong>weak?'STRONG':weak>strong?'WEAK':signals.every(x=>x==='NO FORECAST')?'NO DATA':'MIXED / IN LINE';
  setSignal('laborOverall',overall);document.getElementById('laborOverallDetail').textContent=`${strong} strong · ${weak} weak · Compared with consensus where available; otherwise the trailing trend.`;
  if(!laborLoading){const age=laborLastUpdate?Math.max(0,Math.round((Date.now()-laborLastUpdate)/60000)):null;document.getElementById('laborStatus').textContent=age===null?'Latest published BLS observations · auto refresh every 3 minutes':`Latest published BLS observations · fetched ${age<1?'just now':`${age} min ago`} · auto refresh every 3 minutes`;}
}
function laborLoadCache(){
  try{const cache=JSON.parse(localStorage.getItem(laborCacheKey)||'null');if(cache&&Array.isArray(cache.rows)){laborData=cache.rows;laborLastUpdate=Number(cache.updated)||0;document.getElementById('laborUpdated').textContent=laborLastUpdate?`Updated ${new Date(laborLastUpdate).toLocaleString()}`:'Cached';laborRender();return Date.now()-laborLastUpdate<laborRefreshMs;}}catch{}
  return false;
}
async function laborRefresh(force=false){
  if(laborLoading)return;if(!force&&laborLoadCache())return;
  laborLoading=true;laborLastAttempt=Date.now();document.getElementById('laborRefresh').disabled=true;document.getElementById('laborStatus').textContent='Fetching the latest published labor series…';
  const now=new Date(),endYear=now.getUTCFullYear();
  try{
    const params=new URLSearchParams({id:Object.values(laborSeries).join(','),cosd:`${endYear-4}-01-01`}),fredUrl=`https://fred.stlouisfed.org/graph/fredgraph.csv?${params}`;
    const response=await fetch(`https://proxy.cors.dev/${fredUrl}`,{cache:'no-store'});if(!response.ok)throw new Error(`FRED feed returned HTTP ${response.headers.get('X-Cors-Error')||response.status}`);
    const rows=laborRowsFromCsv(await response.text());laborData=rows;laborLastUpdate=Date.now();
    try{localStorage.setItem(laborCacheKey,JSON.stringify({updated:laborLastUpdate,rows}));}catch{}
    document.getElementById('laborUpdated').textContent=`Updated ${new Date(laborLastUpdate).toLocaleString()}`;laborLoading=false;laborRender();
  }catch(error){document.getElementById('laborStatus').textContent=`Labor data unavailable: ${error.message}${laborData.length?' Showing cached BLS data.':' Try refresh later.'}`;laborRender();}
  finally{laborLoading=false;document.getElementById('laborRefresh').disabled=false;}
}
function laborScheduleAutoRefresh(){
  clearTimeout(laborAutoTimer);const lastRequest=Math.max(laborLastUpdate,laborLastAttempt),delay=lastRequest?Math.max(1000,laborRefreshMs-(Date.now()-lastRequest)):laborRefreshMs;
  laborAutoTimer=setTimeout(()=>laborRefresh(true).finally(laborScheduleAutoRefresh),delay);
}
document.getElementById('laborRefresh').addEventListener('click',()=>laborRefresh(true).finally(laborScheduleAutoRefresh));
window.addEventListener('economic-calendar-updated',event=>{laborCalendarEvents=Array.isArray(event.detail)?event.detail:[];laborRender();});
laborLoadCache();laborRefresh().finally(laborScheduleAutoRefresh);document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-Math.max(laborLastUpdate,laborLastAttempt)>=laborRefreshMs){clearTimeout(laborAutoTimer);laborRefresh(true).finally(laborScheduleAutoRefresh);}});
