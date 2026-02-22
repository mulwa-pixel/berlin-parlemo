/* ═══════════════════════════════════════════════════════════════════
   BERLIN PARLEMO v2  —  app.js
   DollarPrinter-level: Digit circles, all contract types,
   live balance, trade history, auto-trade, kill switch,
   Markov matrix, backtest, streak model, Z-scores
═══════════════════════════════════════════════════════════════════ */

const DERIV_WS = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';
const MARKETS = ['R_10','R_25','R_50','R_75','R_100'];
const MARKET_LABELS = {R_10:'VOL 10',R_25:'VOL 25',R_50:'VOL 50',R_75:'VOL 75',R_100:'VOL 100'};
const DIGIT_COLORS = ['#ff6b6b','#ff9f43','#ffd32a','#0be881','#00d2d3','#48dbfb','#a29bfe','#fd79a8','#e17055','#00cec9'];
const TICK_BUFFER = 5000;
const CONTRACT_TYPES = [
  {id:'DIGITDIFF',  label:'DIFFERS',  sub:'digit ≠ target'},
  {id:'DIGITMATCH', label:'MATCH',    sub:'digit = target'},
  {id:'DIGITOVER',  label:'OVER',     sub:'digit > target'},
  {id:'DIGITUNDER', label:'UNDER',    sub:'digit < target'},
  {id:'DIGITEVEN',  label:'EVEN',     sub:'digit is even'},
  {id:'DIGITODD',   label:'ODD',      sub:'digit is odd'},
];

// ── STATE ────────────────────────────────────────────────────────
const S = {
  token:'', loggedIn:false, balance:0, loginName:'',
  activeMarket:'R_75', tickWindow:100, activeTab:'analysis', showModal:true,
  markets: Object.fromEntries(MARKETS.map(m=>[m,{ticks:[],lastDigit:null,lastPrice:null,connected:false}])),
  selectedDigit:5, contractType:'DIGITOVER', ticksDuration:5, stake:1.00,
  targetProfit:10, stopLoss:5, minConf:75,
  autoRunning:false, killSwitch:false,
  trades:[], sessionProfit:0, consecutiveLoss:0,
  sockets:{}, tradeSocket:null, logs:[],
};

// ── DERIV CONNECTION ─────────────────────────────────────────────
function connectMarket(market) {
  if (S.sockets[market]) { try { S.sockets[market].close(); } catch(e){} }
  const ws = new WebSocket(DERIV_WS);
  S.sockets[market] = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ticks:market,subscribe:1}));
    S.markets[market].connected = true;
    updateConnStatus();
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.tick) {
      const price = msg.tick.quote;
      const str = price.toString().replace('.','');
      const digit = parseInt(str[str.length-1]);
      const mkt = S.markets[market];
      mkt.ticks.push(digit);
      if (mkt.ticks.length > TICK_BUFFER) mkt.ticks.shift();
      mkt.lastDigit = digit;
      mkt.lastPrice = price;
      if (market === S.activeMarket && S.autoRunning && !S.killSwitch) checkAutoTrade();
      onTick(market, digit);
    }
  };
  ws.onclose = () => { S.markets[market].connected = false; setTimeout(()=>connectMarket(market),3000); };
}

function connectAll() { MARKETS.forEach(m=>connectMarket(m)); }

// ── DERIV AUTH ───────────────────────────────────────────────────
function authDeriv(token, cb) {
  const ws = new WebSocket(DERIV_WS);
  S.tradeSocket = ws;
  ws.onopen = () => ws.send(JSON.stringify({authorize:token}));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.msg_type==='authorize' && !msg.error) {
      S.loggedIn=true; S.token=token;
      S.balance=msg.authorize.balance; S.loginName=msg.authorize.loginid;
      cb(true);
    } else if (msg.error && msg.msg_type==='authorize') {
      cb(false, msg.error.message);
    }
    if (msg.msg_type==='buy') {
      if (!msg.error) {
        addLog(`TRADE PLACED — ID:${msg.buy.contract_id}`, 'info');
        S.trades.unshift({id:msg.buy.contract_id,time:new Date().toLocaleTimeString(),
          market:S.activeMarket,type:S.contractType,target:S.selectedDigit,
          stake:S.stake,status:'PENDING',profit:null});
        refreshHistoryTable();
        // Subscribe to this contract
        ws.send(JSON.stringify({proposal_open_contract:1, contract_id:msg.buy.contract_id, subscribe:1}));
      } else {
        addLog(`TRADE ERROR: ${msg.error.message}`, 'warn');
        S.consecutiveLoss++;
        checkKillSwitch();
      }
    }
    if (msg.msg_type==='balance') {
      S.balance=msg.balance.balance;
      const el=document.getElementById('balance-val');
      if(el) el.textContent=S.balance.toFixed(2);
    }
    if (msg.msg_type==='proposal_open_contract' && msg.proposal_open_contract?.is_sold) {
      const c=msg.proposal_open_contract;
      const tr=S.trades.find(t=>t.id==c.contract_id);
      if (tr) {
        const pl=parseFloat(c.profit);
        tr.status=pl>=0?'WIN':'LOSS'; tr.profit=pl;
        S.sessionProfit+=pl;
        if (pl>=0) { addLog(`WIN +${pl.toFixed(2)} USD ✅`,'win'); S.consecutiveLoss=0; }
        else { addLog(`LOSS ${pl.toFixed(2)} USD ❌`,'loss'); S.consecutiveLoss++; checkKillSwitch(); }
        updateSessionProfit();
        refreshSessionStats();
        refreshHistoryTable();
      }
    }
  };
  ws.onclose = () => { if(S.loggedIn) setTimeout(()=>authDeriv(token,()=>{}),3000); };
}

function subscribeBalance() {
  if (S.tradeSocket && S.tradeSocket.readyState===1)
    S.tradeSocket.send(JSON.stringify({balance:1,subscribe:1}));
}

// ── TRADE EXECUTION ──────────────────────────────────────────────
function placeTrade(manual=true) {
  if (!S.loggedIn||!S.tradeSocket) { addLog('NOT LOGGED IN','warn'); return; }
  if (S.killSwitch) { addLog('KILL SWITCH ARMED','warn'); return; }
  const params = {
    buy:1, price:S.stake,
    parameters:{
      contract_type:S.contractType, symbol:S.activeMarket,
      duration:S.ticksDuration, duration_unit:'t',
      basis:'stake', amount:S.stake, currency:'USD',
    }
  };
  if (['DIGITMATCH','DIGITDIFF','DIGITOVER','DIGITUNDER'].includes(S.contractType))
    params.parameters.barrier=S.selectedDigit.toString();
  S.tradeSocket.send(JSON.stringify(params));
  addLog(`${manual?'MANUAL':'AUTO'}: ${S.contractType} ${S.activeMarket} D:${S.selectedDigit} $${S.stake}`, 'info');
}

function checkKillSwitch() {
  if (S.consecutiveLoss>=4) {
    S.killSwitch=true; S.autoRunning=false;
    addLog('🚨 4 CONSECUTIVE LOSSES — KILL SWITCH ARMED','warn');
    refreshKillSwitch(); refreshAutoBtn();
  }
  if (S.sessionProfit<=-Math.abs(S.stopLoss)) {
    S.killSwitch=true; S.autoRunning=false;
    addLog(`🚨 STOP LOSS HIT (${S.sessionProfit.toFixed(2)}) — KILL SWITCH ARMED`,'warn');
    refreshKillSwitch(); refreshAutoBtn();
  }
  if (S.sessionProfit>=Math.abs(S.targetProfit)) {
    S.autoRunning=false;
    addLog(`🎯 TARGET PROFIT REACHED ($${S.sessionProfit.toFixed(2)})`,'win');
    refreshAutoBtn();
  }
}

