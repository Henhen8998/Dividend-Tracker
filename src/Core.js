/* Pure logic shared by Apps Script and Node tests. No brokerage authentication. */
var DividendCore = (() => {
  'use strict';
  const fail = message => { throw new Error(message); };
  const symbol = value => {
    const s = String(value || '').trim().toUpperCase();
    return ({'BRK-B':'BRK.B'})[s] || s;
  };
  function number(value, name, negative) {
    if (value === '' || value === null || value === undefined || typeof value === 'boolean') fail('Missing ' + name);
    if (!/^-?\d+(\.\d+)?$/.test(String(value))) fail('Invalid ' + name);
    const n = Number(value);
    if (!Number.isFinite(n) || (!negative && n < 0) || Math.abs(n)>1e12) fail('Invalid ' + name);
    return n;
  }
  function date(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) fail('PaymentDate must be YYYY-MM-DD');
    const d = new Date(value+'T12:00:00Z');
    if (!Number.isFinite(+d) || d.toISOString().slice(0,10)!==value) fail('Invalid payment date');
    return value;
  }
  function timestamp(value, now) {
    if (!/T.*(Z|[+-]\d\d:\d\d)$/.test(value || '') || !Number.isFinite(Date.parse(value))) fail('Timestamp needs timezone');
    if (Date.parse(value)>now+300000 || now-Date.parse(value)>86400000) fail('Stale or future holdings snapshot');
  }
  function holdings(snapshot, existing, now) {
    if (snapshot.AccountSuffix !== '0000') fail('Wrong account');
    if (snapshot.Complete !== true || snapshot.Status !== 'success') fail('Incomplete holdings snapshot');
    if (!snapshot.SnapshotId || !snapshot.Source) fail('Missing snapshot provenance');
    timestamp(snapshot.RetrievedAt, now);
    if (!Array.isArray(snapshot.Positions)) fail('Missing positions');
    if (!snapshot.Positions.length && snapshot.EmptyVerified !== true) fail('Empty snapshot needs verification');
    const seen = new Set();
    const positions = snapshot.Positions.map(p => {
      const s = symbol(p.CanonicalSymbol || p.BrokerageSymbol);
      if (!/^[A-Z0-9.\-]{1,20}$/.test(s) || seen.has(s)) fail('Invalid or duplicate symbol');
      if (!['stock','etf','listed_security'].includes(p.InstrumentType) || p.InstrumentVerified !== true) fail('Instrument requires verification: '+s);
      seen.add(s);
      return {symbol:s, quantity:number(p.Quantity,'quantity'), quantityText:String(p.Quantity)};
    });
    const old = new Map();
    existing.forEach(p => {const s=symbol(p.symbol); if(old.has(s))fail('Duplicate existing symbol');old.set(s,p);});
    const bySymbol = new Map(positions.map(p => [p.symbol,p]));
    const sold = existing.filter(p=>!bySymbol.has(symbol(p.symbol))).map(p=>symbol(p.symbol));
    const verified=new Set((snapshot.VerifiedMissingSymbols||[]).map(symbol));
    if(verified.size&&(!snapshot.ReconciliationEvidence||[...verified].some(s=>!sold.includes(s))))fail('Invalid missing-position reconciliation');
    const rows = existing.map(p=>({...p,symbol:symbol(p.symbol),quantity:bySymbol.has(symbol(p.symbol))?bySymbol.get(symbol(p.symbol)).quantity:verified.has(symbol(p.symbol))?0:p.quantity}));
    positions.filter(p=>!old.has(p.symbol)).forEach(p=>rows.push({...p,reinvest:'No'}));
    return {rows,sold,unverifiedSold:sold.filter(s=>!verified.has(s)),newSymbols:positions.filter(p=>!old.has(p.symbol)).map(p=>p.symbol),snapshotId:snapshot.SnapshotId};
  }
  function projection(quantity, latest, annual, price, reinvest) {
    const q = number(quantity,'quantity');
    const optional = x => x === '' || x == null ? null : number(x,'reference input');
    const c=optional(latest),a=optional(annual),p=optional(price);
    const d=c===null?null:q*c, j=d===null||p===null||p===0?null:d/p;
    if (!['yes','no'].includes(String(reinvest).toLowerCase())) fail('Invalid reinvest preference');
    return {quantity:q,distribution:d,annual:a===null?null:q*a,yield:a===null||!p?null:a/p,
      value:!p?null:q*p,drip:j,projected:String(reinvest).toLowerCase()==='no'?q:j===null?null:q+j};
  }
  function annualize(latest, frequency, method, verifiedTtm) {
    if(method==='TTM')return number(verifiedTtm,'verified trailing total');
    if(method!=='Forward regular') fail('Unknown annualization method');
    const count={Monthly:12,Quarterly:4,Semiannual:2,Annual:1,None:0}[frequency];
    if(count===undefined)fail('Unknown frequency requires verified annual input');
    return number(latest,'latest regular distribution')*count;
  }
  function payments(existing, batch) {
    if(batch.AccountSuffix!=='0000'||batch.Complete!==true||batch.Status!=='success')fail('Wrong account or incomplete payment batch');
    if(!batch.Source||/[|\r\n]/.test(batch.Source)||!Array.isArray(batch.Transactions))fail('Missing or invalid payment source');
    const records = new Map(existing.map(x=>[x.Source+'|'+x.TransactionID,{...x}]));
    const seen=new Set();
    batch.Transactions.forEach(raw=>{
      const x={...raw,Source:batch.Source,AccountSuffix:'0000'};
      if(raw.AccountSuffix && raw.AccountSuffix!=='0000')fail('Wrong payment account');
      if(!x.TransactionID||/[|\r\n]/.test(x.TransactionID))fail('Stable transaction ID required');
      const key=x.Source+'|'+x.TransactionID;
      if(seen.has(key))fail('Duplicate ID within payment batch');seen.add(key);
      x.PaymentDate=date(x.PaymentDate);x.Ticker=symbol(x.Ticker);
      if(!/^[A-Z0-9.\-]{1,20}$/.test(x.Ticker))fail('Unresolved payment ticker');
      if(x.Currency!=='USD')fail('Unsupported currency');
      if(!['paid','pending','reversed'].includes(x.Status))fail('Unknown payment status');
      if(!['dividend','distribution','reversal'].includes(x.EntryType))fail('Reinvestment purchases are not receipts');
      x.NetAmount=number(x.NetAmount,'net amount',true);
      if(x.NetAmount<0&&x.EntryType!=='reversal')fail('Negative receipt needs reversal type');
      if(x.EntryType==='reversal'&&(!x.RelatedTransactionID||x.NetAmount>=0))fail('Reversal requires linked ID and negative amount');
      if(x.GrossAmount!==''&&x.GrossAmount!=null&&x.Withholding!==''&&x.Withholding!=null) {
        x.GrossAmount=number(x.GrossAmount,'gross',true);x.Withholding=number(x.Withholding,'withholding');
        if(Math.abs(x.GrossAmount-x.Withholding-x.NetAmount)>0.005)fail('Gross/net mismatch');
      }
      x.CalendarAmount=x.Status==='paid'?x.NetAmount:0;
      if(x.EntryType==='reversal'&&x.Status==='paid')x.CalendarAmount=x.NetAmount;
      records.set(key,x);
    });
    const result=[...records.values()];
    result.filter(x=>x.EntryType==='reversal').forEach(x=>{
      const original=records.get(x.Source+'|'+x.RelatedTransactionID);
      if(!original||original.Ticker!==x.Ticker)fail('Unmatched reversal');
      if(original.Status==='reversed'&&x.Status==='paid')fail('Reversal double exclusion: choose original reversal state or separate reversal event');
    });
    return result;
  }
  function aggregate(ledger) {
    const daily={},monthly={},lifetime={};
    ledger.filter(x=>x.AccountSuffix==='0000'&&x.Currency==='USD'&&x.Status==='paid').forEach(x=>{
      const n=number(x.NetAmount,'net',true),month=x.PaymentDate.slice(0,7),s=symbol(x.Ticker);
      daily[x.PaymentDate]=(daily[x.PaymentDate]||0)+n;
      monthly[s+'|'+month]=(monthly[s+'|'+month]||0)+n;
      lifetime[s]=(lifetime[s]||0)+n;
    });
    return {daily,monthly,lifetime};
  }
  function calendar(year) {
    if(!Number.isInteger(year)||year<2000||year>2100)fail('Invalid year');
    return Array.from({length:12},(_,m)=>Array.from({length:31},(_,d)=>d<new Date(Date.UTC(year,m+1,0)).getUTCDate()?`${year}-${String(m+1).padStart(2,'0')}-${String(d+1).padStart(2,'0')}`:null));
  }
  function timeline(existing, year) {
    const unique=new Set(existing);
    if(unique.size!==existing.length)fail('Duplicate month headers');
    existing.forEach(m=>date(m+'-01'));
    if(!Number.isInteger(year)||year<2000||year>2100)fail('Invalid timeline year');
    const earliest=existing.length?[...existing].sort()[0]:year+'-01';
    const start=Number(earliest.slice(0,4));
    for(let y=start;y<=year;y++)for(let m=1;m<=12;m++){const key=`${y}-${String(m).padStart(2,'0')}`;if(key>=earliest)unique.add(key);}
    return [...unique].sort();
  }
  // Whole-month legacy precedence: no partial-detail overlay is permitted.
  function history(ledger, legacyDaily, legacyMonthly, approvals, coverageThrough) {
    if(coverageThrough){date(coverageThrough);legacyDaily=legacyDaily.filter(x=>x.date<=coverageThrough);legacyMonthly=legacyMonthly.filter(x=>x.month<=coverageThrough.slice(0,7));}
    const a=aggregate(ledger), daily={},monthly={}, conflicts=[];
    const legacyMonths=new Set([...legacyDaily.map(x=>x.date.slice(0,7)),...legacyMonthly.map(x=>x.month)]);
    const detailMonths=new Set(ledger.filter(x=>x.Status==='paid').map(x=>x.PaymentDate.slice(0,7)));
    const approved=new Set();
    (approvals||[]).forEach(p=>{
      date(p.Month+'-01');
      if(!p.Complete || !p.Approved || !p.Evidence)fail('Coverage approval needs completeness and evidence');
      const dt=Object.entries(a.daily).filter(([k])=>k.startsWith(p.Month)).reduce((s,[,v])=>s+v,0);
      const ld=legacyDaily.filter(x=>x.date.startsWith(p.Month)).reduce((s,x)=>s+Number(x.amount||0),0);
      const lm=legacyMonthly.filter(x=>x.month===p.Month).reduce((s,x)=>s+Number(x.amount||0),0);
      if(legacyMonths.has(p.Month)&&(Math.abs(dt-ld)>0.005||Math.abs(dt-lm)>0.005))fail('Legacy reconciliation conflict: '+p.Month);
      approved.add(p.Month);
    });
    legacyDaily.filter(x=>!approved.has(x.date.slice(0,7))).forEach(x=>daily[x.date]=x.amount);
    legacyMonthly.filter(x=>!approved.has(x.month)).forEach(x=>monthly[symbol(x.symbol)+'|'+x.month]=x.amount);
    for(const month of detailMonths) {
      if(legacyMonths.has(month)&&!approved.has(month)){conflicts.push({month,status:'DETAIL STAGED; LEGACY RETAINED'});continue;}
      Object.entries(a.daily).filter(([k])=>k.startsWith(month)).forEach(([k,v])=>daily[k]=v);
      Object.entries(a.monthly).filter(([k])=>k.endsWith('|'+month)).forEach(([k,v])=>monthly[k]=v);
    }
    const lifetime={};Object.entries(monthly).forEach(([k,v])=>{const s=k.split('|')[0];lifetime[s]=(lifetime[s]||0)+Number(v||0);});
    return {daily,monthly,lifetime,conflicts};
  }
  return {symbol,number,date,holdings,projection,annualize,payments,aggregate,calendar,timeline,history};
})();
if(typeof module!=='undefined')module.exports=DividendCore;
