const $ = (id) => document.getElementById(id);
let candles = [];
let deferredInstall;
let newsItems = [];
let macroNewsItems = [];
let macroNewsBusy = false;
let currentAnalysis = null;
let liveSocket = null;
let liveMode = false;
let liveSubscriptions = new Set();
let liveHistoryLoaded = false;
let liveFailed = false;
let liveDesired = false;
let liveReconnectTimer = null;
let liveReconnectAttempt = 0;
let chartBarsVisible = 60;
let chartOffset = 0;
let chartShift = (()=>{try{return localStorage.getItem('khendzodsit-chart-shift')==='true';}catch{return false;}})();
const chartPointers = new Map();
let chartGesture = null;
let chartLastBarCount = 0;
const marketCandleData = new Map();
const marketHistoryLoaded = new Set();
const candleRequestSymbols = new Map();
const candleSubscriptionSymbols = new Map();
const failedMarketSymbols = new Set();
let signalAlertsEnabled = (()=>{try{return localStorage.getItem('khendzodsit-signal-alerts')==='true';}catch{return false;}})();
const marketSignalStates = new Map();
let resolvedDerivMarkets = [];
let nextMarketRequestId = 100;
const DERIV_PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';
const WATCHLIST = [
  {key:'XAUUSD',label:'XAUUSD · Gold/USD',codes:['frxXAUUSD'],match:/gold\s*\/\s*usd|xau\s*\/\s*usd/i},
  {key:'NAS100',label:'NAS100 · US Tech 100',codes:['OTC_NDX','US_100','NAS100'],match:/us tech 100|nasdaq 100/i},
  {key:'US30',label:'US30 · Wall Street 30',codes:['OTC_DJI','US_30','US30'],match:/wall street 30|dow jones|us 30/i},
  {key:'GER30',label:'GER30 · Germany 40',codes:['OTC_GDAXI','GER_40','DAX_40','GER30'],match:/germany\s*(30|40)|dax/i},
  {key:'OIL',label:'OIL · US Oil',codes:['WTI_OIL','frxWTIUSD','frxUSOil','USOIL','OTC_WTI'],match:/us oil|wti/i,alternate:/brent oil/i},
  {key:'DXY',label:'DXY · US Dollar Index',codes:['DXYUSD'],match:/dxy|us dollar index|dollar index/i}
];
const defaultSettings = {rangeBody:35,modelBody:35,lookback:30};
const TIMEFRAME_MS = {M1:60000,M3:180000,M5:300000,M10:600000,M15:900000,M30:1800000,H1:3600000,H2:7200000,H4:14400000,D1:86400000,W1:604800000,MN:2592000000};
let settings = readSettings();

const fmt = (n) => Number.isFinite(n) ? n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:6}) : '—';
function parseCSV(text){
  const lines=text.replace(/^\uFEFF/,'').trim().split(/\r?\n/).filter(Boolean);
  if(lines.length<3) throw new Error('Add a header row and at least two candles.');
  const split=(line)=>line.includes('\t')?line.split('\t'):line.split(',');
  const first=split(lines[0]).map(s=>s.trim().toLowerCase().replace(/[^a-z]/g,''));
  const aliases={time:['time','date','datetime','timestamp'],open:['open','o'],high:['high','h'],low:['low','l'],close:['close','c']};
  let ix={};
  for(const [key,names] of Object.entries(aliases)) ix[key]=first.findIndex(x=>names.includes(x));
  const hasHeader=Object.values(ix).every(i=>i>=0);
  if(!hasHeader) ix={time:0,open:1,high:2,low:3,close:4};
  const source=hasHeader?lines.slice(1):lines;
  const out=[];
  for(const line of source){
    const a=split(line).map(s=>s.trim().replace(/^"|"$/g,''));
    const c={time:a[ix.time]||'',open:Number(a[ix.open]),high:Number(a[ix.high]),low:Number(a[ix.low]),close:Number(a[ix.close])};
    if(Object.values(c).slice(1).every(Number.isFinite) && c.high>=Math.max(c.open,c.close) && c.low<=Math.min(c.open,c.close)) out.push(c);
  }
  if(out.length<10) throw new Error('Could not read enough valid OHLC rows. Use time, open, high, low, close columns.');
  out.sort((a,b)=>{const x=Date.parse(a.time),y=Date.parse(b.time);return Number.isFinite(x)&&Number.isFinite(y)?x-y:0;});
  return out;
}
function analyze(data){
  const n=data.length, sourceSize=Math.max(4,Math.floor(Math.sqrt(n)*1.35));
  const ranges=[];
  for(let end=sourceSize;end<=n;end+=sourceSize){
    const group=data.slice(end-sourceSize,end), hi=Math.max(...group.map(x=>x.high)),lo=Math.min(...group.map(x=>x.low));
    const first=group[0],last=group[group.length-1], body=100*Math.abs(last.close-first.open)/Math.max(hi-lo,1e-12);
    if(body>settings.rangeBody) ranges.push({start:end,hi,lo,eq:(hi+lo)/2,body,group});
  }
  const range=ranges.at(-1);
  if(!range)return {direction:0,status:'Waiting for a qualifying range candle',range:null,checks:[],details:[['Qualifying range candle','Not found']]};
  let sweep=-1,dir=0;
  for(let i=range.start;i<n;i++){
    const c=data[i],sh=c.high>range.hi&&c.close<range.hi,sl=c.low<range.lo&&c.close>range.lo;
    if(sh||sl){dir=sh&&sl?(c.close<c.open?-1:1):(sh?-1:1);sweep=i;break;}
  }
  const checks=[['Qualifying CRT range',true],['Liquidity sweep',sweep>=0],['Model #1 level found',false],['Model #1 body break',false],['Model #1 retest',false]];
  let level=null,levelAt=-1,breakAt=-1,retestAt=-1;
  if(sweep>=0){
    const bullish=dir>0;
    for(let i=sweep;i>=Math.max(0,sweep-settings.lookback);i--){const c=data[i],body=100*Math.abs(c.close-c.open)/Math.max(c.high-c.low,1e-12),opp=bullish?c.close<c.open:c.close>c.open;if(opp&&body>=settings.modelBody){level=bullish?c.high:c.low;levelAt=i;break;}}
    checks[2][1]=level!==null;
    if(level!==null){for(let i=sweep+1;i<n;i++){const c=data[i];if(breakAt<0&&((bullish&&c.close>level)||(!bullish&&c.close<level)))breakAt=i;else if(breakAt>=0&&((bullish&&c.low<=level)||(!bullish&&c.high>=level))){retestAt=i;break;}}}
    checks[3][1]=breakAt>=0;checks[4][1]=retestAt>=0;
  }
  const state=sweep<0?'RANGE FORMED · WAITING FOR SWEEP':breakAt<0?'SWEEP FOUND · WAITING FOR MODEL #1':retestAt<0?'MODEL #1 BREAK · RETEST PENDING':'MODEL #1 RETEST TOUCHED';
  const all=checks.filter(x=>x[1]).length;
  const details=[['Qualifying CRT range',`${range.body.toFixed(1)}% body`],['Liquidity sweep',sweep<0?'Not found':dir>0?'Low swept · bullish read':'High swept · bearish read'],['Model #1 level',level===null?'Not found':fmt(level)],['Body break',breakAt<0?'Waiting':data[breakAt].time||`Candle ${breakAt+1}`],['Retest',retestAt<0?'Waiting':data[retestAt].time||`Candle ${retestAt+1}`]];
  const invalid=sweep>=0&&data.slice(sweep+1).some(c=>dir<0?c.close>range.hi:c.close<range.lo);
  let status=sweep<0?'WAIT':invalid?'INVALIDATED':dir>0?'BUY':'SELL';
  let message=sweep<0?'No confirmed sweep yet. Wait for price to move beyond the range and close back inside.':invalid?'A close breached the far side of the CRT range; treat the setup as invalidated.':breakAt<0?'Sweep confirmed. Wait for a strong opposite candle level to break before considering a setup.':retestAt<0?'Model #1 level has broken. The retest has not appeared in the loaded candles yet.':'The Model #1 level broke and price returned to test it in the loaded data.';
  return {direction:invalid?0:dir,rawDirection:dir,status,message,range,sweep,level,levelAt,breakAt,retestAt,checks,all,state,details,invalid};
}
function render(){
  if(candles.length>chartLastBarCount&&chartOffset>0)chartOffset+=candles.length-chartLastBarCount;
  chartLastBarCount=candles.length;
  chartOffset=Math.min(chartOffset,Math.max(0,candles.length-chartBarsVisible));
  $('barCount').textContent=`${candles.length} candles`;
  $('dataNote').textContent=candles.length?(liveMode?`Deriv live ${$('liveTimeframe').value} · ${candles.length} bars`:`OHLC loaded · ${candles.length} bars`):'No market data loaded';
  $('chartSymbol').textContent=$('symbol').selectedOptions[0]?.dataset.watch||$('symbol').value||'MARKET';
  $('chartCount').textContent=`${candles.length} candles`;
  renderMacroSnapshot();
  if(!candles.length){currentAnalysis=null;renderSignals();drawChart();return;}
  const a=analyze(candles),r=a.range;currentAnalysis=a;
  $('rangeHigh').textContent=fmt(r?.hi);$('rangeLow').textContent=fmt(r?.lo);$('equilibrium').textContent=fmt(r?.eq);
  $('signalDirection').textContent=a.direction===0?(a.invalid?'SETUP INVALID':'WAIT'):a.direction>0?'BUY':'SELL';
  $('signalStatus').textContent=a.message;$('signalReason').textContent=a.state;
  $('statusPill').textContent=a.status;$('statusPill').className=`status-pill ${a.direction>0?'bull':a.direction<0?'bear':'neutral'}`;
  $('signalIcon').textContent=a.direction>0?'↗':a.direction<0?'↘':'⌁';$('signalIcon').className=`signal-icon ${a.direction>0?'bull':a.direction<0?'bear':''}`;
  $('checkCount').textContent=`${a.all||0} / ${a.checks.length}`;$('meterFill').style.width=`${(a.all||0)/a.checks.length*100}%`;
  $('detailList').innerHTML=a.details.map((d,i)=>`<li><i class="detail-dot ${a.checks[i]?.[1]?'done':''}"></i><span>${d[0]}</span><b>${d[1]}</b></li>`).join('');
  renderSignals();
  const recent=candles.slice(-8).reverse();
  $('candleRows').innerHTML=recent.map(c=>`<tr><td>${escapeHtml(c.time||'—')}</td><td>${fmt(c.open)}</td><td>${fmt(c.high)}</td><td>${fmt(c.low)}</td><td>${fmt(c.close)}</td><td class="${c.close>=c.open?'up':'down'}">${c.close>=c.open?'BULL':'BEAR'}</td></tr>`).join('');
  drawChart();
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));}
$('csvInput').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;disconnectLive();marketCandleData.clear();try{candles=parseCSV(await f.text());chartOffset=0;chartBarsVisible=60;$('dataNote').textContent=`Loaded ${f.name}`;render();}catch(err){$('dataNote').textContent=err.message;}e.target.value='';});
$('demoBtn').addEventListener('click',()=>{disconnectLive();marketCandleData.clear();candles=demoData();chartOffset=0;chartBarsVisible=60;render();});
function demoData(){
  const out=[],start=Date.UTC(2025,3,2,0,0);let p=1.0810;
  for(let i=0;i<72;i++){
    let o=p,step=Math.sin(i*1.7)*.00008,c=o+step,h=Math.max(o,c)+.00011,l=Math.min(o,c)-.00011;
    if(i>=22&&i<=32){o=1.0800+(i-22)*.00027;c=o+.00017;h=Math.max(o,c)+.00008;l=Math.min(o,c)-.00008;}
    if(i===30){o=1.0820;c=1.08335;h=1.08345;l=1.08195;}
    if(i===33){o=1.0830;c=1.0828;h=1.08385;l=1.08265;}
    if(i===34){o=1.0828;c=1.08255;h=1.0829;l=1.08248;}
    if(i===35){o=1.08275;c=1.0829;h=1.08302;l=1.0826;}
    if(i>=36){o=1.0828+Math.sin(i)*.00005;c=o+Math.cos(i*1.3)*.00004;h=Math.max(o,c)+.00008;l=Math.min(o,c)-.00008;}
    p=c;out.push({time:new Date(start+i*3600000).toISOString().slice(0,16).replace('T',' '),open:o,high:h,low:l,close:c});
  }
  return out;
}