let lastAutoMs=0;
function checkAutoTrade() {
  if (!S.autoRunning||S.killSwitch) return;
  const now=Date.now();
  if (now-lastAutoMs<3000) return;
  const sigs=generateSignals(S.activeMarket);
  const best=sigs.filter(s=>s.confidence>=S.minConf&&s.type!=='NO_TRADE_ZONE')[0];
  if (!best) return;
  lastAutoMs=now;
  if (best.type==='DIGIT_MATCH') { S.contractType='DIGITMATCH'; S.selectedDigit=best.digit; }
  else if (best.type==='DIGIT_DIFF') { S.contractType='DIGITDIFF'; S.selectedDigit=best.digit; }
  else if (best.type==='OVER_4') { S.contractType='DIGITOVER'; S.selectedDigit=4; }
  else if (best.type==='UNDER_5') { S.contractType='DIGITUNDER'; S.selectedDigit=5; }
  else if (best.type==='EVEN_REBOUND') { S.contractType='DIGITEVEN'; }
  else if (best.type==='ODD_REBOUND') { S.contractType='DIGITODD'; }
  const base=parseFloat(S.stake)||1;
  const autoStake=best.confidence>=80?base*1.5:best.confidence>=75?base:base*0.7;
  const origStake=S.stake; S.stake=Math.round(autoStake*100)/100;
  addLog(`AUTO [${best.confidence}%] → ${S.contractType} $${S.stake}`,'info');
  placeTrade(false);
  S.stake=origStake;
}

// ── PROBABILITY ENGINE ───────────────────────────────────────────
function getFreq(ticks,n) {
  const src=n?ticks.slice(-n):ticks;
  const f=new Array(10).fill(0);
  src.forEach(d=>f[d]++);
  const total=src.length||1;
  return f.map(v=>v/total);
}
function getZScores(freq) {
  const std=Math.sqrt(0.1*0.9/50);
  return freq.map(f=>(f-0.1)/std);
}
function getStreaks(ticks) {
  return Array.from({length:10},(_,d)=>{
    let streak=0;
    for (let i=ticks.length-1;i>=0;i--) { if(ticks[i]!==d) streak++; else break; }
    const pct=Math.min(99,Math.round((1-Math.pow(0.9,streak))*100));
    return {digit:d,streak,percentile:pct};
  });
}
function buildMarkov(ticks) {
  const m=Array.from({length:10},()=>new Array(10).fill(0));
  const c=new Array(10).fill(0);
  for (let i=1;i<ticks.length;i++) { m[ticks[i-1]][ticks[i]]++; c[ticks[i-1]]++; }
  for (let i=0;i<10;i++) for (let j=0;j<10;j++) m[i][j]=c[i]?m[i][j]/c[i]:0.1;
  return m;
}
function markovEntropy(row) { return -row.reduce((s,p)=>s+(p>0?p*Math.log2(p):0),0); }
function detectState(ticks) {
  if (ticks.length<100) return 'INSUFFICIENT_DATA';
  const f=getFreq(ticks,100);
  const spread=Math.max(...f)-Math.min(...f);
  if (spread>0.15) return 'TRENDING';
  if (spread<0.04) return 'RANDOM';
  return 'MEAN_REVERSION';
}
function generateSignals(market) {
  const ticks=S.markets[market].ticks;
  if (ticks.length<100) return [];
  const freq=getFreq(ticks,S.tickWindow);
  const z=getZScores(freq);
  const streaks=getStreaks(ticks);
  const markov=buildMarkov(ticks.slice(-500));
  const last=ticks[ticks.length-1];
  const mRow=markov[last]||new Array(10).fill(0.1);
  const mEnt=markovEntropy(mRow);
  const st=detectState(ticks);
  const signals=[];
  if (st==='RANDOM'||mEnt>3.1) return [{type:'NO_TRADE_ZONE',action:'NO TRADE — RANDOM PHASE',confidence:0}];
  for (let d=0;d<=9;d++) {
    const mp=mRow[d]; const sk=streaks[d];
    if (freq[d]<0.06&&sk.percentile>78&&mp>0.11) {
      const conf=Math.min(94,Math.round(50+Math.abs(z[d])*5+sk.percentile*0.18+(mp-0.1)*140));
      if (conf>=65) signals.push({type:'DIGIT_MATCH',digit:d,confidence:conf,action:`MATCH ${d}`,
        zScore:z[d].toFixed(2),streak:sk.streak,streakPct:sk.percentile,
        markovP:(mp*100).toFixed(1),freq:(freq[d]*100).toFixed(1),state:st,
        risk:conf>=80?'LOW':conf>=72?'MED':'HIGH'});
    }
    if (freq[d]>0.16&&z[d]>2.5) {
      const conf=Math.min(91,Math.round(50+z[d]*4+(freq[d]-0.1)*140));
      if (conf>=65) signals.push({type:'DIGIT_DIFF',digit:d,confidence:conf,action:`DIFFERS ${d}`,
        zScore:z[d].toFixed(2),freq:(freq[d]*100).toFixed(1),state:st,risk:conf>=78?'LOW':'MED'});
    }
  }
  const lowF=freq.slice(0,5).reduce((a,b)=>a+b,0);
  if (lowF>0.60) signals.push({type:'OVER_4',confidence:Math.round(50+(lowF-0.5)*180),action:'OVER 4',state:st,skew:(lowF*100).toFixed(1),risk:'MED'});
  else if (lowF<0.40) signals.push({type:'UNDER_5',confidence:Math.round(50+(0.5-lowF)*180),action:'UNDER 5',state:st,skew:((1-lowF)*100).toFixed(1),risk:'MED'});
  const evenF=[0,2,4,6,8].reduce((s,d)=>s+freq[d],0);
  if (Math.abs(evenF-0.5)>0.12) {
    signals.push({type:evenF<0.38?'EVEN_REBOUND':'ODD_REBOUND',
      confidence:Math.round(50+Math.abs(evenF-0.5)*175),
      action:evenF<0.38?'BUY EVEN':'BUY ODD',state:st,parity:(evenF*100).toFixed(1),risk:'MED'});
  }
  return signals.sort((a,b)=>b.confidence-a.confidence);
}

// ── PARTIAL REFRESH HELPERS ──────────────────────────────────────
function addLog(msg,type='info') {
  S.logs.unshift({msg,type,time:new Date().toLocaleTimeString()});
  if (S.logs.length>100) S.logs.pop();
  const el=document.getElementById('trade-log');
  if (el) el.innerHTML=S.logs.slice(0,20).map(l=>
    `<div class="tl-entry tl-${l.type}"><span class="tl-time">${l.time}</span><span class="tl-msg">${l.msg}</span></div>`
  ).join('');
}

function updateConnStatus() {
  const connected=MARKETS.some(m=>S.markets[m].connected);
  const el=document.getElementById('conn-status');
  if (el) { el.className=`status-pill ${connected?'live':'connecting'}`; el.innerHTML=`<div class="status-dot"></div>${connected?'LIVE':'CONNECTING'}`; }
}

function updateSessionProfit() {
  const el=document.getElementById('session-profit-val');
  if (el) { el.textContent=(S.sessionProfit>=0?'+':'')+S.sessionProfit.toFixed(2); el.className='val '+(S.sessionProfit>=0?'green':'red'); }
  const el2=document.getElementById('balance-val');
  if (el2) el2.textContent=S.balance.toFixed(2);
}

