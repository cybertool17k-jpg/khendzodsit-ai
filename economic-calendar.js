const econApi='https://showmytrades.com/api/public/calendar/v1?currency=USD%2CGBP%2CJPY&impact=high%2Cmedium%2Clow&days=14';
let econEvents=[];
window.khEconomicEvents=econEvents;
let econPeriod='upcoming';
let econBusy=false;
let econLastUpdated=0;
const econSelected=new Set(['USD','GBP','JPY','ZAR']);
const econZone='Africa/Johannesburg';
const econNow=()=>Date.now();
function econSastDay(value){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:econZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value);
  const get=t=>Number(parts.find(x=>x.type===t)?.value);
  return Date.UTC(get('year'),get('month')-1,get('day'));
}
function econPeriodBounds(){
  const day=econSastDay(new Date()),weekday=new Date(day).getUTCDay(),monday=day-((weekday+6)%7)*86400000;
  if(econPeriod==='today')return [day,day+86400000];
  if(econPeriod==='week')return [monday,monday+7*86400000];
  if(econPeriod==='next-week')return [monday+7*86400000,monday+14*86400000];
  return [econNow(),econNow()+7*86400000];
}
function econValue(raw){
  const s=String(raw??'').trim().replace(/,/g,'').replace(/[$€£¥%\s]/g,'');
  const match=s.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([KMB])?$/i);if(!match)return NaN;
  return Number(match[1])*({K:1e3,M:1e6,B:1e9}[String(match[2]||'').toUpperCase()]||1);
}
function econThresholdValue(){const n=Number(document.getElementById('econThreshold').value);return Number.isFinite(n)&&n>=0?n:0.1;}
function econImpactDirection(name){
  const n=name.toUpperCase();
  if(/UNEMPLOY|JOBLESS CLAIM|CLAIMS/.test(n))return -1;
  if(/GDP|PMI|RETAIL SALES|INDUSTRIAL PRODUCTION|NONFARM PAYROLL|EMPLOYMENT|WAGES|CONFIDENCE/.test(n))return 1;
  return 0;
}
function econModel(event){
  const f=econValue(event.forecast),p=econValue(event.previous),a=econValue(event.actual),threshold=econThresholdValue(),hasFP=Number.isFinite(f)&&Number.isFinite(p),hasActual=Number.isFinite(a),change=hasFP?f-p:NaN,impact=econImpactDirection(event.title);
  const direction=hasFP?(change>0?'UP vs prev':change<0?'DOWN vs prev':'FLAT vs prev'):'NO PREDICTION';
  const ratio=hasFP&&impact!==0&&threshold>0?Math.abs(change)/threshold:0,confidence=ratio>=3?'HIGH*':ratio>=1.5?'MED*':'LOW*';
  let rationale=!hasFP?'Forecast/previous missing':Math.abs(change)<threshold?'Change below configured threshold':impact===0?'Metric direction only; macro impact ambiguous':(change>0&&impact>0)||(change<0&&impact<0)?'Rule suggests stronger activity':'Rule suggests weaker activity';
  let verification=hasActual&&hasFP&&Math.abs(change)>=threshold?(a===p?'VERIFIED: FLAT':Math.sign(a-p)===Math.sign(change)?'VERIFIED: MATCH':'VERIFIED: MISMATCH'):hasActual?'ACTUAL AVAILABLE':'PENDING ACTUAL';
  const eventDelta=hasFP&&hasActual?a-f:change,strength=impact!==0&&eventDelta!==0&&Math.abs(eventDelta)>=threshold?((eventDelta>0&&impact>0)||(eventDelta<0&&impact<0)?1:-1):0;
  const markets={XAUUSD:'NO READ',NAS100:'NO READ',US30:'NO MODEL',GER30:'NO MODEL',OIL:'NO MODEL',DXY:'NO MODEL'};
  if(strength){markets.NAS100=strength>0?'SELL':'BUY';markets.XAUUSD=strength>0?'SELL':'BUY';if(event.currency==='USD')markets.DXY=strength>0?'BUY':'SELL';}
  return {direction,confidence,rationale,verification,markets,hasFP,change,threshold};
}
function econDisplayTime(event){
  if(!event.time)return 'Time TBD';
  return new Intl.DateTimeFormat('en-ZA',{timeZone:econZone,weekday:'short',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(event.time))+' SAST';
}
function econVerifiedSummary(){
  const done=econEvents.filter(e=>{const f=econValue(e.forecast),p=econValue(e.previous),a=econValue(e.actual),threshold=econThresholdValue();return Number.isFinite(f)&&Number.isFinite(p)&&Number.isFinite(a)&&Math.abs(f-p)>=threshold;});
  const hits=done.filter(e=>Math.sign(econValue(e.forecast)-econValue(e.previous))===Math.sign(econValue(e.actual)-econValue(e.previous))).length;
  document.getElementById('econAccuracy').textContent=done.length?`${Math.round(100*hits/done.length)}%`:'—';
  document.getElementById('econAccuracySample').textContent=done.length?`${hits} of ${done.length} releases · current feed`:'No released events with comparable values';
}
function econRender(){
  const rows=document.getElementById('econRows'),[from,to]=econPeriodBounds(),impact=document.getElementById('econImpact').value,threshold=econThresholdValue(),changedOnly=document.getElementById('econChanged').checked;
  const rank={low:1,medium:2,high:3},events=econEvents.filter(e=>{const ts=Date.parse(e.time);if(!Number.isFinite(ts)||ts<from||ts>=to||!econSelected.has(e.currency))return false;if(impact!=='all'&&(rank[e.impact]||0)<(rank[impact]||3))return false;const f=econValue(e.forecast),p=econValue(e.previous);return !changedOnly||(Number.isFinite(f)&&Number.isFinite(p)&&Math.abs(f-p)>=threshold);});
  econVerifiedSummary();
  if(!events.length){const zarOnly=econSelected.size===1&&econSelected.has('ZAR');rows.innerHTML=`<div class="news-empty"><span>◷</span><h2>No matching events</h2><p>${zarOnly?'The live calendar source does not include ZAR releases.':'Try another period, lower the impact filter, or turn off “Changed estimates only”.'}</p></div>`;return;}
  rows.innerHTML=events.slice(0,80).map(e=>{
    const m=econModel(e),values=`F: ${e.forecast||'—'}  ·  P: ${e.previous||'—'}  ·  A: ${e.actual||'PENDING'}`,verifyClass=m.verification.includes('MATCH')&&!m.verification.includes('MISMATCH')?'good':m.verification.includes('MISMATCH')?'bad':'muted';
    const chips=Object.entries(m.markets).map(([symbol,read])=>`<span class="econ-market ${read==='BUY'?'buy':read==='SELL'?'sell':'none'}"><b>${symbol}</b> ${read}</span>`).join('');
    return `<article class="econ-event"><div class="econ-event-main"><div class="econ-event-meta"><time>${econDisplayTime(e)}</time><span class="econ-currency">${e.currency}</span><span class="econ-impact-tag ${e.impact}">${e.impact.toUpperCase()}</span>${e.status&&e.status!=='scheduled'?`<span class="econ-moved">${e.status.toUpperCase()}</span>`:''}</div><h3>${escapeHtml(e.title)}</h3><p class="econ-values">${escapeHtml(values)}</p><p class="econ-event-model ${m.direction.startsWith('UP')?'buy':m.direction.startsWith('DOWN')?'sell':'muted'}">MODEL ${escapeHtml(m.direction)} · CONF ${m.confidence}</p><p class="econ-rationale">${escapeHtml(m.rationale)} · <span class="${verifyClass}">${escapeHtml(m.verification)}</span></p></div><div class="econ-market-reads">${chips}</div></article>`;
  }).join('');
}
async function econRefresh(){
  if(econBusy)return;econBusy=true;const button=document.getElementById('econRefresh');button.disabled=true;document.getElementById('econStatus').textContent='Fetching economic releases…';
  try{
    const response=await fetch(econApi,{cache:'no-store'});if(!response.ok)throw new Error(`Calendar request failed (${response.status}).`);
    const payload=await response.json();if(!Array.isArray(payload.events))throw new Error('Calendar response did not contain an events list.');
    econEvents=payload.events;window.khEconomicEvents=econEvents;window.dispatchEvent(new CustomEvent('economic-calendar-updated',{detail:econEvents}));econLastUpdated=Date.now();document.getElementById('econUpdated').textContent=`Updated ${new Date().toLocaleTimeString()}`;
    document.getElementById('econStatus').textContent=`${econEvents.length} releases loaded · times shown in SAST · public calendar by ShowMyTrades`;
    econRender();
  }catch(error){document.getElementById('econStatus').textContent=`Calendar unavailable: ${error.message} Use the RSS headlines below while it reconnects.`;if(!econEvents.length)document.getElementById('econUpdated').textContent='No calendar data';econRender();}
  finally{econBusy=false;button.disabled=false;}
}
document.querySelectorAll('.econ-tab').forEach(button=>button.addEventListener('click',()=>{econPeriod=button.dataset.period;document.querySelectorAll('.econ-tab').forEach(tab=>{const active=tab===button;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));});econRender();}));
document.querySelectorAll('.currency-chip').forEach(button=>button.addEventListener('click',()=>{const code=button.dataset.currency;if(econSelected.has(code))econSelected.delete(code);else econSelected.add(code);button.classList.toggle('active',econSelected.has(code));button.setAttribute('aria-pressed',String(econSelected.has(code)));econRender();}));
document.getElementById('econImpact').addEventListener('change',econRender);
document.getElementById('econChanged').addEventListener('change',econRender);
document.getElementById('econThreshold').addEventListener('input',econRender);
document.getElementById('econRefresh').addEventListener('click',econRefresh);
econRefresh();
setInterval(()=>{if(!document.hidden)econRefresh();},15*60*1000);