function readSettings(){try{return {...defaultSettings,...JSON.parse(localStorage.getItem('khendzodsit-settings')||'{}')};}catch{return {...defaultSettings};}}
function saveSettings(){
  settings={rangeBody:clampNumber($('rangeThreshold').value,1,95,defaultSettings.rangeBody),modelBody:clampNumber($('modelThreshold').value,1,95,defaultSettings.modelBody),lookback:clampNumber($('lookbackSetting').value,1,200,defaultSettings.lookback)};
  $('rangeThreshold').value=settings.rangeBody;$('modelThreshold').value=settings.modelBody;$('lookbackSetting').value=settings.lookback;
  try{localStorage.setItem('khendzodsit-settings',JSON.stringify(settings));}catch{}
  $('settingsNote').textContent='Settings saved on this device.';render();
}
function clampNumber(v,min,max,fallback){const n=Number(v);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;}
function initSettings(){ $('rangeThreshold').value=settings.rangeBody;$('modelThreshold').value=settings.modelBody;$('lookbackSetting').value=settings.lookback; }

function renderSignals(){
  renderMarketSignalBoard();
  const a=currentAnalysis;
  if(!a){$('signalsTitle').textContent='Waiting for candle data';$('signalsMessage').textContent='Import candles or load the demo to see a signal breakdown.';$('signalsBadge').textContent='WAITING';$('signalsBadge').className='status-pill neutral';$('signalTimeframe').textContent='No data';$('signalsScore').textContent='0 / 5';$('signalsList').innerHTML='<li class="empty-row">Load candle data to calculate conditions.</li>';return;}
  const direction=a.direction===0?(a.invalid?'SETUP INVALID':'WAIT'):a.direction>0?'BUY':'SELL';
  $('signalsTitle').textContent=direction;$('signalsMessage').textContent=a.message;$('signalsBadge').textContent=a.status;$('signalsBadge').className=`status-pill ${a.direction>0?'bull':a.direction<0?'bear':'neutral'}`;$('signalTimeframe').textContent=`${candles.length} loaded bars`;$('signalsScore').textContent=`${a.all||0} / ${a.checks.length||5}`;
  $('signalsList').innerHTML=a.details.map((d,i)=>`<li><i class="detail-dot ${a.checks[i]?.[1]?'done':''}"></i><span>${d[0]}</span><b>${d[1]}</b></li>`).join('');
}

