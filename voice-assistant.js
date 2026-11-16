(()=>{
  const $=id=>document.getElementById(id),panel=$('voicePanel'),input=$('voiceInput'),log=$('voiceLog'),status=$('voiceStatus');
  const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  let recognition=null,listening=false;
  const aliases={
    XAUUSD:['xauusd','gold','gold dollar','gold usd'],
    NAS100:['nas100','nasdaq','us tech 100','tech 100'],
    US30:['us30','dow jones','dow','wall street 30'],
    GER30:['ger30','dax','germany 40','german 30'],
    OIL:['oil','wti','crude oil'],
    DXY:['dxy','dollar index','us dollar index']
  };
  function addMessage(text,kind){const p=document.createElement('p');p.className=kind==='user'?'assistant-question':'assistant-reply';p.textContent=text;log.append(p);log.scrollTop=log.scrollHeight;}
  function voiceKey(voice){return `${voice.voiceURI}|${voice.lang}`;}
  function likelyFeminine(voice){return /female|woman|samantha|zira|aria|jenny|jessa|sara|susan|hazel|heera|eva|ava|karen|serena|tessa|victoria|moira|fiona|allison|salli|kendra|kimberly|joanna|ivy|emma|amy|linda|lucia|sophia|natasha/i.test(`${voice.name} ${voice.voiceURI}`);}
  function populateVoices(){
    if(!('speechSynthesis'in window))return;const voices=speechSynthesis.getVoices(),select=$('voiceChoice');if(!voices.length){$('voicePreferenceStatus').textContent='No device voices found yet. Check Android text-to-speech settings.';return;}
    let preferred=select.value;try{preferred=localStorage.getItem('khendzodsit-voice-id')||preferred;}catch{}const language=(navigator.language||'en-US').toLowerCase(),feminine=voices.filter(likelyFeminine),sameLang=voice=>voice.lang.toLowerCase().startsWith(language.split('-')[0]);
    select.replaceChildren(...voices.map(voice=>{const option=new Option(`${voice.name} · ${voice.lang}${likelyFeminine(voice)?' · feminine':''}`,voiceKey(voice));if(likelyFeminine(voice))option.dataset.feminine='true';return option;}));
    const chosen=voices.find(v=>voiceKey(v)===preferred)||feminine.find(sameLang)||feminine[0]||voices.find(sameLang)||voices.find(v=>v.default)||voices[0];select.value=voiceKey(chosen);
    try{localStorage.setItem('khendzodsit-voice-id',voiceKey(chosen));}catch{}
    $('voicePreferenceStatus').textContent=likelyFeminine(chosen)?`Using ${chosen.name}. Choose any installed voice above.`:'No clearly feminine voice was found. Choose one above or install a voice in Android text-to-speech settings.';
  }
  function speak(text){if(!$('voiceSpeak').checked||!('speechSynthesis'in window)||!window.SpeechSynthesisUtterance)return;speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text),voices=speechSynthesis.getVoices();utterance.lang=navigator.language||'en-US';utterance.voice=voices.find(v=>voiceKey(v)===$('voiceChoice').value)||null;utterance.rate=Number($('voiceRate').value)||.9;speechSynthesis.speak(utterance);}
  function answer(text){const q=String(text||'').trim();if(!q)return;addMessage(q,'user');input.value='';const response=handleCommand(q);addMessage(response,'assistant');speak(response);}
  function identifyMarket(q){const lower=q.toLowerCase();for(const [key,names] of Object.entries(aliases))if(names.some(name=>new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^a-z0-9]|$)`,'i').test(lower)))return WATCHLIST.find(x=>x.key===key);return null;}
  function marketInfo(item){const symbol=resolvedDerivMarkets.find(x=>x.key===item.key)?.symbol||item.codes[0],data=marketCandleData.get(symbol)||(item.key===($('symbol').selectedOptions[0]?.dataset.watch||'XAUUSD')?candles:null);if(!data?.length)return `${item.key}: waiting for live candle data.`;const a=analyze(data),side=a.direction>0?'BUY':a.direction<0?'SELL':a.invalid?'INVALID':'WAIT',last=data.at(-1),plan=marketTradePlan(data,a);let result=`${item.key} is ${side}. Last price ${fmt(last.close)}.`;if(plan){result+=` Entry ${fmt(plan.entry)}, stop ${fmt(plan.stop)}, target one ${fmt(plan.target1)}, target two ${fmt(plan.target2)}. ${plan.entryRule}.`;}else if(a.invalid)result+=' The CRT setup is invalidated.';else result+=` ${a.message}`;return result;}
  function handleCommand(command){
    const q=command.toLowerCase(),market=identifyMarket(q);
    if(/^(hi|hello|hey|good morning|good afternoon)\b/.test(q))return 'Hello. Ask me for a market signal, entry and targets, the U.S. labor read, or to open a section.';
    if(/\b(help|what can you do|commands)\b/.test(q))return 'I can read BUY, SELL, or WAIT for the six watched markets, give entry, stop and target levels, summarize U.S. labor as strong or weak, refresh labor or headlines, select a market, open Chart AI Scan, and navigate the app. I cannot place trades or answer every general question without a secure AI service.';
    if(/\b(labor|payroll|employment|unemployment|jobs data|strong or weak)\b/.test(q)){
      if(/\b(refresh|update)\b/.test(q)){$('laborRefresh').click();return 'Refreshing the latest published U.S. labor data now.';}
      const overall=$('laborOverall')?.textContent||'WAITING',detail=$('laborOverallDetail')?.textContent||'';return `The latest U.S. labor read is ${overall}. ${detail} ${$('laborReportMonth')?.textContent||''}`;
    }
    if(/\b(refresh|update)\b/.test(q)&&/\b(news|headlines)\b/.test(q)){$('refreshMacro').click();return 'Refreshing the news headlines now.';}
    if(/\b(enable|turn on)\b/.test(q)&&/\b(alert|notification)\b/.test(q))return 'Tap Enable Alerts on the Signals page to grant Chrome notification permission. Voice recognition cannot grant that browser permission for you.';
    const screen=/\b(chart ai scan|scan|screenshot)\b/.test(q)?'scan':/\b(chart|candlestick)\b/.test(q)?'chart':/\b(signals|signal board)\b/.test(q)?'signals':/\b(news|calendar|headlines)\b/.test(q)?'news':/\b(settings)\b/.test(q)?'settings':/\b(trade|home)\b/.test(q)?'trade':null;
    if(/\b(open|show|go to|switch to)\b/.test(q)&&screen){document.querySelector(`.nav-item[data-screen="${screen}"]`)?.click();if(market){$('symbol').value=resolvedDerivMarkets.find(x=>x.key===market.key)?.symbol||market.codes[0];$('symbol').dispatchEvent(new Event('change'));}return `${market?`Selected ${market.key} and `:''}Opening ${screen}.`;}
    if(/\b(minimize|collapse|restore|expand)\b/.test(q)){
      const panelName=/labor|jobs/.test(q)?'labor':/calendar|events/.test(q)?'econ':/headline|imported news/.test(q)?'imported':/gold|macro/.test(q)?'macro':null,restore=/\b(restore|expand)\b/.test(q);
      if(panelName){const button=$(`${panelName}Collapse`),expanded=button?.getAttribute('aria-expanded')==='true';if(button&&(restore?!expanded:expanded)){button.click();return `${restore?'Restored':'Minimized'} the ${panelName} panel.`;}return `The ${panelName} panel is already ${expanded?'expanded':'minimized'}.`;}
    }
    if(/\b(connect|start)\b/.test(q)&&/\b(live|feed|market data)\b/.test(q)){$('connectLive').click();return 'Connecting to the Deriv live market feed.';}
    if(/\b(disconnect|stop)\b/.test(q)&&/\b(live|feed|market data)\b/.test(q)){$('disconnectLive').click();return 'Disconnected from the Deriv live market feed.';}
    if(market&&/\b(select|choose|change|switch|open)\b/.test(q)){$('symbol').value=resolvedDerivMarkets.find(x=>x.key===market.key)?.symbol||market.codes[0];$('symbol').dispatchEvent(new Event('change'));return `Selected ${market.key}. The chart and live data are switching now.`;}
    if(/\b(all|every|each)\b/.test(q)&&/\b(signal|market|pair)\b/.test(q))return WATCHLIST.map(marketInfo).join(' ');
    if(market&&/\b(signal|buy|sell|entry|target|stop|price|doing|outlook|current)\b/.test(q))return marketInfo(market);
    if(market)return marketInfo(market);
    if(/\b(signal|buy|sell|market|pair)\b/.test(q)){const selected=$('symbol').selectedOptions[0]?.dataset.watch||'XAUUSD';return marketInfo(WATCHLIST.find(x=>x.key===selected)||WATCHLIST[0]);}
    return 'I can answer questions about the six live market signals and the U.S. labor dashboard, and run supported app commands. For broader questions, this app needs a secure AI backend; it does not currently have one.';
  }
  $('voiceLauncher').addEventListener('click',()=>{panel.hidden=!panel.hidden;$('voiceLauncher').setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden)input.focus();});
  $('voiceClose').addEventListener('click',()=>{panel.hidden=true;$('voiceLauncher').setAttribute('aria-expanded','false');});
  $('voiceForm').addEventListener('submit',event=>{event.preventDefault();answer(input.value);});
  $('voiceChoice').addEventListener('change',()=>{try{localStorage.setItem('khendzodsit-voice-id',$('voiceChoice').value);}catch{}populateVoices();});
  $('voiceRate').value=(()=>{try{return localStorage.getItem('khendzodsit-voice-rate')||'0.9';}catch{return '0.9';}})();$('voiceRateValue').value=`${Number($('voiceRate').value).toFixed(1)}×`;
  $('voiceRate').addEventListener('input',()=>{$('voiceRateValue').value=`${Number($('voiceRate').value).toFixed(1)}×`;try{localStorage.setItem('khendzodsit-voice-rate',$('voiceRate').value);}catch{}});
  $('voiceMic').addEventListener('click',()=>{
    if(!Recognition){status.textContent='Voice input is unavailable in this browser. Type your question instead.';return;}
    if(listening){recognition.stop();return;}
    recognition=new Recognition();recognition.lang=navigator.language||'en-US';recognition.continuous=false;recognition.interimResults=false;
    recognition.onstart=()=>{listening=true;$('voiceMic').classList.add('listening');status.textContent='Listening… say a market name or app command.';};
    recognition.onresult=event=>{const transcript=event.results?.[0]?.[0]?.transcript||'';input.value=transcript;answer(transcript);};
    recognition.onerror=event=>{status.textContent=event.error==='not-allowed'?'Microphone access is blocked. Allow it in Chrome site settings.':`Voice input error: ${event.error}. You can type instead.`;};
    recognition.onend=()=>{listening=false;$('voiceMic').classList.remove('listening');if(status.textContent==='Listening… say a market name or app command.')status.textContent='Voice works in supported browsers. Text commands are available too.';};
    try{recognition.start();}catch{status.textContent='Could not start voice input. Type your question instead.';}
  });
  populateVoices();if('speechSynthesis'in window)speechSynthesis.addEventListener?.('voiceschanged',populateVoices);
})();