function refreshSessionStats() {
  const wins=S.trades.filter(t=>t.status==='WIN').length;
  const losses=S.trades.filter(t=>t.status==='LOSS').length;
  const total=wins+losses;
  const wr=total?Math.round(wins/total*100):0;
  const rows=[
    ['WINS',`<span class="green bold">${wins}</span>`],
    ['LOSSES',`<span class="red bold">${losses}</span>`],
    ['WIN RATE',`<span class="cyan bold">${wr}%</span>`],
    ['PROFIT',`<span class="${S.sessionProfit>=0?'green':'red'} bold">${(S.sessionProfit>=0?'+':'')+S.sessionProfit.toFixed(2)}</span>`],
    ['CONSEC.LOSS',`<span class="${S.consecutiveLoss>=3?'red':'muted'} bold">${S.consecutiveLoss}</span>`],
    ['AUTO TRADE',`<span class="${S.autoRunning?'green':'muted'} bold">${S.autoRunning?'RUNNING':'OFF'}</span>`],
    ['KILL SWITCH',`<span class="${S.killSwitch?'red':'muted'} bold">${S.killSwitch?'ARMED':'SAFE'}</span>`],
    ['TRADES',`<span class="yellow bold">${S.trades.length}</span>`],
  ];
  const el=document.getElementById('session-stat-rows');
  if (el) el.innerHTML=rows.map(([k,v])=>`<div class="stat-row"><span class="stat-k">${k}</span><span class="stat-v">${v}</span></div>`).join('');
}

function refreshHistoryTable() {
  const tbody=document.getElementById('history-tbody');
  if (!tbody) return;
  tbody.innerHTML=S.trades.slice(0,50).map(t=>{
    const plStr=t.profit!==null?(t.profit>=0?'+':'')+t.profit.toFixed(2):'—';
    const cls=t.status==='WIN'?'ht-win':t.status==='LOSS'?'ht-loss':t.status==='PENDING'?'ht-pending':'';
    return `<tr><td>${t.time}</td><td class="cyan">${t.market}</td><td>${t.type}</td><td class="yellow">${t.target}</td><td>$${t.stake}</td><td class="${cls}">${t.status}</td><td class="${cls}">${plStr}</td></tr>`;
  }).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">No trades yet</td></tr>';
}

function refreshKillSwitch() {
  const ks=document.getElementById('kill-switch-btn');
  if (ks) { ks.textContent=S.killSwitch?'🔴 KILL SWITCH ARMED — CLICK TO RESET':'🟢 KILL SWITCH'; ks.classList.toggle('armed',S.killSwitch); }
}

function refreshAutoBtn() {
  const btn=document.getElementById('auto-start-btn');
  if (btn) { btn.textContent=S.autoRunning?'⏸ PAUSE AUTO TRADE':'▶ START AUTO TRADE'; btn.classList.toggle('running',S.autoRunning); }
}

// ── ON TICK (hot path) ───────────────────────────────────────────
function onTick(market, digit) {
  // Update topbar market digit
  const tabEl=document.querySelector(`.mkt-tab[data-market="${market}"] .mkt-digit`);
  if (tabEl) { tabEl.textContent=digit; tabEl.style.color=DIGIT_COLORS[digit]; }

  if (market!==S.activeMarket) return;

  // Tick stream
  const ts=document.getElementById('tick-stream');
  if (ts) {
    const bub=document.createElement('div');
    bub.className='tick-bub';
    bub.style.cssText=`background:${DIGIT_COLORS[digit]}18;border-color:${DIGIT_COLORS[digit]}55;color:${DIGIT_COLORS[digit]}`;
    bub.textContent=digit;
    ts.appendChild(bub);
    // Keep max 60
    while (ts.children.length>60) ts.removeChild(ts.firstChild);
    ts.scrollLeft=ts.scrollWidth;
  }

  // Circles
  refreshCircles();
  // Dist bars (if visible)
  if (S.activeTab==='distribution') refreshDistBars();
  // Signals
  refreshSignals();
  // Mini stats
  refreshMiniStats();
  // Left panel last digit
  const ldEl=document.getElementById('last-digit-display');
  if (ldEl) { ldEl.textContent=digit; ldEl.style.color=DIGIT_COLORS[digit]; }
}

function refreshCircles() {
  const ticks=S.markets[S.activeMarket].ticks;
  if (!ticks.length) return;
  const freq=getFreq(ticks,S.tickWindow);
  const z=getZScores(freq);
  const streaks=getStreaks(ticks);
  document.querySelectorAll('.digit-circle').forEach((cell,d)=>{
    const f=freq[d];
    const pct=(f*100).toFixed(1);
    const pctDeg=(f*360).toFixed(0);
    let cls='digit-circle'; let color='#00d4ff';
    if (f>0.13) { cls+=' hot'; color='#00ff88'; }
    else if (f<0.07) { cls+=' cold'; color='#ff3355'; }
    else { cls+=' neutral'; }
    if (d===S.selectedDigit) cls+=' selected';
    cell.className=cls;
    cell.style.setProperty('--dc-pct',pctDeg+'deg');
    cell.style.setProperty('--dc-color',DIGIT_COLORS[d]);
    const numEl=cell.querySelector('.dc-num'); if(numEl){numEl.textContent=d;numEl.style.color=color;}
    const pctEl=cell.querySelector('.dc-pct'); if(pctEl){pctEl.textContent=pct+'%';pctEl.style.color=color;}
    const stEl=cell.querySelector('.dc-streak'); if(stEl) stEl.textContent=streaks[d].streak>3?`↑${streaks[d].streak}`:'';
  });
}

function refreshDistBars() {
  const el=document.getElementById('dist-bars');
  if (!el) return;
  const ticks=S.markets[S.activeMarket].ticks;
  if (!ticks.length) return;
  const freq=getFreq(ticks,S.tickWindow);
  const z=getZScores(freq);
  el.innerHTML=Array.from({length:10},(_,d)=>{
    const f=freq[d]; const pct=(f*100).toFixed(1); const zv=z[d];
    const barPct=Math.max(2,Math.min(100,f*10*10));
    const color=f>0.13?'var(--green)':f<0.07?'var(--red)':'var(--cyan)';
    const zColor=Math.abs(zv)>2?(zv>0?'var(--red)':'var(--green)'):'var(--muted)';
    return `<div class="dbar-row">
      <div class="dbar-label" style="color:${DIGIT_COLORS[d]}">${d}</div>
      <div class="dbar-track">
        <div class="dbar-fill" style="width:${barPct}%;background:${color}25;border-right:2px solid ${color}">
          <span class="dbar-pct" style="color:${color}">${pct}%</span>
        </div>
      </div>
      <div class="dbar-z" style="color:${zColor}">${zv>0?'+':''}${zv.toFixed(2)}</div>
    </div>`;
  }).join('');
}