function renderMarketSignalBoard(){
  const grid=$('marketSignalGrid');if(!grid)return;
  const selectedKey=$('symbol').selectedOptions[0]?.dataset.watch||'XAUUSD',available=new Set(resolvedDerivMarkets.map(x=>x.symbol));
  const cards=WATCHLIST.map(item=>{
    const symbol=resolvedDerivMarkets.find(x=>x.key===item.key)?.symbol||item.codes[0];
    const data=marketCandleData.get(symbol)||(item.key===selectedKey&&candles.length?candles:null);
    const unavailable=resolvedDerivMarkets.length>0&&!available.has(symbol),failed=failedMarketSymbols.has(symbol);
    if(unavailable||failed)return `<article class="market-signal unavailable"><div><b>${escapeHtml(item.key)}</b><small>${unavailable?'Not available on this Deriv feed':'Live feed rejected this market'}</small></div><strong>—</strong></article>`;
    if(!data?.length)return `<article class="market-signal waiting"><div><b>${escapeHtml(item.key)}</b><small>${liveDesired?'Waiting for live candles':'Connect to Deriv for live signals'}</small></div><strong>WAIT</strong></article>`;
    const a=analyze(data),side=a.direction>0?'BUY':a.direction<0?'SELL':a.invalid?'INVALID':'WAIT',tone=a.direction>0?'buy':a.direction<0?'sell':'waiting',last=data.at(-1),digits=Math.min(6,Math.max(2,(String(last.close).split('.')[1]||'').length)),time=last.time?new Date(last.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'—';
    const brief=a.invalid?'Setup invalidated':a.direction!==0?(a.retestAt>=0?'Model #1 retest':'Sweep setup'):a.state||'No confirmed sweep';
    const feedLabel=marketCandleData.has(symbol)?(liveSocket?.readyState===WebSocket.OPEN?'LIVE':'CACHED'):'LOCAL';
    const plan=marketTradePlan(data,a),price=value=>formatMarketPrice(value,digits);
    updateMarketSignalAlert(item,data,a,plan);
    const planMarkup=plan?`<div class="market-trade-plan"><span>ENTRY <b>${price(plan.entry)}</b><small>${escapeHtml(plan.entryRule)}</small></span><span>STOP <b>${price(plan.stop)}</b></span><span>TP1 <b>${price(plan.target1)}</b></span><span>TP2 <b>${price(plan.target2)}</b></span></div>`:'';
    return `<article class="market-signal ${tone}"><div class="market-signal-head"><b>${escapeHtml(item.key)}</b><small>${feedLabel} · ${escapeHtml($('liveTimeframe').value)} · ${data.length} bars</small></div><div class="market-signal-read"><strong>${side}</strong><span>${fmt(last.close)}</span></div><div class="market-signal-foot"><span>${escapeHtml(brief)}</span><time>${escapeHtml(time)}</time></div>${planMarkup}</article>`;
  }).join('');
  grid.innerHTML=cards;
  const liveCount=resolvedDerivMarkets.filter(x=>marketCandleData.has(x.symbol)).length;
  $('marketSignalsStatus').textContent=liveCount?`${liveCount} / 6 ${liveSocket?.readyState===WebSocket.OPEN?'live':'cached'}`:'Waiting for live candles';
}
function formatMarketPrice(value,digits){return Number.isFinite(value)?value.toLocaleString(undefined,{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—';}
function marketTradePlan(data,a){
  if(!a||!a.direction||a.invalid||!a.range||a.sweep<0)return null;
  const direction=a.direction,last=data.at(-1),swept=data[a.sweep],entry=Number.isFinite(a.level)?a.level:last.close,atrRows=data.slice(-15),atr=atrRows.length?atrRows.reduce((sum,c)=>sum+c.high-c.low,0)/atrRows.length:Math.abs(last.close)*.001;
  let stop=direction>0?Math.min(a.range.lo,swept.low)-atr*.1:Math.max(a.range.hi,swept.high)+atr*.1;
  let risk=Math.abs(entry-stop);if(!Number.isFinite(risk)||risk<=0){risk=Math.max(atr*.5,Math.abs(entry)*.0001);stop=entry-direction*risk;}
  const entryRule=a.level===null?'provisional current-price reference':a.retestAt>=0?'Model #1 retest level':'wait for Model #1 break and retest';
  return {direction,entry,stop,target1:entry+direction*risk,target2:entry+direction*risk*2,entryRule};
}
function updateMarketSignalAlert(item,data,a,plan){
  if(!marketCandleData.has(resolvedDerivMarkets.find(x=>x.key===item.key)?.symbol||'')||liveSocket?.readyState!==WebSocket.OPEN)return;
  const key=plan?`${plan.direction>0?'BUY':'SELL'}:${a.level===null?'pending':a.level}`:a.invalid?'INVALID':'WAIT',previous=marketSignalStates.get(item.key);marketSignalStates.set(item.key,key);
  if(!signalAlertsEnabled||!('Notification'in window)||Notification.permission!=='granted'||previous===key)return;
  if(plan){sendMarketSignalNotification(item,data,plan);return;}
  if(previous&&previous!=='WAIT'&&previous!=='INVALID'&&a.invalid)sendMarketInvalidNotification(item);
}
function signalNotify(title,body,tag){
  if(!('Notification'in window)||Notification.permission!=='granted')return;
  const options={body,tag,renotify:true,icon:'./icon-192.png',badge:'./icon-192.png',data:{url:'./'}};
  if('serviceWorker'in navigator&&navigator.serviceWorker.controller)navigator.serviceWorker.ready.then(reg=>reg.showNotification(title,options)).catch(()=>new Notification(title,options));
  else new Notification(title,options);
}
function sendMarketSignalNotification(item,data,plan){
  const digits=Math.min(6,Math.max(2,(String(data.at(-1).close).split('.')[1]||'').length)),p=v=>formatMarketPrice(v,digits),side=plan.direction>0?'BUY':'SELL';
  signalNotify(`${item.key} ${side} setup`,`Entry ${p(plan.entry)} · Stop ${p(plan.stop)} · TP1 ${p(plan.target1)} · TP2 ${p(plan.target2)}. ${plan.entryRule}.`,`${item.key}-${side}`);
}
function sendMarketInvalidNotification(item){signalNotify(`${item.key} setup invalidated`,'Price closed beyond the CRT invalidation level. Reassess the setup.',`${item.key}-invalid`);}
async function toggleSignalAlerts(){
  if(!('Notification'in window)){$('signalAlertsStatus').textContent='Browser notifications are not supported on this device.';return;}
  if(signalAlertsEnabled&&'Notification'in window&&Notification.permission==='granted'){signalAlertsEnabled=false;try{localStorage.setItem('khendzodsit-signal-alerts','false');}catch{}syncSignalAlertControls();return;}
  let permission=Notification.permission;if(permission==='default')permission=await Notification.requestPermission();
  if(permission!=='granted'){$('signalAlertsStatus').textContent=permission==='denied'?'Notifications are blocked in browser settings. Enable them there to receive alerts.':'Notification permission was not granted.';return;}
  signalAlertsEnabled=true;try{localStorage.setItem('khendzodsit-signal-alerts','true');}catch{}syncSignalAlertControls();marketSignalStates.clear();renderMarketSignalBoard();
  signalNotify('Khendzodsit AI alerts enabled','New live BUY/SELL setups will include entry, stop, and target levels.','signal-alerts-enabled');
}
function syncSignalAlertControls(){
  const button=$('signalAlertsToggle');if(!button)return;const supported='Notification'in window,granted=supported&&Notification.permission==='granted',active=signalAlertsEnabled&&granted;button.textContent=active?'Disable alerts':'Enable alerts';button.setAttribute('aria-pressed',String(active));
  $('signalAlertsStatus').textContent=!supported?'Browser notifications are not supported on this device.':active?'Alerts enabled · new live setups include entry, stop, and targets.':Notification.permission==='denied'?'Notifications are blocked in browser settings. Enable them there to receive alerts.':granted?'Alerts are off. Enable them to receive new BUY/SELL setups.':'Allow browser notifications to receive new BUY/SELL setups.';
}

function buildChartOverlays(data,a){
  const out={range:a?.range||null,sweep:a?.sweep??-1,direction:a?.rawDirection||a?.direction||0,level:a?.level??null,levelAt:a?.levelAt??-1,breakAt:a?.breakAt??-1,retestAt:a?.retestAt??-1,tbs:null,fvg:null,bos:null,delivered:false};
  const r=out.range;if(!r||out.sweep<0)return out;
  const bull=out.direction>0,from=out.sweep+1,to=Math.min(data.length,out.sweep+31);
  for(let i=from+1;i<to;i++){
    const p=data[i-1],c=data[i];
    const ok=bull?(p.close<p.open&&c.low<p.close&&c.close>p.close&&c.close>c.open):(p.close>p.open&&c.high>p.close&&c.close<p.close&&c.close<c.open);
    if(ok){out.tbs={index:i,price:p.close};break;}
  }
  if(out.tbs){
    const atrAt=i=>{const s=Math.max(0,i-14),rows=data.slice(s,i);return rows.length?rows.reduce((sum,c)=>sum+c.high-c.low,0)/rows.length:0;};
    for(let i=out.tbs.index+2;i<Math.min(data.length,out.tbs.index+32);i++){
      const old=data[i-2],c=data[i],gap=bull?c.low-old.high:old.low-c.high;
      if(gap>0&&gap>=atrAt(i)*.15){const bottom=bull?old.high:c.high,top=bull?c.low:old.low;let filled=-1;for(let j=i+1;j<data.length;j++)if(bull?data[j].low<=top:data[j].high>=bottom){filled=j;break;}out.fvg={index:i,bottom,top,filled};break;}
    }
  }
  if(out.breakAt>=0){
    const begin=Math.max(2,out.sweep-50),end=out.sweep;
    for(let i=end-2;i>=begin;i--){const pivot=data[i];let isPivot=true;for(let j=i-2;j<=i+2;j++){if(j===i||j<0||j>=data.length)continue;if(bull?data[j].high>pivot.high:data[j].low<pivot.low){isPivot=false;break;}}
      if(!isPivot)continue;const level=bull?pivot.high:pivot.low;let broken=-1,retest=-1;
      for(let j=out.sweep+1;j<data.length;j++){if(broken<0&&(bull?data[j].close>level:data[j].close<level))broken=j;else if(broken>=0&&(bull?data[j].low<=level:data[j].high>=level)){retest=j;break;}}
      if(broken>=0){out.bos={level,broken,retest};break;}
    }
  }
  out.delivered=data.slice(out.sweep+1).some(c=>bull?c.high>=r.hi:c.low<=r.lo);
  return out;
}
function drawChart(){
  const canvas=$('priceChart');if(!canvas)return;
  const rect=canvas.getBoundingClientRect(),ratio=window.devicePixelRatio||1,w=Math.max(300,rect.width),h=Math.max(260,rect.height||360);
  canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h);
  const pad={l:12,r:78,t:16,b:34},pw=w-pad.l-pad.r,ph=h-pad.t-pad.b,axisX=w-pad.r;
  ctx.fillStyle='#0b1116';ctx.fillRect(0,0,w,h);ctx.font='10px monospace';ctx.lineWidth=1;
  $('chartFrame').textContent=$('liveTimeframe').value;
  if(!candles.length){ctx.fillStyle='#829294';ctx.textAlign='center';ctx.fillText('Connect Deriv or load candle data to view the chart.',w/2,h/2);$('chartRead').textContent='Waiting for candle data';$('chartOhlc').textContent='O —  H —  L —  C —';$('chartLastPrice').textContent='—';return;}
  const visible=Math.max(1,Math.min(chartBarsVisible,candles.length)),endIndex=Math.max(0,candles.length-chartOffset),startIndex=Math.max(0,endIndex-visible),data=candles.slice(startIndex,endIndex),a=analyze(candles.slice(0,endIndex)),overlay=buildChartOverlays(candles.slice(0,endIndex),a),vals=data.flatMap(c=>[c.high,c.low]);
  if(overlay.range&&overlay.range.start>=startIndex&&overlay.range.start<=endIndex)vals.push(overlay.range.hi,overlay.range.lo,overlay.range.eq);
  if(overlay.level!==null&&overlay.levelAt>=startIndex&&overlay.levelAt<endIndex)vals.push(overlay.level);
  if(overlay.fvg&&overlay.fvg.index>=startIndex&&overlay.fvg.index<endIndex)vals.push(overlay.fvg.bottom,overlay.fvg.top);
  if(overlay.bos&&overlay.bos.broken>=startIndex&&overlay.bos.broken<endIndex)vals.push(overlay.bos.level);
  let min=Math.min(...vals),max=Math.max(...vals),span=max-min||1;min-=span*.09;max+=span*.09;span=max-min;
  const y=v=>pad.t+(max-v)/span*ph,shiftSpace=chartShift?Math.min(pw*.22,Math.max(24,pw*.14)):0,chartPlotWidth=pw-shiftSpace,xStep=chartPlotWidth/data.length,x=i=>pad.l+xStep*(i+.5),xAbs=i=>pad.l+xStep*(i-startIndex+.5),last=data.at(-1),digits=Math.min(6,Math.max(2,(String(last.close).split('.')[1]||'').length));
  $('chartCount').textContent=`${data.length} / ${candles.length} bars`;
  $('chartOhlc').textContent=`O ${last.open.toFixed(digits)}   H ${last.high.toFixed(digits)}   L ${last.low.toFixed(digits)}   C ${last.close.toFixed(digits)}`;
  $('chartLastPrice').textContent=last.close.toFixed(digits);$('chartLastPrice').className=`terminal-price ${last.close>=last.open?'up':'down'}`;
  // Dense terminal grid and distinct right-hand price ladder.
  ctx.fillStyle='#0d141a';ctx.fillRect(axisX,pad.t,pad.r,h-pad.t-pad.b);ctx.fillRect(pad.l,h-pad.b,pw,pad.b);
  for(let i=0;i<=8;i++){const yy=pad.t+ph*i/8;ctx.strokeStyle=i===8?'#34434a':'#ffffff12';ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(axisX,yy);ctx.stroke();ctx.fillStyle='#91a0a3';ctx.textAlign='left';ctx.fillText((max-span*i/8).toFixed(digits),axisX+7,yy+3);}
  for(let i=0;i<=8;i++){const xx=pad.l+pw*i/8;ctx.strokeStyle='#ffffff0b';ctx.beginPath();ctx.moveTo(xx,pad.t);ctx.lineTo(xx,pad.t+ph);ctx.stroke();}
  if(overlay.range){const r=overlay.range,rs=r.start-r.group.length,re=r.start,boxL=Math.max(pad.l,xAbs(rs)-xStep/2),boxR=Math.min(axisX,xAbs(re)-xStep/2);if(boxR>boxL){ctx.fillStyle='#81d4aa12';ctx.fillRect(boxL,y(r.hi),boxR-boxL,y(r.lo)-y(r.hi));ctx.strokeStyle='#81d4aa55';ctx.strokeRect(boxL,y(r.hi),boxR-boxL,y(r.lo)-y(r.hi));}
    for(const [value,color,label,dash] of [[r.hi,'#81d4aa','CRT H',[5,4]],[r.eq,'#8b999b','EQ',[2,4]],[r.lo,'#81d4aa','CRT L',[5,4]]]){const yy=y(value);ctx.setLineDash(dash);ctx.strokeStyle=color;ctx.beginPath();ctx.moveTo(Math.max(pad.l,xAbs(re)),yy);ctx.lineTo(axisX,yy);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=color;ctx.textAlign='left';ctx.fillText(label,pad.l+5,yy-4);}}
  const candleW=Math.max(2,Math.min(9,xStep*.62));
  data.forEach((c,i)=>{const cx=x(i),up=c.close>=c.open,color=up?'#26a69a':'#ef5350',top=y(Math.max(c.open,c.close)),bottom=y(Math.min(c.open,c.close));ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(cx,y(c.high));ctx.lineTo(cx,y(c.low));ctx.stroke();ctx.fillRect(cx-candleW/2,top,candleW,Math.max(1,bottom-top));});
  const marker=(index,text,color,above=true)=>{if(index<startIndex||index>=endIndex)return;const c=candles[index],yy=y(above?c.high:c.low),xx=xAbs(index);ctx.fillStyle=color;ctx.beginPath();ctx.moveTo(xx,yy+(above?0:0));ctx.lineTo(xx-5,yy+(above?10:-10));ctx.lineTo(xx+5,yy+(above?10:-10));ctx.closePath();ctx.fill();ctx.font='bold 9px monospace';ctx.textAlign='center';ctx.fillText(text,xx,yy+(above?-4:20));ctx.font='10px monospace';};
  if(overlay.sweep>=0)marker(overlay.sweep,overlay.direction>0?'CRT BUY':'CRT SELL',overlay.direction>0?'#36d399':'#ff7272',overlay.direction<0);
  if(overlay.level!==null&&overlay.levelAt<endIndex){const yy=y(overlay.level);ctx.setLineDash([6,3]);ctx.strokeStyle='#f2bd58';ctx.beginPath();ctx.moveTo(Math.max(pad.l,xAbs(overlay.levelAt)),yy);ctx.lineTo(axisX,yy);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#f2bd58';ctx.textAlign='left';ctx.fillText(`MODEL #1 ${overlay.retestAt>=0?'RETEST':overlay.breakAt>=0?'BROKEN':'LEVEL'}`,pad.l+6,yy-5);if(overlay.breakAt>=0)marker(overlay.breakAt,'BREAK','#f2bd58',false);if(overlay.retestAt>=0)marker(overlay.retestAt,'RETEST','#f2bd58',true);}
  if(overlay.tbs)marker(overlay.tbs.index,'TBS ENTRY',overlay.direction>0?'#48c4ff':'#d89bff',overlay.direction>0);
  if(overlay.fvg&&overlay.fvg.index<endIndex){const left=Math.max(pad.l,xAbs(overlay.fvg.index)-xStep/2),right=Math.min(axisX,overlay.fvg.filled>=0?xAbs(overlay.fvg.filled):axisX);ctx.fillStyle='#4db8ff20';ctx.fillRect(left,y(overlay.fvg.top),Math.max(1,right-left),y(overlay.fvg.bottom)-y(overlay.fvg.top));ctx.strokeStyle='#4db8ff';ctx.setLineDash([3,3]);ctx.strokeRect(left,y(overlay.fvg.top),Math.max(1,right-left),y(overlay.fvg.bottom)-y(overlay.fvg.top));ctx.setLineDash([]);ctx.fillStyle='#75caff';ctx.textAlign='left';ctx.fillText(`MODEL #2 FVG${overlay.fvg.filled>=0?' · FILLED':''}`,left+3,y(overlay.fvg.top)-4);}
  if(overlay.bos&&overlay.bos.broken<endIndex){const yy=y(overlay.bos.level);ctx.setLineDash([3,4]);ctx.strokeStyle='#d38cff';ctx.beginPath();ctx.moveTo(Math.max(pad.l,xAbs(overlay.bos.broken)),yy);ctx.lineTo(axisX,yy);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#d38cff';ctx.textAlign='left';ctx.fillText(`MODEL #3 BOS${overlay.bos.retest>=0?' · RETEST':''}`,pad.l+6,yy-5);marker(overlay.bos.broken,'BOS','#d38cff',true);if(overlay.bos.retest>=0)marker(overlay.bos.retest,'BOS RETEST','#d38cff',false);}
  const hudLines=[`CRT ${overlay.range?.body.toFixed(1)??'—'}% · ${overlay.sweep<0?'WAITING FOR SWEEP':overlay.direction>0?'BUY SWEEP':'SELL SWEEP'}`,`M1 ${overlay.level===null?'WAITING':overlay.retestAt>=0?'RETEST':overlay.breakAt>=0?'BREAK':a.invalid?'INVALID':'LEVEL'}  ·  TBS ${overlay.tbs?'FOUND':'WAITING'}`,`M2 FVG ${overlay.fvg?(overlay.fvg.filled>=0?'FILLED':'OPEN'):'WAITING'}  ·  M3 BOS ${overlay.bos?(overlay.bos.retest>=0?'RETEST':'FOUND'):'WAITING'}`,`SETUP ${a.invalid?'INVALIDATED':overlay.delivered?'DELIVERED':a.direction>0?'BUY':a.direction<0?'SELL':'WAIT'}`];
  ctx.font='9px monospace';const hudW=Math.min(255,pw-10),hudH=56,hudX=pad.l+5,hudY=pad.t+5;ctx.fillStyle='#0b1116e8';ctx.fillRect(hudX,hudY,hudW,hudH);ctx.strokeStyle='#34454a';ctx.strokeRect(hudX,hudY,hudW,hudH);ctx.textAlign='left';hudLines.forEach((line,i)=>{ctx.fillStyle=i===3?(a.invalid?'#ff7672':overlay.direction>0?'#43d6a0':overlay.direction<0?'#ff7672':'#a9b7b4'):'#b0bfbc';ctx.fillText(line,hudX+7,hudY+12+i*13,hudW-14);});
  const priceY=y(last.close);ctx.setLineDash([3,3]);ctx.strokeStyle=last.close>=last.open?'#26a69a':'#ef5350';ctx.beginPath();ctx.moveTo(pad.l,priceY);ctx.lineTo(axisX,priceY);ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle=last.close>=last.open?'#1b8f78':'#cf4d4a';ctx.fillRect(axisX,priceY-9,pad.r,18);ctx.fillStyle='#fff';ctx.textAlign='left';ctx.fillText(last.close.toFixed(digits),axisX+5,priceY+3);
  ctx.fillStyle='#91a0a3';ctx.textAlign='center';[0,Math.floor((data.length-1)/4),Math.floor((data.length-1)/2),Math.floor((data.length-1)*3/4),data.length-1].forEach(i=>{if(i>=0){const label=(data[i].time||'').toString().replace('T',' ').slice(0,16);ctx.fillText(label,x(i),h-12);}});
  $('chartRead').textContent=a?.direction>0?'BUY':a?.direction<0?'SELL':a?.invalid?'SETUP INVALID':'Price action';
}

function chartClamp(){chartBarsVisible=Math.max(12,Math.min(240,chartBarsVisible,candles.length||240));chartOffset=Math.max(0,Math.min(chartOffset,Math.max(0,candles.length-chartBarsVisible)));}
function chartZoom(nextBars,anchorFraction=.5){if(!candles.length)return;const oldBars=Math.max(1,Math.min(chartBarsVisible,candles.length)),end=candles.length-chartOffset,start=end-oldBars,anchor=start+oldBars*anchorFraction;chartBarsVisible=nextBars;const newBars=Math.max(12,Math.min(240,candles.length,nextBars));chartBarsVisible=newBars;const newStart=anchor-newBars*anchorFraction;chartOffset=Math.round(candles.length-(newStart+newBars));chartClamp();drawChart();}
function initChartGestures(){
  const canvas=$('priceChart');if(!canvas||canvas.dataset.gesturesReady)return;canvas.dataset.gesturesReady='1';
  canvas.addEventListener('pointerdown',e=>{canvas.setPointerCapture(e.pointerId);chartPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(chartPointers.size===1){chartGesture={kind:'drag',x:e.clientX,offset:chartOffset,bars:chartBarsVisible};canvas.classList.add('dragging');}else if(chartPointers.size===2){const p=[...chartPointers.values()],distance=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);chartGesture={kind:'pinch',distance,bars:chartBarsVisible,center:(p[0].x+p[1].x)/2};}});
  canvas.addEventListener('pointermove',e=>{if(!chartPointers.has(e.pointerId))return;chartPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(chartPointers.size>=2){const p=[...chartPointers.values()],dist=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);if(!chartGesture||chartGesture.kind!=='pinch'){chartGesture={kind:'pinch',distance:dist,bars:chartBarsVisible,center:(p[0].x+p[1].x)/2};return;}const scale=chartGesture.distance/Math.max(1,dist),fraction=Math.max(0,Math.min(1,(chartGesture.center-canvas.getBoundingClientRect().left)/canvas.clientWidth));chartZoom(Math.round(chartGesture.bars*scale),fraction);return;}if(chartGesture?.kind==='drag'){const dx=e.clientX-chartGesture.x,pw=Math.max(1,canvas.clientWidth-90),gap=chartShift?Math.min(pw*.22,Math.max(24,pw*.14)):0,plotWidth=Math.max(1,pw-gap),step=plotWidth/Math.max(1,chartGesture.bars);chartOffset=chartGesture.offset+Math.round(dx/step);chartClamp();drawChart();}});
  const end=e=>{chartPointers.delete(e.pointerId);if(chartPointers.size===1){const p=[...chartPointers.values()][0];chartGesture={kind:'drag',x:p.x,offset:chartOffset,bars:chartBarsVisible};}else if(!chartPointers.size){chartGesture=null;canvas.classList.remove('dragging');}};canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);canvas.addEventListener('lostpointercapture',end);
  canvas.addEventListener('wheel',e=>{e.preventDefault();const fraction=Math.max(0,Math.min(1,(e.clientX-canvas.getBoundingClientRect().left)/canvas.clientWidth));chartZoom(chartBarsVisible+(e.deltaY>0?Math.max(4,Math.round(chartBarsVisible*.18)):-Math.max(4,Math.round(chartBarsVisible*.18))),fraction);},{passive:false});
  canvas.addEventListener('dblclick',()=>{chartOffset=0;chartBarsVisible=60;chartClamp();drawChart();});
  $('chartZoomIn').addEventListener('click',()=>chartZoom(Math.round(chartBarsVisible*.8)));$('chartZoomOut').addEventListener('click',()=>chartZoom(Math.round(chartBarsVisible*1.25)));$('chartReset').addEventListener('click',()=>{chartOffset=0;chartBarsVisible=60;chartClamp();drawChart();});
  const shiftButton=$('chartShift'),syncShift=()=>{shiftButton.classList.toggle('active',chartShift);shiftButton.setAttribute('aria-pressed',String(chartShift));};syncShift();shiftButton.addEventListener('click',()=>{chartShift=!chartShift;try{localStorage.setItem('khendzodsit-chart-shift',String(chartShift));}catch{}syncShift();drawChart();});
}

function parseNews(text){
  const lines=text.replace(/^\uFEFF/,'').trim().split(/\r?\n/).filter(Boolean);if(lines.length<2)throw new Error('Add a header row and at least one headline.');
  const rows=lines.map(line=>{const out=[];let cell='',quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'&&line[i+1]==='"'&&quoted){cell+='"';i++;}else if(c==='"')quoted=!quoted;else if((c===','||c==='\t')&&!quoted){out.push(cell);cell='';}else cell+=c;}out.push(cell);return out.map(x=>x.trim());});
  const head=rows[0].map(x=>x.toLowerCase().replace(/[^a-z]/g,'')),find=(...names)=>head.findIndex(x=>names.includes(x));const title=find('title','headline','news'),time=find('time','date','datetime','published'),source=find('source','publisher','author'),summary=find('summary','description','details'),url=find('url','link');
  if(title<0)throw new Error('News CSV needs a title or headline column.');
  return rows.slice(1).map(r=>({title:r[title]||'',time:time>=0?r[time]:'',source:source>=0?r[source]:'',summary:summary>=0?r[summary]:'',url:url>=0?r[url]:''})).filter(x=>x.title);
}
function renderNews(){
  renderMacroNews();renderMacroSnapshot();
  if(!newsItems.length){$('newsList').innerHTML='<article class="card news-empty"><span>◷</span><h2>No headlines loaded</h2><p>Import a news CSV to add market headlines to this feed.</p></article>';return;}
  $('newsList').innerHTML=newsItems.map(n=>{const safeUrl=/^https?:\/\//i.test(n.url)?n.url:'';return `<article class="card news-card"><div class="news-meta"><span>${escapeHtml(n.source||'MARKET NEWS')}</span><time>${escapeHtml(n.time||'')}</time></div><h2>${safeUrl?`<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(n.title)}</a>`:escapeHtml(n.title)}</h2>${n.summary?`<p>${escapeHtml(n.summary)}</p>`:''}</article>`;}).join('');
}

const MACRO_FEEDS=[
  {name:'Gold & macro search',url:'https://news.google.com/rss/search?q=gold+OR+XAUUSD+OR+Federal+Reserve+OR+US+inflation+OR+US+dollar+OR+Treasury+yields+when%3A7d&hl=en-US&gl=US&ceid=US:en'},
  {name:'Federal Reserve',url:'https://www.federalreserve.gov/feeds/press_monetary.xml'},
  {name:'U.S. jobs · BLS',url:'https://www.bls.gov/feed/empsit.rss'},
  {name:'U.S. inflation · BLS',url:'https://www.bls.gov/feed/cpi.rss'}
];
function macroCategory(title){
  const t=title.toLowerCase();
  if(/cpi|inflation|consumer price|producer price|\bppi\b/.test(t))return 'INFLATION';
  if(/dollar|currency|foreign exchange|\busd\b/.test(t))return 'US DOLLAR';
  if(/yield|treasury|bond|interest rate/.test(t))return 'RATES / YIELDS';
  if(/fed|federal reserve|fomc|powell|monetary policy/.test(t))return 'FED / POLICY';
  if(/central bank|gold reserve|gold demand|gold buying|gold etf/.test(t))return 'GOLD DEMAND';
  if(/war|geopolit|conflict|crisis|risk|attack|sanction/.test(t))return 'RISK / GEOPOLITICS';
  if(/employment|payroll|jobs|unemployment|wage|labor/.test(t))return 'US ECONOMY';
  if(/gold|xau|bullion/.test(t))return 'GOLD MARKET';
  return 'MACRO';
}
function macroBias(title){
  const t=title.toLowerCase(),up=['rate cut','cuts rates','dovish','yields fall','yield falls','yields decline','dollar falls','dollar weak','weaker dollar','weak dollar','gold rises','gold gains','gold buying','central bank buys','safe haven','war','conflict','crisis','risk-off'],dn=['rate hike','hikes rates','hawkish','yields rise','yield rises','yields climb','dollar rises','dollar gains','strong dollar','dollar strong','hot inflation','inflation accelerates','gold falls','gold drops','gold loses'];
  const bullish=up.filter(x=>t.includes(x)).length,bearish=dn.filter(x=>t.includes(x)).length;
  return bullish>bearish?'MAY SUPPORT GOLD':bearish>bullish?'MAY WEIGH ON GOLD':'MIXED / UNCLEAR';
}
function safeNewsLink(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:'';}catch{return '';}}
function renderMacroNews(){
  if(!macroNewsItems.length){$('macroNewsList').innerHTML='<article class="news-empty"><span>◷</span><h2>No macro headlines loaded</h2><p>Use Refresh news or import a news CSV below if your network blocks public RSS.</p></article>';return;}
  const colors={'MAY SUPPORT GOLD':'support','MAY WEIGH ON GOLD':'weigh','MIXED / UNCLEAR':'mixed'};
  $('macroNewsList').innerHTML=macroNewsItems.slice(0,8).map(n=>{const link=safeNewsLink(n.url),time=n.time?new Date(n.time).toLocaleString():'Recent';return `<article class="macro-news-row"><span class="macro-accent ${colors[n.bias]}"></span><div class="macro-news-copy"><div class="macro-news-meta"><span>${escapeHtml(n.category)} · ${escapeHtml(n.source)}</span><time>${escapeHtml(time)}</time></div><h3>${link?`<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(n.title)}</a>`:escapeHtml(n.title)}</h3><span class="macro-bias ${colors[n.bias]}">${escapeHtml(n.bias)}</span></div></article>`;}).join('');
}
async function refreshMacroNews(){
  if(macroNewsBusy)return;macroNewsBusy=true;$('refreshMacro').disabled=true;$('macroFeedStatus').textContent='Updating public RSS headlines…';
  const load=async feed=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
    try{
      let response;
      try{response=await fetch(`https://proxy.cors.dev/${feed.url}`,{signal:controller.signal,cache:'no-store'});if(!response.ok)response=await fetch(feed.url,{signal:controller.signal,cache:'no-store'});}
      catch{response=await fetch(feed.url,{signal:controller.signal,cache:'no-store'});}
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const xml=new DOMParser().parseFromString(await response.text(),'text/xml');if(xml.querySelector('parsererror'))throw new Error('Invalid RSS');
      return [...xml.querySelectorAll('item')].map(item=>({title:item.querySelector('title')?.textContent?.trim()||'',url:item.querySelector('link')?.textContent?.trim()||'',time:item.querySelector('pubDate')?.textContent?.trim()||'',source:item.querySelector('source')?.textContent?.trim()||feed.name})).filter(x=>x.title).map(x=>({...x,category:macroCategory(x.title),bias:macroBias(x.title)}));
    }finally{clearTimeout(timer);}
  };
  try{
    const results=await Promise.allSettled(MACRO_FEEDS.map(load)),received=results.filter(x=>x.status==='fulfilled').flatMap(x=>x.value),unique=new Map();
    received.forEach(n=>{const key=n.title.toLowerCase();if(!unique.has(key))unique.set(key,n);});macroNewsItems=[...unique.values()].sort((a,b)=>(Date.parse(b.time)||0)-(Date.parse(a.time)||0)).slice(0,8);
    const good=results.filter(x=>x.status==='fulfilled').length;$('macroUpdated').textContent=good?`Updated ${new Date().toLocaleTimeString()}`:'RSS unavailable';
    $('macroFeedStatus').textContent=good?`Public RSS · ${good}/${MACRO_FEEDS.length} sources responded. Headline bias is a keyword heuristic.`:'Public RSS is unreachable on this network. Use the CSV import below.';
    if(good<MACRO_FEEDS.length)$('newsNote').textContent=`${good} of ${MACRO_FEEDS.length} RSS sources responded; failed sources may be unavailable through public web proxies.`;
    renderMacroNews();
  }finally{macroNewsBusy=false;$('refreshMacro').disabled=false;}
}
function renderMacroSnapshot(){
  const isGold=$('symbol').selectedOptions[0]?.dataset.watch==='XAUUSD',rows=candles.slice(-70),last=rows.at(-1),first=rows[0];
  if(!isGold||!last){$('macroPrice').textContent='—';$('macroChange').textContent='—';$('macroRating').textContent='WAIT';$('macroRating').className='neutral-text';$('macroRsi').textContent='—';$('macroStatus').textContent=isGold?'Connect Deriv or load XAUUSD candles to show the gold snapshot.':'Select XAUUSD in Trade for the gold technical snapshot.';return;}
  const digits=Math.min(6,Math.max(2,(String(last.close).split('.')[1]||'').length)),change=last.close-first.open,pct=first.open?100*change/first.open:0;
  $('macroPrice').textContent=`${last.close.toFixed(digits)} USD`;$('macroChange').textContent=`${change>=0?'+':''}${change.toFixed(digits)} (${pct>=0?'+':''}${pct.toFixed(2)}%)`;$('macroChange').className=change>0?'up':change<0?'down':'neutral-text';
  const closes=rows.map(c=>c.close),ema=(arr,n)=>{const k=2/(n+1);return arr.slice(1).reduce((value,p)=>p*k+value*(1-k),arr[0]);};
  if(closes.length<55){$('macroRating').textContent='WAIT';$('macroRating').className='neutral-text';$('macroRsi').textContent='Need 55 bars';}
  else{const e20=ema(closes,20),e50=ema(closes,50);let gains=0,losses=0;for(let i=closes.length-14;i<closes.length;i++){const d=closes[i]-closes[i-1];if(d>0)gains+=d;else losses-=d;}const rsi=losses===0?100:100-100/(1+(gains/14)/(losses/14));const score=(last.close>e20?1:last.close<e20?-1:0)+(e20>e50?1:e20<e50?-1:0)+(rsi>55?1:rsi<45?-1:0),rating=score>=3?'STRONG BUY':score===2?'BUY':score<=-3?'STRONG SELL':score===-2?'SELL':'NEUTRAL';$('macroRating').textContent=rating;$('macroRating').className=score>0?'up':score<0?'down':'neutral-text';$('macroRsi').textContent=rsi.toFixed(1);}
  $('macroStatus').textContent=`${liveMode?'Deriv live':'Loaded'} · ${$('liveTimeframe').value} · change across ${rows.length} loaded bars`;
}

function setLiveStatus(status,message=''){
  const labels={offline:'OFFLINE',connecting:'CONNECTING',loading:'LOADING',connected:'LIVE',reconnecting:'RECONNECTING',error:'ERROR'};
  $('liveFeedStatus').textContent=labels[status]||status.toUpperCase();$('liveFeedStatus').className=`feed-state ${status==='connected'?'online':status==='error'?'error':status==='offline'?'':'pending'}`;
  $('connectionBadge').textContent=labels[status]||status.toUpperCase();$('connectionBadge').className=`status-pill ${status==='connected'?'bull':status==='error'?'bear':'neutral'}`;
  if(message)$('liveMessage').textContent=message;
  $('connectLive').disabled=status==='connecting'||status==='loading'||status==='connected';$('disconnectLive').disabled=status==='offline';
}
function disconnectLive(showStatus=true){
  liveDesired=false;clearTimeout(liveReconnectTimer);liveReconnectTimer=null;
  if(liveSocket){const old=liveSocket;liveSocket=null;liveSubscriptions.forEach(id=>{try{old.send(JSON.stringify({forget:id}));}catch{}});liveSubscriptions.clear();try{old.close(1000,'Disconnected by user');}catch{}}
  liveMode=false;liveHistoryLoaded=false;$('liveQuote').hidden=true;$('liveQuote').textContent='—';
  if(showStatus){setLiveStatus('offline','Deriv market data disconnected.');render();}
}
function scheduleLiveReconnect(){
  if(!liveDesired||liveFailed||liveReconnectTimer)return;
  const delay=Math.min(30000,1000*2**Math.min(liveReconnectAttempt++,5));
  setLiveStatus('reconnecting',`Connection lost. Retrying in ${Math.round(delay/1000)} seconds.`);
  liveReconnectTimer=setTimeout(()=>{liveReconnectTimer=null;connectLive(true);},delay);
}
function connectLive(automatic=false){
  liveDesired=true;clearTimeout(liveReconnectTimer);liveReconnectTimer=null;
  if(liveSocket){try{liveSocket.close(1000,'Replacing connection');}catch{}liveSocket=null;}
  liveFailed=false;
  const instrument=$('symbol').value.trim();
  if(!/^[A-Za-z0-9_]{2,30}$/.test(instrument)){liveDesired=false;setLiveStatus('error','Choose a valid Deriv symbol from the Market list.');return;}
  let socket;try{socket=new WebSocket(DERIV_PUBLIC_WS);liveSocket=socket;}catch{liveDesired=false;setLiveStatus('error','Could not open Deriv’s public WebSocket.');return;}
  liveHistoryLoaded=false;liveSubscriptions.clear();setLiveStatus('connecting','Opening Deriv’s public market-data connection. No login is required.');
  socket.addEventListener('open',()=>{if(liveSocket!==socket||socket.readyState!==WebSocket.OPEN)return;liveReconnectAttempt=0;setLiveStatus('loading','Connected. Loading the six requested markets from Deriv.');socket.send(JSON.stringify({active_symbols:'brief',req_id:1}));});
  socket.addEventListener('message',event=>{let msg;try{msg=JSON.parse(event.data);}catch{return;}
    if(msg.error||(Array.isArray(msg.errors)&&msg.errors.length)){const apiError=msg.error?.message||msg.errors?.[0]?.message,requestId=Number(msg.req_id);if(candleRequestSymbols.has(requestId)){failedMarketSymbols.add(candleRequestSymbols.get(requestId));renderMarketSignalBoard();return;}liveFailed=true;liveDesired=false;setLiveStatus('error',apiError||'Deriv returned a market data error.');try{socket.close(1008,'Deriv returned an error');}catch{}return;}
    if(msg.subscription?.id)liveSubscriptions.add(msg.subscription.id);
    if(msg.msg_type==='active_symbols'&&Array.isArray(msg.active_symbols)){if(!populateDerivSymbols(msg.active_symbols)){liveFailed=true;liveDesired=false;setLiveStatus('error','Deriv did not return any of the six requested markets on this public feed.');try{socket.close(1008,'Requested markets unavailable');}catch{}return;}if(liveSocket===socket&&socket.readyState===WebSocket.OPEN)requestDerivMarket(socket,$('liveTimeframe').value);return;}
    if(msg.msg_type==='tick'&&msg.tick){showLiveTick(msg.tick);return;}
    if((msg.msg_type==='candles'||msg.msg_type==='history')&&Array.isArray(msg.candles)){applyDerivCandles(msg);return;}
  });
  socket.addEventListener('close',()=>{if(liveSocket!==socket)return;liveSocket=null;liveMode=false;liveSubscriptions.clear();$('liveQuote').hidden=true;if(liveFailed){liveDesired=false;setLiveStatus('error','Deriv closed the stream after an error. Check the symbol and try again.');}else if(liveDesired)scheduleLiveReconnect();else setLiveStatus('offline','Deriv market data disconnected.');render();});
  socket.addEventListener('error',()=>{if(liveSocket===socket)setLiveStatus('reconnecting','Deriv connection interrupted; waiting to retry.');});
}
function requestDerivMarket(socket,timeframe){
  const granularity={M1:60,M5:300,M15:900,M30:1800,H1:3600,H4:14400,D1:86400}[timeframe]||60;
  candleRequestSymbols.clear();candleSubscriptionSymbols.clear();marketHistoryLoaded.clear();
  failedMarketSymbols.clear();
  resolvedDerivMarkets.forEach(market=>{const reqId=nextMarketRequestId++;candleRequestSymbols.set(reqId,market.symbol);socket.send(JSON.stringify({ticks_history:market.symbol,end:'latest',count:200,style:'candles',granularity,subscribe:1,req_id:reqId}));});
  const selected=resolvedDerivMarkets.find(x=>x.symbol===$('symbol').value)?.symbol||$('symbol').value;
  socket.send(JSON.stringify({ticks:selected,subscribe:1,req_id:3}));
}
function populateDerivSymbols(markets){
  const select=$('symbol'),currentKey=select.selectedOptions[0]?.dataset.watch||'XAUUSD';
  const valid=markets.map(m=>({symbol:m.underlying_symbol||m.symbol||'',name:m.underlying_symbol_name||m.display_name||''})).filter(m=>m.symbol&&m.name);
  if(!valid.length){setLiveStatus('error','Deriv returned no active markets. Try connecting again later.');return false;}
  const resolved=WATCHLIST.map(item=>{
    let found=item.codes.map(code=>valid.find(m=>m.symbol===code)).find(Boolean);
    if(!found)found=valid.find(m=>item.match.test(`${m.name} ${m.symbol}`));
    if(!found&&item.alternate)found=valid.find(m=>item.alternate.test(`${m.name} ${m.symbol}`));
    let label=item.label;
    if(item.key==='OIL'&&found&&item.alternate?.test(`${found.name} ${found.symbol}`))label='OIL · Brent Oil';
    return {item,found,label};
  });
  resolvedDerivMarkets=resolved.filter(x=>x.found).map(({item,found})=>({key:item.key,symbol:found.symbol,name:found.name}));
  select.innerHTML=resolved.map(({item,found,label})=>`<option value="${escapeHtml(found?.symbol||item.codes[0])}" data-watch="${item.key}"${found?'':' disabled'}>${escapeHtml(found?label:`${item.key} · unavailable on this Deriv feed`)}</option>`).join('');
  const preferred=resolved.find(x=>x.item.key===currentKey&&x.found)||resolved.find(x=>x.found);
  if(preferred)select.value=preferred.found.symbol;
  const available=resolved.filter(x=>x.found).length;
  $('liveMessage').textContent=`Deriv returned ${available} of the 6 requested markets. Choose XAUUSD, NAS100, US30, GER30, Oil, or DXY from Trade.`;
  return available>0;
}
function normalizeDerivCandles(raw){
  return raw.map(c=>{const timeValue=c.epoch??c.open_time??c.date_start??c.time;let date=Number(timeValue);if(!Number.isFinite(date))date=Date.parse(timeValue);else if(date<1e12)date*=1000;return {time:Number.isFinite(date)?new Date(date).toISOString():String(timeValue||''),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)};}).filter(c=>[c.open,c.high,c.low,c.close].every(Number.isFinite));
}
function mergeCandleRows(existing,incoming){const byTime=new Map((existing||[]).map(c=>[c.time,c]));incoming.forEach(c=>byTime.set(c.time,c));return [...byTime.values()].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)).slice(-1500);}
function applyDerivCandles(message){
  const reqSymbol=candleRequestSymbols.get(Number(message.req_id)),echoSymbol=message.echo_req?.ticks_history,symbol=reqSymbol||echoSymbol||candleSubscriptionSymbols.get(message.subscription?.id);if(!symbol)return;
  if(message.subscription?.id)candleSubscriptionSymbols.set(message.subscription.id,symbol);
  const mapped=normalizeDerivCandles(message.candles);if(!mapped.length)return;
  const loaded=marketHistoryLoaded.has(symbol),marketData=loaded?mergeCandleRows(marketCandleData.get(symbol),mapped):mapped;
  marketHistoryLoaded.add(symbol);marketCandleData.set(symbol,marketData);
  if(symbol===$('symbol').value){candles=marketData.slice();liveHistoryLoaded=true;liveMode=true;$('dataNote').textContent=`Deriv ${$('liveTimeframe').value} candles · ${candles.length} bars across 6 markets`;$('liveMessage').textContent=`Live Deriv candles and signals are loading for all requested markets.`;setLiveStatus('connected','Deriv live market candles are updating across the watchlist.');render();}
  else renderMarketSignalBoard();
}
function showLiveTick(tick){
  const price=Number(tick.quote);if(!Number.isFinite(price))return;
  $('liveQuote').hidden=false;$('liveQuote').textContent=price.toFixed(Number(tick.pip_size)||2);
  if(!liveMode)return;
  const frame=TIMEFRAME_MS[$('liveTimeframe').value]||60000,rawTime=tick.epoch,time=typeof rawTime==='number'?(rawTime<1e12?rawTime*1000:rawTime):(Date.parse(rawTime)||Date.now()),bucket=Math.floor(time/frame)*frame,last=candles.at(-1),lastDate=last?(typeof last.time==='number'?last.time:Date.parse(last.time)):NaN,lastBucket=Number.isFinite(lastDate)?Math.floor(lastDate/frame)*frame:-1;
  if(last&&bucket===lastBucket){last.high=Math.max(last.high,price);last.low=Math.min(last.low,price);last.close=price;}
  else if(bucket>lastBucket){candles.push({time:new Date(bucket).toISOString(),open:price,high:price,low:price,close:price});if(candles.length>1500)candles=candles.slice(-1500);}
  else return;
  marketCandleData.set($('symbol').value,candles.slice());
  $('dataNote').textContent=`Live Deriv ${$('liveTimeframe').value} · ${candles.length} bars`;$('liveMessage').textContent=`Live quote ${$('liveQuote').textContent} · ${candles.length} candles loaded.`;render();
}

