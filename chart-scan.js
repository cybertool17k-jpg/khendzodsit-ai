(()=>{
  const $=id=>document.getElementById(id),input=$('scanGalleryInput'),camera=$('scanCameraInput');
  const endpointKey='khendzodsit-chart-scan-endpoint';let selectedFile=null,previewUrl='',endpointConnected=false,checkedEndpoint='';
  const saved=()=>{try{return localStorage.getItem(endpointKey)||'';}catch{return '';}};
  function setReady(){ $('scanAnalyzeButton').disabled=!(selectedFile&&$('scanEndpointInput').value.trim()===saved()&&saved()&&endpointConnected&&checkedEndpoint===saved()); }
  function status(message,error=false){$('scanStatus').textContent=message;$('scanStatus').classList.toggle('error',error);}
  function setFile(file){
    if(!file)return;if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl='';selectedFile=null;$('scanPreview').removeAttribute('src');$('scanPreviewWrap').hidden=true;setReady();
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){status('Choose a PNG, JPG, or WebP chart image.',true);return;}
    if(file.size>8*1024*1024){status('This image exceeds the 8 MB scan limit. Choose a smaller screenshot.',true);return;}
    selectedFile=file;if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(file);$('scanPreview').src=previewUrl;$('scanPreviewWrap').hidden=false;$('scanResults').hidden=true;setReady();status(`${file.name} ready · ${Math.ceil(file.size/1024)} KB. The image is sent to your configured scan service only after you analyze it.`);
  }
  function displayNumber(value){return value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:6}):'—';}
  function setResult(result){
    if(!result||!['BUY','SELL','WAIT'].includes(result.signal))throw new Error('The scan service returned an invalid signal.');
    $('scanSignal').textContent=result.signal;$('scanSignal').className=`scan-direction ${result.signal.toLowerCase()}`;
    $('scanInstrument').textContent=`${result.market||$('scanMarket').value} · ${result.timeframe||$('scanTimeframe').value}`;
    $('scanConfidence').textContent=typeof result.confidence==='number'&&Number.isFinite(result.confidence)?`${Math.max(0,Math.min(100,Math.round(result.confidence)))}% model estimate`:'—';
    $('scanSummary').textContent=result.summary||'No summary provided.';$('scanSupport').textContent=displayNumber(result.support);$('scanResistance').textContent=displayNumber(result.resistance);
    $('scanEntry').textContent=typeof result.entry_low==='number'&&Number.isFinite(result.entry_low)&&typeof result.entry_high==='number'&&Number.isFinite(result.entry_high)?`${displayNumber(result.entry_low)} – ${displayNumber(result.entry_high)}`:'—';
    $('scanTarget').textContent=displayNumber(result.target);$('scanInvalidation').textContent=displayNumber(result.invalidation);$('scanTrend').textContent=result.trend||'UNCLEAR';$('scanReasoning').textContent=result.reasoning||'';
    const warnings=Array.isArray(result.warnings)?result.warnings:[];$('scanWarnings').replaceChildren(...warnings.map(w=>{const li=document.createElement('li');li.textContent=String(w);return li;}));$('scanResults').hidden=false;
  }
  async function saveEndpoint(){
    const value=$('scanEndpointInput').value.trim();if(!value){try{localStorage.removeItem(endpointKey);}catch{}endpointConnected=false;checkedEndpoint='';$('scanEndpointStatus').textContent='Endpoint cleared.';setReady();return;}
    let url;try{url=new URL(value);}catch{$('scanEndpointStatus').textContent='Enter a complete endpoint URL.';return;}
    if(url.protocol!=='https:'&&!(url.hostname==='localhost'&&url.protocol==='http:')){$('scanEndpointStatus').textContent='Use an HTTPS endpoint (HTTP is allowed only on localhost).';return;}
    try{localStorage.setItem(endpointKey,url.href);}catch{$('scanEndpointStatus').textContent='Could not save endpoint on this device.';return;}
    $('scanEndpointInput').value=url.href;endpointConnected=false;checkedEndpoint='';$('scanEndpointStatus').textContent='Saved. Connecting to scan service…';setReady();await checkEndpoint(true);
  }
  async function checkEndpoint(automatic=false){
    const base=$('scanEndpointInput').value.trim();if(!base){endpointConnected=false;checkedEndpoint='';if(!automatic)$('scanEndpointStatus').textContent='Enter an endpoint URL first.';setReady();return;}
    let url;try{url=new URL(base);}catch{endpointConnected=false;checkedEndpoint='';$('scanEndpointStatus').textContent='Enter a valid endpoint URL.';setReady();return;}
    endpointConnected=false;checkedEndpoint='';url.pathname=url.pathname.replace(/\/api\/chart-scan\/?$/,'/health');$('scanCheckEndpoint').disabled=true;setReady();$('scanEndpointStatus').textContent='Connecting to secure scan service…';
    try{const response=await fetch(url.href,{method:'GET',cache:'no-store'}),data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||`HTTP ${response.status}`);endpointConnected=true;checkedEndpoint=base;$('scanEndpointStatus').textContent='Connected. Scan service is ready.';}
    catch(error){$('scanEndpointStatus').textContent=`Connection failed: ${error.message}. Check the saved URL and CORS settings.`;}
    finally{$('scanCheckEndpoint').disabled=false;setReady();}
  }
  function candleContext(market){
    if($('scanTimeframe').value!==$('liveTimeframe').value||liveSocket?.readyState!==WebSocket.OPEN)return [];
    const symbol=resolvedDerivMarkets.find(m=>m.key===market)?.symbol||WATCHLIST.find(m=>m.key===market)?.codes[0],rows=marketCandleData.get(symbol)||(market===($('symbol').selectedOptions[0]?.dataset.watch||'XAUUSD')?candles:[]);
    return (rows||[]).slice(-40).map(c=>({time:c.time,open:c.open,high:c.high,low:c.low,close:c.close}));
  }
  async function analyzeImage(){
    const endpoint=saved();if(!selectedFile){status('Choose a chart image first.',true);return;}if(!endpoint){status('Save a secure scan endpoint before analyzing.',true);return;}
    const button=$('scanAnalyzeButton'),form=new FormData();form.append('image',selectedFile,selectedFile.name);form.append('market',$('scanMarket').value);form.append('timeframe',$('scanTimeframe').value);form.append('candles',JSON.stringify(candleContext($('scanMarket').value)));
    button.disabled=true;button.textContent='Analyzing…';$('scanResults').hidden=true;status('Sending the chart image for visual analysis…');
    try{const response=await fetch(endpoint,{method:'POST',body:form,cache:'no-store'}),payload=await response.json();if(!response.ok)throw new Error(payload.error||`Scan failed · HTTP ${response.status}`);setResult(payload.analysis);status('Chart scan complete. Verify the visual levels against live market data.');$('scanResults').scrollIntoView({behavior:'smooth',block:'nearest'});}
    catch(error){status(`${error.message}. Check endpoint status and internet connection.`,true);}
    finally{button.textContent='Analyze chart';setReady();}
  }
  $('scanGalleryButton').addEventListener('click',()=>input.click());$('scanCameraButton').addEventListener('click',()=>camera.click());
  input.addEventListener('change',()=>{setFile(input.files?.[0]);input.value='';});camera.addEventListener('change',()=>{setFile(camera.files?.[0]);camera.value='';});
  $('scanRemoveImage').addEventListener('click',()=>{selectedFile=null;if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl='';$('scanPreview').removeAttribute('src');$('scanPreviewWrap').hidden=true;$('scanResults').hidden=true;setReady();status('Choose a chart image to begin.');});
  $('scanSaveEndpoint').addEventListener('click',saveEndpoint);$('scanCheckEndpoint').addEventListener('click',checkEndpoint);$('scanAnalyzeButton').addEventListener('click',analyzeImage);
  $('scanEndpointInput').value=saved();$('scanEndpointInput').addEventListener('input',()=>{endpointConnected=false;checkedEndpoint='';setReady();});
  $('scanMarket').value=$('symbol').selectedOptions[0]?.dataset.watch||'XAUUSD';$('scanTimeframe').value=$('liveTimeframe').value||'M1';setReady();
  if(saved())checkEndpoint(true);else $('scanEndpointStatus').textContent='No scan service is configured yet. After saving an endpoint, the app connects automatically.';
  window.addEventListener('online',()=>{if(saved()&&!endpointConnected&&$('scanEndpointInput').value.trim()===saved())checkEndpoint(true);});
})();