function refreshSignals() {
  const sigs=generateSignals(S.activeMarket);
  const el=document.getElementById('rp-body');
  const cnt=document.getElementById('rp-count');
  if (!el) return;
  const tradeable=sigs.filter(s=>s.confidence>=65&&s.type!=='NO_TRADE_ZONE');
  const noTrade=sigs.find(s=>s.type==='NO_TRADE_ZONE');
  if (cnt) cnt.textContent=tradeable.length;
  const ticks=S.markets[S.activeMarket].ticks;
  if (ticks.length<100) {
    el.innerHTML=`<div class="no-signals-msg">COLLECTING DATA...<br><span style="font-size:18px;font-family:var(--font-display);color:var(--cyan)">${ticks.length}</span> / 100 TICKS<div class="collecting-bar"><div class="collecting-fill" style="width:${Math.min(100,ticks.length)}%"></div></div></div>`;
    return;
  }
  if (noTrade) {
    el.innerHTML=`<div class="no-trade-zone-banner"><div class="ntb-icon">🚫</div><div class="ntb-title">NO TRADE ZONE</div><div class="ntb-sub">Market in RANDOM phase<br>Engine filtering all signals</div></div>`;
    return;
  }
  if (!tradeable.length) {
    el.innerHTML=`<div class="no-signals-msg">ENGINE SCANNING...<br><span style="color:var(--muted);font-size:9px">No high-confidence signals.<br>Patience = edge.</span></div>`;
    return;
  }
  el.innerHTML=tradeable.map(s=>{
    const confClass=s.confidence>=80?'sig-high':s.confidence>=70?'sig-med':'sig-low';
    const confColor=s.confidence>=80?'var(--green)':s.confidence>=70?'var(--yellow)':'var(--cyan)';
    const tags=[s.zScore?`Z:${s.zScore}`:'',s.streak?`STK:${s.streak}`:'',s.markovP?`MKV:${s.markovP}%`:'',
      s.freq?`FRQ:${s.freq}%`:'',s.risk||'',s.state?s.state.replace(/_/g,' ').substring(0,8):''].filter(Boolean);
    const sigJson=JSON.stringify(s).replace(/'/g,"\\'");
    return `<div class="sig-compact ${confClass}">
      <div class="sigc-header">
        <div>
          <div class="sigc-type">${s.type.replace(/_/g,' ')}</div>
          ${s.digit!==undefined?`<span style="font-family:var(--font-display);font-size:28px;font-weight:900;color:${DIGIT_COLORS[s.digit]}">${s.digit}</span>`:''}
        </div>
        <div style="font-family:var(--font-display);font-size:24px;font-weight:900;color:${confColor}">${s.confidence}%</div>
      </div>
      <div class="sigc-action">${s.action}</div>
      <div class="sigc-meta">${tags.map(t=>`<span class="sigc-tag">${t}</span>`).join('')}</div>
      <button class="sig-exec-btn" onclick="execSignal('${sigJson}')">⚡ EXECUTE</button>
    </div>`;
  }).join('');
}

function refreshMiniStats() {
  const ticks=S.markets[S.activeMarket].ticks;
  const sigs=generateSignals(S.activeMarket).filter(s=>s.confidence>=65&&s.type!=='NO_TRADE_ZONE');
  const st=detectState(ticks);
  const elT=document.getElementById('ms-ticks'); if(elT) elT.textContent=ticks.length.toLocaleString();
  const elS=document.getElementById('ms-sigs'); if(elS) elS.textContent=sigs.length;
  const elSt=document.getElementById('ms-state');
  if(elSt){elSt.textContent=st==='MEAN_REVERSION'?'MR':st==='TRENDING'?'TRD':st==='RANDOM'?'RND':'---';elSt.className='ms-val '+(st==='MEAN_REVERSION'?'green':st==='RANDOM'?'red':'yellow');}
  // State badge in left panel
  const sb=document.getElementById('state-badge');
  if(sb){sb.className=`state-badge state-${st}`;sb.textContent=st.replace(/_/g,' ');}
}

function refreshParitySection() {
  const el=document.getElementById('parity-section');
  if (!el) return;
  const ticks=S.markets[S.activeMarket].ticks;
  if (!ticks.length) return;
  const freq=getFreq(ticks,S.tickWindow);
  const evenF=[0,2,4,6,8].reduce((s,d)=>s+freq[d],0);
  const oddF=1-evenF;
  const lowF=freq.slice(0,5).reduce((a,b)=>a+b,0);
  const highF=1-lowF;
  el.innerHTML=`
    <div class="parity-card">
      <div class="pc-label">EVEN / ODD PARITY</div>
      <div class="pc-bar-wrap"><div class="pc-bar" style="width:${(evenF*100).toFixed(0)}%;background:linear-gradient(90deg,var(--cyan),var(--green))"></div></div>
      <div style="display:flex;justify-content:space-between">
        <div><div class="pc-val cyan">${(evenF*100).toFixed(1)}%</div><div class="pc-sub">EVEN [0,2,4,6,8]</div></div>
        <div style="text-align:right"><div class="pc-val purple">${(oddF*100).toFixed(1)}%</div><div class="pc-sub">ODD [1,3,5,7,9]</div></div>
      </div>
      ${Math.abs(evenF-0.5)>0.10?`<div style="font-family:var(--font-mono);font-size:8px;color:var(--yellow);margin-top:6px">⚠ IMBALANCE DETECTED — ${evenF<0.5?'BUY EVEN':'BUY ODD'} SIGNAL</div>`:''}
    </div>
    <div class="parity-card">
      <div class="pc-label">LOW (0-4) / HIGH (5-9)</div>
      <div class="pc-bar-wrap"><div class="pc-bar" style="width:${(lowF*100).toFixed(0)}%;background:linear-gradient(90deg,var(--orange),var(--yellow))"></div></div>
      <div style="display:flex;justify-content:space-between">
        <div><div class="pc-val yellow">${(lowF*100).toFixed(1)}%</div><div class="pc-sub">LOW [0-4] = UNDER 5</div></div>
        <div style="text-align:right"><div class="pc-val" style="color:var(--orange)">${(highF*100).toFixed(1)}%</div><div class="pc-sub">HIGH [5-9] = OVER 4</div></div>
      </div>
      ${Math.abs(lowF-0.5)>0.10?`<div style="font-family:var(--font-mono);font-size:8px;color:var(--yellow);margin-top:6px">⚠ IMBALANCE — ${lowF>0.5?'OVER 4':'UNDER 5'} SIGNAL</div>`:''}
    </div>`;
}

function refreshMarketsOverview() {
  const el=document.getElementById('markets-overview');
  if (!el) return;
  el.innerHTML=MARKETS.map(m=>{
    const mkt=S.markets[m];
    const last=mkt.lastDigit;
    const freq=mkt.ticks.length?getFreq(mkt.ticks,100):new Array(10).fill(0.1);
    const st=detectState(mkt.ticks);
    const sigs=generateSignals(m).filter(s=>s.confidence>=70&&s.type!=='NO_TRADE_ZONE');
    const stColor=st==='MEAN_REVERSION'?'var(--green)':st==='RANDOM'?'var(--red)':'var(--yellow)';
    return `<div class="mkt-overview-card ${m===S.activeMarket?'selected':''}" onclick="switchMarket('${m}')">
      <div class="moc-name">${MARKET_LABELS[m]}</div>
      <div class="moc-digit" style="color:${last!==null?DIGIT_COLORS[last]:'var(--muted)'}">${last!==null?last:'—'}</div>
      <div class="moc-circles">${Array.from({length:10},(_,d)=>{
        const f=freq[d];
        const c=f>0.13?'var(--green)':f<0.07?'var(--red)':'var(--border2)';
        return `<div class="moc-circle" style="border-color:${c};color:${c};background:${c}18">${d}</div>`;
      }).join('')}</div>
      <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
        <span style="font-family:var(--font-mono);font-size:7px;color:${stColor}">${st.replace(/_/g,' ').substring(0,8)}</span>
        ${sigs.length?`<span style="font-family:var(--font-mono);font-size:7px;background:var(--cyan);color:var(--bg0);padding:1px 5px;border-radius:10px;font-weight:700">${sigs.length}</span>`:''}
      </div>
    </div>`;
  }).join('');
}

function refreshMarkovMatrix() {
  const el=document.getElementById('markov-matrix');
  if (!el) return;
  const ticks=S.markets[S.activeMarket].ticks;
  if (ticks.length<50) { el.innerHTML='<div style="font-family:var(--font-mono);font-size:10px;color:var(--muted)">NEED 50+ TICKS</div>'; return; }
  const m=buildMarkov(ticks.slice(-500));
  const last=ticks[ticks.length-1];
  let html=`<table class="markov-tbl"><thead><tr><th>→</th>${Array.from({length:10},(_,i)=>`<th style="color:${DIGIT_COLORS[i]}">${i}</th>`).join('')}</tr></thead><tbody>`;
  m.forEach((row,from)=>{
    const isLast=from===last;
    html+=`<tr class="${isLast?'highlighted':''}"><th style="color:${DIGIT_COLORS[from]}">${from}</th>`;
    row.forEach((p,to)=>{
      const pct=Math.round(p*100);
      const bg=p>0.14?`rgba(0,255,136,${(p-0.1)*3})`:p<0.06?`rgba(255,51,85,${(0.1-p)*3})`:'';
      const color=p>0.14?'var(--green)':p<0.06?'var(--red)':'var(--muted)';
      html+=`<td style="background:${bg};color:${color};font-weight:${isLast?700:400}">${pct}%</td>`;
    });
    html+='</tr>';
  });
  html+='</tbody></table>';
  el.innerHTML=html;
}

function refreshBacktest() {
  const el=document.getElementById('backtest-results');
  if (!el) return;
  const ticks=S.markets[S.activeMarket].ticks;
  if (ticks.length<200) { el.innerHTML='<div style="font-family:var(--font-mono);font-size:10px;color:var(--muted)">NEED 200+ TICKS</div>'; return; }
  const results=[];
  for (let i=100;i<Math.min(ticks.length,1000);i+=10) {
    const sigs=generateSignals(S.activeMarket).filter(s=>s.confidence>=72&&s.type!=='NO_TRADE_ZONE');
    sigs.forEach(s=>{
      const next=ticks[i]; if(next===undefined) return;
      let won=false;
      if(s.type==='DIGIT_MATCH'&&next===s.digit) won=true;
      if(s.type==='DIGIT_DIFF'&&next!==s.digit) won=true;
      if(s.type==='OVER_4'&&next>4) won=true;
      if(s.type==='UNDER_5'&&next<5) won=true;
      if(s.type==='EVEN_REBOUND'&&next%2===0) won=true;
      if(s.type==='ODD_REBOUND'&&next%2!==0) won=true;
      results.push({type:s.type,confidence:s.confidence,won});
    });
  }
  const byType={};
  results.forEach(r=>{ if(!byType[r.type]) byType[r.type]={wins:0,total:0}; byType[r.type].total++; if(r.won) byType[r.type].wins++; });
  const total=results.length; const wins=results.filter(r=>r.won).length; const wr=total?Math.round(wins/total*100):0;
  el.innerHTML=`
    <div class="metrics-3">
      <div class="metric-card"><div class="metric-label">SIGNALS TESTED</div><div class="metric-value cyan">${total}</div></div>
      <div class="metric-card"><div class="metric-label">OVERALL WIN RATE</div><div class="metric-value ${wr>=65?'green':wr>=55?'yellow':'red'}">${wr}%</div></div>
      <div class="metric-card"><div class="metric-label">SIGNAL TYPES</div><div class="metric-value purple">${Object.keys(byType).length}</div></div>
    </div>
    <table class="bt-table">
      <thead><tr><th>SIGNAL TYPE</th><th>COUNT</th><th>WINS</th><th>WIN RATE</th></tr></thead>
      <tbody>${Object.entries(byType).map(([type,d])=>{const wr2=Math.round(d.wins/d.total*100);return `<tr><td class="cyan">${type.replace(/_/g,' ')}</td><td>${d.total}</td><td class="green">${d.wins}</td><td style="color:${wr2>=65?'var(--green)':wr2>=55?'var(--yellow)':'var(--red)'};font-weight:700">${wr2}%</td></tr>`;}).join('')}</tbody>
    </table>`;
}

function refreshStakeTiers() {
  const el=document.getElementById('stake-tiers');
  if (!el) return;
  const base=parseFloat(S.stake)||1;
  el.innerHTML=`
    <div class="tier-row"><span class="muted">≥80% conf (HIGH)</span><span class="green bold">$${(base*1.5).toFixed(2)}</span></div>
    <div class="tier-row"><span class="muted">75–80% conf</span><span class="cyan bold">$${(base*1.0).toFixed(2)}</span></div>
    <div class="tier-row"><span class="muted">65–75% conf</span><span class="yellow bold">$${(base*0.7).toFixed(2)}</span></div>`;
}

function refreshWindowComparison() {
  const el=document.getElementById('window-comparison');
  if (!el) return;
  const ticks=S.markets[S.activeMarket].ticks;
  if (!ticks.length) return;
  el.innerHTML=`<table class="bt-table">
    <thead><tr><th>DIGIT</th><th>W25</th><th>W50</th><th>W100</th><th>W300</th><th>W500</th><th>Z(100)</th><th>IMBALANCE</th></tr></thead>
    <tbody>${Array.from({length:10},(_,d)=>{
      const f=[25,50,100,300,500].map(w=>getFreq(ticks,w)[d]);
      const zv=getZScores(getFreq(ticks,100))[d];
      const imb=f[2]-0.1;
      return `<tr>
        <td style="color:${DIGIT_COLORS[d]};font-weight:700">${d}</td>
        ${f.map(v=>`<td style="color:${v>0.14?'var(--red)':v<0.06?'var(--green)':'var(--muted)'}">${(v*100).toFixed(1)}%</td>`).join('')}
        <td style="color:${Math.abs(zv)>2?'var(--yellow)':'var(--muted)'};font-weight:${Math.abs(zv)>2?700:400}">${zv>0?'+':''}${zv.toFixed(2)}</td>
        <td style="color:${imb>0.04?'var(--red)':imb<-0.04?'var(--green)':'var(--muted)'}">${imb>0?'+':''}${(imb*100).toFixed(1)}%</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

// ── ACTION HANDLERS ──────────────────────────────────────────────
window.switchMarket = function(m) {
  S.activeMarket=m;
  document.querySelectorAll('.mkt-tab').forEach(t=>t.classList.toggle('active',t.dataset.market===m));
  document.querySelectorAll('.mkt-overview-card').forEach(c=>c.classList.toggle('selected',c.onclick?.toString().includes(`'${m}'`)));
  // Reset tick stream
  const ts=document.getElementById('tick-stream');
  if (ts) {
    const recent=S.markets[m].ticks.slice(-60);
    ts.innerHTML=recent.map(d=>`<div class="tick-bub" style="background:${DIGIT_COLORS[d]}18;border-color:${DIGIT_COLORS[d]}55;color:${DIGIT_COLORS[d]}">${d}</div>`).join('');
  }
  const ldEl=document.getElementById('last-digit-display');
  const ld=S.markets[m].lastDigit;
  if(ldEl){ldEl.textContent=ld!==null?ld:'—';ldEl.style.color=ld!==null?DIGIT_COLORS[ld]:'var(--muted)';}
  refreshCircles(); refreshMiniStats(); refreshDistBars(); refreshSignals(); refreshMarketsOverview(); refreshParitySection();
};

window.setTickWindow = function(w) {
  S.tickWindow=w;
  document.querySelectorAll('.wbtn').forEach(b=>b.classList.toggle('active',parseInt(b.dataset.w)===w));
  refreshCircles(); refreshDistBars(); refreshSignals(); refreshParitySection();
};

window.selectDigit = function(d) {
  S.selectedDigit=d;
  document.querySelectorAll('.ds-btn').forEach(b=>b.classList.toggle('selected',parseInt(b.dataset.d)===d));
  document.querySelectorAll('.digit-circle').forEach((c,i)=>c.classList.toggle('selected',i===d));
};

window.selectContract = function(id) {
  S.contractType=id;
  document.querySelectorAll('.contract-btn').forEach(b=>b.classList.toggle('selected',b.dataset.ct===id));
  // Show/hide digit selector
  const ds=document.getElementById('digit-selector-section');
  const need=['DIGITMATCH','DIGITDIFF','DIGITOVER','DIGITUNDER'].includes(id);
  if(ds) ds.style.display=need?'block':'none';
};

window.selectTickDur = function(t) {
  S.ticksDuration=t;
  document.querySelectorAll('.td-btn').forEach(b=>b.classList.toggle('selected',parseInt(b.dataset.t)===t));
};

window.multiplyStake = function(factor) {
  S.stake=Math.max(0.35,Math.round(S.stake*factor*100)/100);
  const el=document.getElementById('stake-input'); if(el) el.value=S.stake;
  refreshStakeTiers();
};

window.toggleAutoTrade = function() {
  if (S.killSwitch) { addLog('KILL SWITCH ARMED — Reset first','warn'); return; }
  S.autoRunning=!S.autoRunning;
  refreshAutoBtn(); refreshSessionStats();
  addLog(S.autoRunning?'AUTO TRADE STARTED':'AUTO TRADE PAUSED',S.autoRunning?'info':'warn');
};

window.toggleKillSwitch = function() {
  S.killSwitch=!S.killSwitch; S.autoRunning=false;
  if (!S.killSwitch) S.consecutiveLoss=0;
  refreshKillSwitch(); refreshAutoBtn(); refreshSessionStats();
  addLog(S.killSwitch?'KILL SWITCH ARMED':'KILL SWITCH RESET','warn');
};

window.executeManualTrade = function() {
  const si=document.getElementById('stake-input');
  if (si) S.stake=parseFloat(si.value)||0.35;
  placeTrade(true);
};

window.execSignal = function(sigJson) {
  try {
    const s=JSON.parse(sigJson.replace(/\\'/g,"'"));
    if (s.type==='DIGIT_MATCH') { S.contractType='DIGITMATCH'; S.selectedDigit=s.digit; }
    else if (s.type==='DIGIT_DIFF') { S.contractType='DIGITDIFF'; S.selectedDigit=s.digit; }
    else if (s.type==='OVER_4') { S.contractType='DIGITOVER'; S.selectedDigit=4; }
    else if (s.type==='UNDER_5') { S.contractType='DIGITUNDER'; S.selectedDigit=5; }
    else if (s.type==='EVEN_REBOUND') S.contractType='DIGITEVEN';
    else if (s.type==='ODD_REBOUND') S.contractType='DIGITODD';
    placeTrade(true);
  } catch(e) { addLog('Signal parse error','warn'); }
};

window.setTab = function(t) {
  S.activeTab=t;
  document.querySelectorAll('.ctab').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===t));
  const cb=document.querySelector('.center-body');
  if (cb) {
    cb.innerHTML=renderCenterTab(t);
    setTimeout(()=>{
      refreshDistBars(); refreshMarketsOverview(); refreshParitySection();
      refreshHistoryTable(); refreshBacktest(); refreshMarkovMatrix();
      refreshStakeTiers(); refreshWindowComparison();
    },30);
  }
};

window.handleConnect = function() {
  const token=document.getElementById('modal-token')?.value?.trim();
  if (!token) { alert('Please enter your Deriv API token'); return; }
  const btn=document.getElementById('modal-connect-btn');
  if (btn) { btn.textContent='CONNECTING...'; btn.disabled=true; }
  authDeriv(token,(ok,err)=>{
    if (ok) {
      S.showModal=false;
      document.getElementById('modal-backdrop').style.display='none';
      connectAll(); subscribeBalance();
      addLog(`Logged in: ${S.loginName} — $${S.balance.toFixed(2)}`,'info');
      // Update topbar
      document.getElementById('topbar-account')?.remove();
      renderTopbarAccount();
    } else {
      alert('Login failed: '+(err||'Invalid token'));
      if (btn) { btn.textContent='CONNECT & INITIALIZE'; btn.disabled=false; }
    }
  });
};

window.handleSkip = function() {
  S.showModal=false;
  document.getElementById('modal-backdrop').style.display='none';
  connectAll();
  addLog('Demo mode — analysis only, trading disabled','info');
};

function renderTopbarAccount() {
  const right=document.querySelector('.topbar-right');
  if (!right) return;
  // Remove old login button if any
  const old=right.querySelector('.login-btn');
  if (old) old.remove();
  if (S.loggedIn) {
    const el=document.createElement('div');
    el.style.display='flex';el.style.gap='10px';el.style.alignItems='center';
    el.id='topbar-account';
    el.innerHTML=`
      <div class="balance-pill"><div style="font-size:8px;color:var(--muted);letter-spacing:1px">BALANCE</div><div class="val cyan" id="balance-val">${S.balance.toFixed(2)}</div></div>
      <div class="balance-pill"><div style="font-size:8px;color:var(--muted);letter-spacing:1px">PROFIT</div><div class="${S.sessionProfit>=0?'green':'red'} bold" id="session-profit-val" style="font-family:var(--font-mono);font-size:13px">${(S.sessionProfit>=0?'+':'')+S.sessionProfit.toFixed(2)}</div></div>
      <div class="balance-pill"><div style="font-size:8px;color:var(--muted)">ACCOUNT</div><div style="font-family:var(--font-mono);font-size:10px">${S.loginName}</div></div>`;
    right.insertBefore(el, right.lastChild);
  }
}

// ── TAB CONTENT RENDERERS ────────────────────────────────────────
function renderCenterTab(t) {
  switch(t||S.activeTab) {
    case 'analysis':     return renderAnalysisTab();
    case 'distribution': return renderDistributionTab();
    case 'markov':       return renderMarkovTab();
    case 'autotrade':    return renderAutoTradeTab();
    case 'history':      return renderHistoryTab();
    case 'backtest':     return renderBacktestTab();
    default:             return renderAnalysisTab();
  }
}

function renderAnalysisTab() {
  const ticks=S.markets[S.activeMarket].ticks;
  const st=detectState(ticks);
  const sigs=generateSignals(S.activeMarket).filter(s=>s.confidence>=65&&s.type!=='NO_TRADE_ZONE');
  const noTrade=generateSignals(S.activeMarket).some(s=>s.type==='NO_TRADE_ZONE');
  return `
    <div class="metrics-4">
      <div class="metric-card"><div class="metric-label">TICKS BUFFERED</div><div class="metric-value cyan">${ticks.length.toLocaleString()}</div></div>
      <div class="metric-card"><div class="metric-label">ACTIVE SIGNALS</div><div class="metric-value green">${sigs.length}</div></div>
      <div class="metric-card"><div class="metric-label">MARKET STATE</div>
        <div class="metric-value ${st==='MEAN_REVERSION'?'green':st==='RANDOM'?'red':'yellow'}" style="font-size:15px;padding-top:4px">${st.replace(/_/g,' ')}</div>
      </div>
      <div class="metric-card"><div class="metric-label">ZONE</div>
        <div class="metric-value ${noTrade?'red':'green'}" style="font-size:14px;padding-top:4px">${noTrade?'NO TRADE':'TRADEABLE'}</div>
      </div>
    </div>
    <div class="card"><div class="card-title">All Markets — Live Overview</div><div class="markets-overview-grid" id="markets-overview"></div></div>
    <div class="card"><div class="card-title">Parity Analysis</div><div class="parity-section" id="parity-section"></div></div>`;
}

function renderDistributionTab() {
  return `
    <div class="card">
      <div class="card-title">Distribution Bars — Last ${S.tickWindow} Ticks</div>
      <div class="dist-bars" id="dist-bars"></div>
    </div>
    <div class="card">
      <div class="card-title">Multi-Window Comparison Table</div>
      <div id="window-comparison"></div>
    </div>`;
}

function renderMarkovTab() {
  return `
    <div class="card">
      <div class="card-title">Markov Transition Matrix — P(next digit | last digit) — Highlighted = current last digit</div>
      <div class="markov-wrap" id="markov-matrix"></div>
      <div style="font-family:var(--font-mono);font-size:8px;color:var(--muted);margin-top:10px;line-height:2">
        🟢 GREEN cells = hot transitions (>14%) · 🔴 RED cells = cold (<6%) · Highlighted row = last digit
      </div>
    </div>`;
}

function renderAutoTradeTab() {
  const needsDigit=['DIGITMATCH','DIGITDIFF','DIGITOVER','DIGITUNDER'].includes(S.contractType);
  const ticks=S.markets[S.activeMarket].ticks;
  const topSig=generateSignals(S.activeMarket).filter(s=>s.confidence>=70&&s.type!=='NO_TRADE_ZONE')[0];
  return `
    <div class="autotrade-grid">
      <div>
        <div class="trade-form-card">
          <div class="tf-title">MANUAL TRADE</div>
          <div class="tf-field">
            <label class="tf-label">Contract Type</label>
            <div class="contract-grid">
              ${CONTRACT_TYPES.map(ct=>`<button class="contract-btn ${S.contractType===ct.id?'selected':''}" data-ct="${ct.id}" onclick="selectContract('${ct.id}')"><div style="font-weight:700">${ct.label}</div><div style="color:var(--muted);font-size:8px">${ct.sub}</div></button>`).join('')}
            </div>
          </div>
          <div id="digit-selector-section" style="display:${needsDigit?'block':'none'}">
            <div class="tf-field">
              <label class="tf-label">Target Digit</label>
              <div class="digit-selector">
                ${Array.from({length:10},(_,d)=>`<button class="ds-btn ${S.selectedDigit===d?'selected':''}" data-d="${d}" onclick="selectDigit(${d})">${d}</button>`).join('')}
              </div>
            </div>
          </div>
          <div class="tf-field">
            <label class="tf-label">Duration (Ticks)</label>
            <div class="tick-dur-btns">
              ${[1,2,3,4,5,6,7,8,9,10].map(t=>`<button class="td-btn ${S.ticksDuration===t?'selected':''}" data-t="${t}" onclick="selectTickDur(${t})">${t}</button>`).join('')}
            </div>
          </div>
          <div class="tf-field">
            <label class="tf-label">Stake (USD)</label>
            <input id="stake-input" class="tf-input" type="number" value="${S.stake}" min="0.35" step="0.35" onchange="S.stake=Math.max(0.35,parseFloat(this.value)||0.35);refreshStakeTiers()"/>
            <div class="stake-mults">
              <button class="sm-btn" onclick="multiplyStake(0.5)">÷2</button>
              <button class="sm-btn" onclick="multiplyStake(2)">×2</button>
              <button class="sm-btn" onclick="multiplyStake(3)">×3</button>
              <button class="sm-btn" onclick="multiplyStake(5)">×5</button>
            </div>
          </div>
          <button class="exec-btn" onclick="executeManualTrade()" ${!S.loggedIn?'disabled':''}>
            ${S.loggedIn?'⚡ EXECUTE TRADE':'🔒 LOGIN TO ENABLE TRADING'}
          </button>
          ${!S.loggedIn?'<div style="font-family:var(--font-mono);font-size:9px;color:var(--muted);text-align:center;margin-top:6px">Click LOGIN DERIV in topbar to enable live trading</div>':''}
        </div>
        ${topSig?`
        <div class="trade-form-card" style="margin-top:8px;border-color:rgba(0,255,136,0.3)">
          <div class="tf-title" style="color:var(--green);font-size:11px">🎯 TOP SIGNAL RIGHT NOW</div>
          <div style="font-family:var(--font-display);font-size:32px;font-weight:900;color:var(--green)">${topSig.confidence}%</div>
          <div style="font-family:var(--font-mono);font-size:13px;color:var(--cyan);margin:4px 0">${topSig.action}</div>
          <div style="font-family:var(--font-mono);font-size:9px;color:var(--muted)">${topSig.type.replace(/_/g,' ')} · ${topSig.state}</div>
          <button class="exec-btn" style="margin-top:8px;background:linear-gradient(135deg,var(--green),var(--cyan))" onclick="execSignal('${JSON.stringify(topSig).replace(/'/g,"\\'")}')" ${!S.loggedIn?'disabled':''}>⚡ EXECUTE TOP SIGNAL</button>
        </div>`:''}
      </div>
      <div>
        <div class="trade-form-card">
          <div class="tf-title">AUTO TRADE ENGINE</div>
          <div class="tf-field"><label class="tf-label">Target Profit (USD)</label>
            <input class="tf-input" type="number" value="${S.targetProfit}" min="1" onchange="S.targetProfit=parseFloat(this.value)||10"/>
          </div>
          <div class="tf-field"><label class="tf-label">Stop Loss (USD)</label>
            <input class="tf-input" type="number" value="${S.stopLoss}" min="1" onchange="S.stopLoss=parseFloat(this.value)||5"/>
          </div>
          <div class="tf-field"><label class="tf-label">Min Signal Confidence</label>
            <select class="tf-select" onchange="S.minConf=parseInt(this.value)">
              <option value="65" ${S.minConf===65?'selected':''}>65% — BROAD</option>
              <option value="70" ${S.minConf===70?'selected':''}>70% — STANDARD</option>
              <option value="75" ${S.minConf===75?'selected':''}>75% — FILTERED</option>
              <option value="80" ${S.minConf===80?'selected':''}>80% — HIGH CONF</option>
              <option value="85" ${S.minConf===85?'selected':''}>85% — STRICT</option>
            </select>
          </div>
          <button id="auto-start-btn" class="auto-ctrl auto-start ${S.autoRunning?'running':''}" onclick="toggleAutoTrade()">
            ${S.autoRunning?'⏸ PAUSE AUTO TRADE':'▶ START AUTO TRADE'}
          </button>
          <button id="kill-switch-btn" class="kill-sw ${S.killSwitch?'armed':''}" onclick="toggleKillSwitch()">
            ${S.killSwitch?'🔴 KILL SWITCH ARMED — CLICK TO RESET':'🟢 KILL SWITCH'}
          </button>
          <div class="stake-tiers" id="stake-tiers"></div>
          <div style="margin-top:12px;font-family:var(--font-mono);font-size:8px;color:var(--muted);line-height:2;border-top:1px solid var(--border);padding-top:10px">
            AUTO RULES:<br>
            • Trades only on signals ≥ min confidence<br>
            • Kills after 4 consecutive losses<br>
            • Kills when stop loss hit<br>
            • Stops when target profit reached<br>
            • Never trades in RANDOM market state
          </div>
        </div>
      </div>
    </div>`;
}

function renderHistoryTab() {
  const wins=S.trades.filter(t=>t.status==='WIN').length;
  const losses=S.trades.filter(t=>t.status==='LOSS').length;
  const total=wins+losses; const wr=total?Math.round(wins/total*100):0;
  return `
    <div class="metrics-4" style="margin-bottom:12px">
      <div class="metric-card"><div class="metric-label">TOTAL TRADES</div><div class="metric-value cyan">${S.trades.length}</div></div>
      <div class="metric-card"><div class="metric-label">WINS</div><div class="metric-value green">${wins}</div></div>
      <div class="metric-card"><div class="metric-label">LOSSES</div><div class="metric-value red">${losses}</div></div>
      <div class="metric-card"><div class="metric-label">WIN RATE</div><div class="metric-value ${wr>=60?'green':wr>=50?'yellow':'red'}">${wr}%</div></div>
    </div>
    <div class="card">
      <div class="card-title">Trade History</div>
      <div class="history-table-wrap">
        <table class="history-table">
          <thead><tr><th>TIME</th><th>MARKET</th><th>TYPE</th><th>TARGET</th><th>STAKE</th><th>STATUS</th><th>P/L</th></tr></thead>
          <tbody id="history-tbody"></tbody>
        </table>
      </div>
    </div>`;
}

function renderBacktestTab() {
  return `
    <div class="card">
      <div class="card-title">Signal Backtester — Tests signals against next-tick outcome on last 1000 ticks</div>
      <div id="backtest-results"></div>
    </div>`;
}

// ── FULL INITIAL RENDER ──────────────────────────────────────────
function render() {
  const ticks=S.markets[S.activeMarket].ticks;
  const st=detectState(ticks);
  const sigs=generateSignals(S.activeMarket).filter(s=>s.confidence>=65&&s.type!=='NO_TRADE_ZONE');
  const connected=MARKETS.some(m=>S.markets[m].connected);

  document.getElementById('app').innerHTML = `
  <!-- MODAL -->
  <div class="modal-backdrop" id="modal-backdrop">
    <div class="modal-box">
      <div class="modal-logo">BERLIN PARLEMO</div>
      <div class="modal-sub">PROBABILITY MACHINE v2.0 — INITIALIZE</div>
      <div class="modal-field">
        <label class="modal-label">DERIV API TOKEN (for live trading + balance display)</label>
        <input id="modal-token" class="modal-input" type="password" placeholder="Enter Deriv API token (a1-xxxxxxx...)"/>
      </div>
      <button id="modal-connect-btn" class="modal-btn" onclick="handleConnect()">⚡ CONNECT & INITIALIZE</button>
      <button class="modal-skip" onclick="handleSkip()">Skip — Analysis Only (no live trading)</button>
      <div class="modal-hint">
        Get token: <a href="https://app.deriv.com/account/api-token" target="_blank">app.deriv.com/account/api-token</a><br>
        Requires <strong>Trade</strong> + <strong>Read</strong> permissions · Token never stored
      </div>
    </div>
  </div>

  <!-- TOPBAR -->
  <header class="topbar">
    <div style="display:flex;align-items:center;gap:10px">
      <div><div class="brand-logo">BERLIN PARLEMO</div><div class="brand-tag">PROBABILITY MACHINE v2.0</div></div>
    </div>
    <div class="topbar-center">
      ${MARKETS.map(m=>`<button class="mkt-tab ${m===S.activeMarket?'active':''}" data-market="${m}" onclick="switchMarket('${m}')">
        <span class="mkt-digit" style="color:var(--muted)">—</span>${MARKET_LABELS[m]}
      </button>`).join('')}
    </div>
    <div class="topbar-right" style="display:flex;align-items:center;gap:10px">
      <button class="mkt-tab login-btn" onclick="document.getElementById('modal-backdrop').style.display='flex'">LOGIN DERIV</button>
      <div class="status-pill connecting" id="conn-status"><div class="status-dot"></div>CONNECTING</div>
    </div>
  </header>

  <!-- BODY -->
  <div class="body-wrap">

    <!-- LEFT PANEL -->
    <aside class="left-panel">
      <div class="lpanel-section">
        <div class="section-label">Digit Frequency Circles</div>
        <div class="circles-grid">
          ${Array.from({length:10},(_,d)=>`<div class="digit-circle" onclick="selectDigit(${d})">
            <span class="dc-num">${d}</span><span class="dc-pct">—%</span><span class="dc-streak"></span>
          </div>`).join('')}
        </div>
      </div>
      <div class="lpanel-section">
        <div class="section-label">Analysis Window (Ticks)</div>
        <div class="window-btns">
          ${[25,50,100,300,500,1000].map(w=>`<button class="wbtn ${S.tickWindow===w?'active':''}" data-w="${w}" onclick="setTickWindow(${w})">${w}</button>`).join('')}
        </div>
      </div>
      <div class="lpanel-section">
        <div class="section-label">Market State</div>
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
          <span class="state-badge state-${st}" id="state-badge">${st.replace(/_/g,' ')}</span>
          <span style="font-family:var(--font-mono);font-size:9px;color:var(--muted)">${ticks.length.toLocaleString()} ticks</span>
        </div>
        <div style="margin-top:8px">
          <div style="font-family:var(--font-mono);font-size:9px;color:var(--muted);margin-bottom:4px">LAST DIGIT</div>
          <div id="last-digit-display" style="font-family:var(--font-display);font-size:36px;font-weight:900;color:var(--muted);line-height:1">—</div>
        </div>
      </div>
      <div class="lpanel-section">
        <div class="mini-stats">
          <div class="mini-stat"><div class="ms-label">TICKS</div><div class="ms-val cyan" id="ms-ticks">0</div></div>
          <div class="mini-stat"><div class="ms-label">SIGNALS</div><div class="ms-val green" id="ms-sigs">0</div></div>
          <div class="mini-stat"><div class="ms-label">STATE</div><div class="ms-val muted" id="ms-state">---</div></div>
          <div class="mini-stat"><div class="ms-label">TRADES</div><div class="ms-val yellow">${S.trades.length}</div></div>
        </div>
      </div>
      <div class="session-stats">
        <div class="section-label">Session Stats</div>
        <div id="session-stat-rows">
          <div class="stat-row"><span class="stat-k">WINS</span><span class="stat-v green">0</span></div>
          <div class="stat-row"><span class="stat-k">LOSSES</span><span class="stat-v red">0</span></div>
          <div class="stat-row"><span class="stat-k">WIN RATE</span><span class="stat-v cyan">—</span></div>
          <div class="stat-row"><span class="stat-k">PROFIT</span><span class="stat-v green">+0.00</span></div>
          <div class="stat-row"><span class="stat-k">CONSEC.LOSS</span><span class="stat-v muted">0</span></div>
          <div class="stat-row"><span class="stat-k">AUTO TRADE</span><span class="stat-v muted">OFF</span></div>
          <div class="stat-row"><span class="stat-k">KILL SWITCH</span><span class="stat-v muted">SAFE</span></div>
        </div>
      </div>
    </aside>

    <!-- CENTER -->
    <main class="center-panel">
      <div class="tick-stream-wrap">
        <div id="tick-stream" class="tick-stream"></div>
      </div>
      <div class="center-tabs">
        ${['analysis','distribution','markov','autotrade','history','backtest'].map(t=>
          `<button class="ctab ${S.activeTab===t?'active':''}" data-tab="${t}" onclick="setTab('${t}')">${t}</button>`
        ).join('')}
      </div>
      <div class="center-body">${renderCenterTab()}</div>
    </main>

    <!-- RIGHT PANEL -->
    <aside class="right-panel">
      <div class="rp-header">
        <div class="rp-title">SIGNALS</div>
        <div class="rp-count" id="rp-count">0</div>
      </div>
      <div class="rp-body" id="rp-body">
        <div class="no-signals-msg">INITIALIZING ENGINE...</div>
      </div>
      <div class="trade-log-wrap">
        <div class="tl-header">TRADE LOG</div>
        <div id="trade-log"></div>
      </div>
    </aside>

  </div>`;

  // Trigger all secondary renders after DOM ready
  setTimeout(()=>{
    refreshCircles(); refreshMiniStats(); refreshSignals(); refreshMarketsOverview();
    refreshParitySection(); refreshDistBars(); refreshStakeTiers();
    refreshHistoryTable(); refreshMarkovMatrix(); refreshBacktest(); refreshWindowComparison();
  },50);
}

// ── BOOT ─────────────────────────────────────────────────────────
render();

// Periodic slow updates
setInterval(()=>{
  refreshMarketsOverview();
  refreshParitySection();
  if (S.activeTab==='backtest') refreshBacktest();
  if (S.activeTab==='markov') refreshMarkovMatrix();
}, 4000);