document.querySelectorAll('.nav-item').forEach(button=>button.addEventListener('click',()=>{
  const screen=button.dataset.screen;document.querySelectorAll('[data-screen-panel]').forEach(panel=>panel.hidden=panel.dataset.screenPanel!==screen);document.querySelectorAll('.nav-item').forEach(item=>{const active=item===button;item.classList.toggle('active',active);if(active)item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');});
  if(screen==='chart')requestAnimationFrame(drawChart);if(screen==='news')renderNews();window.scrollTo({top:0,behavior:'smooth'});
}));
$('newsInput').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{newsItems=parseNews(await f.text());renderNews();$('newsNote').textContent=`Loaded ${newsItems.length} headlines from ${f.name}.`;}catch(err){$('newsNote').textContent=err.message;}e.target.value='';});
$('refreshMacro').addEventListener('click',refreshMacroNews);
['rangeThreshold','modelThreshold','lookbackSetting'].forEach(id=>$(id).addEventListener('change',saveSettings));
$('resetSettings').addEventListener('click',()=>{settings={...defaultSettings};try{localStorage.setItem('khendzodsit-settings',JSON.stringify(settings));}catch{}initSettings();$('settingsNote').textContent='Defaults restored.';render();});
$('connectLive').addEventListener('click',connectLive);
$('disconnectLive').addEventListener('click',()=>disconnectLive());
$('connectFromChart').addEventListener('click',()=>document.querySelector('.nav-item[data-screen="settings"]').click());
$('liveTimeframe').addEventListener('change',()=>{chartOffset=0;chartBarsVisible=60;marketCandleData.clear();marketHistoryLoaded.clear();if(liveSocket){candles=[];disconnectLive(false);connectLive(true);$('liveMessage').textContent='Reloading Deriv candles for all requested markets.';}else{candles=[];render();}});
$('symbol').addEventListener('change',()=>{chartOffset=0;chartBarsVisible=60;if(liveSocket){candles=[];disconnectLive(false);connectLive(true);$('liveMessage').textContent='Loading Deriv candles for the selected market.';}else drawChart();});
window.addEventListener('resize',()=>{if(!$('screen-chart').hidden)drawChart();});
initChartGestures();initSettings();$('signalAlertsToggle').addEventListener('click',toggleSignalAlerts);syncSignalAlertControls();renderNews();refreshMacroNews();setInterval(()=>{if(!document.hidden)refreshMacroNews();},5*60*1000);connectLive(true);
window.addEventListener('beforeunload',()=>disconnectLive(false));
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;$('installBtn').hidden=false;});
$('installBtn').addEventListener('click',async()=>{if(!deferredInstall)return;deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;$('installBtn').hidden=true;});
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
