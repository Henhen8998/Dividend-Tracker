/* Bound test-copy application. No network requests or brokerage write operations. */
const PORTFOLIO = Object.freeze({holdings:'Dividend Tracker',monthly:'Total Dividend Calendar',daily:'Daily Dividend Calendar',suffix:'0000'});
function config_() {
  const p=PropertiesService.getScriptProperties(), id=p.getProperty('TEST_SPREADSHEET_ID');
  if(!id)throw new Error('Configure TEST_SPREADSHEET_ID first. Live deployment is not enabled.');
  const ss=SpreadsheetApp.getActiveSpreadsheet()||(p.getProperty('SCHEDULE_APPROVAL')==='APPROVED_TEST_COPY_MANUAL_REFRESH_PASSED'?SpreadsheetApp.openById(id):null);
  if(!ss||ss.getId()!==id)throw new Error('Only the explicitly configured bound test copy is allowed.');
  if(ss.getSpreadsheetTimeZone()!=='America/New_York')throw new Error('Test copy timezone must be America/New_York.');
  return {ss,p};
}
function locked_(fn) {
  const lock=LockService.getDocumentLock();if(!lock.tryLock(10000))throw new Error('Another refresh is running.');
  try{return fn();}finally{lock.releaseLock();}
}
function table_(ss,name,headers) {
  let s=ss.getSheetByName(name);
  if(!s){s=ss.insertSheet(name);s.getRange(1,1,1,headers.length).setValues([headers]);s.setFrozenRows(1);}
  if(JSON.stringify(s.getRange(1,1,1,headers.length).getValues()[0])!==JSON.stringify(headers))throw new Error('Unexpected schema: '+name);
  return s;
}
const PAYMENT_HEADERS=['Source','AccountSuffix','TransactionID','PaymentDate','Ticker','GrossAmount','Withholding','NetAmount','CalendarAmount','Currency','Status','ImportedAt','EntryType','RelatedTransactionID'];
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Portfolio Sync').addItem('Setup / validate test copy','setupTestCopy')
    .addItem('Preview holdings import','previewHoldingsChanges').addItem('Apply reviewed holdings import','applyValidatedHoldingsSnapshot')
    .addItem('Import actual payments','importActualDividendPayments').addItem('Refresh projections (never adds actual shares)','reinvestDividends')
    .addItem('Preview legacy migration','previewLegacyMigration').addItem('Refresh reconciled history','refreshHistoryDashboards')
    .addItem('Ensure current-year calendar','ensureCurrentYearCalendar').addItem('Ensure monthly timeline','ensureMonthlyTimeline')
    .addItem('Validate dashboard totals','validateDashboardTotals').addItem('View sync status','viewSyncStatus').addToUi();
  // onOpen creates a menu only. Authorized manual refresh performs rollover.
}
function setupTestCopy() {return locked_(()=>{
  const {ss,p}=config_();Object.values(PORTFOLIO).slice(0,3).forEach(n=>{if(!ss.getSheetByName(n))throw new Error('Missing tab '+n);});
  table_(ss,'Import Staging',['Kind','JSON']);
  table_(ss,'Dividend Transactions',PAYMENT_HEADERS);
  table_(ss,'Dividend Data',['CanonicalSymbol','LatestRegularDistributionPerShare','AnnualDividendPerShare','AnnualizationMethod','Frequency','Currency','AsOf','Source','Status','Price','QuoteTicker']);
  table_(ss,'Sync Log',['Time','Operation','Status','Summary']);
  table_(ss,'Coverage Approvals',['Month','Complete','Approved','Evidence']);
  table_(ss,'Settings',['Setting','Value']);
  const settings=ss.getSheetByName('Settings');
  if(settings.getLastRow()===1)settings.getRange(2,1,5,2).setValues([['Holdings ingestion','MANUAL JSON IMPORT; no unattended brokerage connection'],['Payments ingestion','MANUAL JSON IMPORT; coverage unverified'],['Dividend reference','MANUAL INPUT; not automatic'],['History amount basis','USD net cash credited; includes subsequently reinvested dividends'],['Coverage','Legacy summaries unverified; future zeros do not establish coverage']]);
  if(!p.getProperty('MANAGED_ROWS')){
    const s=ss.getSheetByName(PORTFOLIO.holdings),v=s.getRange('A1:L25').getValues();
    if(v[0][0]!=='Ticker'||v[0][1]!=='Shares Owned'||v.slice(1,24).some(r=>!r[0])||v[24][0])throw new Error('Holdings boundary differs from inspected A2:L24');
    p.setProperty('MANAGED_ROWS','23');
  }
  if(!ss.getSheetByName('Calendar Template')){
    const d=ss.getSheetByName(PORTFOLIO.daily), t=ss.insertSheet('Calendar Template');
    if(t.getMaxColumns()<33)t.insertColumnsAfter(t.getMaxColumns(),33-t.getMaxColumns());
    d.getRange('A1:AG24').copyTo(t.getRange('A1:AG24'));
    t.getRange('C9:AG20').clearContent();t.getRange('B3').clearContent();t.getRange('AE3').clearContent();
    t.getRange('B2').setValue('YEAR Total Dividends');t.getRange('G2').setValue('YEAR Daily Dividend Calendar');t.getRange('B8').clearContent();
    for(let r=1;r<=24;r++)t.setRowHeight(r,d.getRowHeight(r));
    for(let c=1;c<=33;c++)t.setColumnWidth(c,d.getColumnWidth(c));
  }
  log_('setup','success','Test copy configured. No historical replacement, network access or triggers.');
});}
function rows_(){const {ss,p}=config_(),n=Number(p.getProperty('MANAGED_ROWS'));if(!n)throw new Error('Run setup first');return ss.getSheetByName(PORTFOLIO.holdings).getRange(2,1,n,12).getValues().map((r,i)=>({symbol:DividendCore.symbol(r[0]),quantity:r[1],reinvest:r[11],row:i+2}));}
function staged_(kind) {
  const {ss}=config_(),v=ss.getSheetByName('Import Staging').getDataRange().getValues().slice(1).filter(r=>r[0]===kind);
  if(v.length!==1)throw new Error('Paste exactly one '+kind+' JSON object in Import Staging column B');
  if(typeof v[0][1]!=='string')throw new Error('JSON text required');return JSON.parse(v[0][1]);
}
function log_(operation,status,summary){const {ss}=config_();ss.getSheetByName('Sync Log').appendRow([new Date(),operation,status,summary]);}
function digest_(value){return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(value)));}
function previewHoldingsChanges(){return locked_(()=>{
  const snapshot=staged_('holdings'), old=rows_(), plan=DividendCore.holdings(snapshot,old,Date.now()),{ss,p}=config_();
  const s=table_(ss,'Holdings Preview',['Ticker','Old quantity','Proposed quantity','Preference','Action']);s.getRange(2,1,Math.max(1,s.getLastRow()-1),5).clearContent();
  const by=new Map(old.map(x=>[x.symbol,x]));
  const data=plan.rows.map(x=>[x.symbol,by.has(x.symbol)?by.get(x.symbol).quantity:'',x.quantity,x.reinvest,plan.sold.includes(x.symbol)?'MISSING: retained; review required':by.has(x.symbol)?'UPDATE':'NEW']);
  if(data.length)s.getRange(2,1,data.length,5).setValues(data);
  p.setProperty('HOLDINGS_PREVIEW',digest_({snapshot,old}));
  log_('holdings preview','success','Review quantities and missing positions. Missing positions remain unchanged.');return plan;
});}
function backupSheet_(s,label){const {ss}=config_();return s.copyTo(ss).setName(('Backup '+label+' '+Utilities.formatDate(new Date(),'UTC','yyyyMMdd HHmmss')).slice(0,95));}
function applyValidatedHoldingsSnapshot(){return locked_(()=>{
  const {ss,p}=config_(),snapshot=staged_('holdings'),old=rows_();
  if(p.getProperty('HOLDINGS_PREVIEW')!==digest_({snapshot,old}))throw new Error('Preview again: import or holdings changed');
  const plan=DividendCore.holdings(snapshot,old,Date.now());
  if(plan.unverifiedSold.length)throw new Error('Missing positions require separate verified reconciliation. No holdings changed.');
  const s=ss.getSheetByName(PORTFOLIO.holdings),n=old.length;
  backupSheet_(s,'Holdings');
  try {
    if(plan.newSymbols.length){
      s.insertRowsBefore(n+2,plan.newSymbols.length);
      s.getRange(n+1,1,1,12).copyTo(s.getRange(n+2,1,plan.newSymbols.length,12));
      s.getRange(n+2,1,plan.newSymbols.length,12).clearContent();
    }
    s.getRange(2,1,plan.rows.length,2).setValues(plan.rows.map(x=>[x.symbol,x.quantity]));
    s.getRange(2,12,plan.rows.length,1).setValues(plan.rows.map(x=>[x.reinvest]));
    p.setProperty('MANAGED_ROWS',String(plan.rows.length));refreshProjections_();
    s.getCharts().forEach(chart=>{
      const builder=chart.modify().clearRanges();
      chart.getRanges().forEach(r=>builder.addRange(r.getRow()<=24&&r.getColumn()<=12?s.getRange(r.getRow(),r.getColumn(),plan.rows.length+2-r.getRow(),r.getNumColumns()):r));
      s.updateChart(builder.build());
    });
    p.setProperty('LAST_HOLDINGS_SUCCESS',new Date().toISOString());p.deleteProperty('HOLDINGS_PREVIEW');
    log_('holdings','success','Validated snapshot applied. Backup retained.');
  }catch(e){p.setProperty('PARTIAL_FAILURE','Holdings write incomplete; restore latest Backup Holdings tab before retry.');throw e;}
});}
function refreshProjections_(){
  const {ss}=config_(),s=ss.getSheetByName(PORTFOLIO.holdings),rows=rows_();
  const data=ss.getSheetByName('Dividend Data').getDataRange().getValues().slice(1),map=new Map();
  data.filter(r=>r[0]).forEach(r=>{const key=DividendCore.symbol(r[0]);if(map.has(key))throw new Error('Duplicate dividend reference');map.set(key,r);});
  const formulas=rows.map(x=>{
    const r=x.row,ref=map.get(x.symbol),valid=ref&&ref[5]==='USD'&&['verified','stale'].includes(ref[8]);
    const c=valid&&ref[1]!==''?DividendCore.number(ref[1],'latest'):null,a=valid&&ref[2]!==''?DividendCore.number(ref[2],'annual'):null;
    const price=valid&&ref[9]!==''?DividendCore.number(ref[9],'price'):null;
    // Reference inputs are explicit manual/provider values; no exported DUMMYFUNCTION.
    return {r,c,a,price,frequency:valid?ref[4]:'Unknown',status:valid?ref[8]+'; '+ref[3]+'; as of '+ref[6]:'MISSING / UNVERIFIED REFERENCE',quote:valid?ref[10]:''};
  });
  s.getRange('J1').setValue('Est. Next DRIP Shares').setNote('Estimated shares from the next distribution at the displayed price. Projection only.');
  s.getRange('N1').setValue('Reference status');
  formulas.forEach(x=>{
    const r=x.r;
    s.getRange(r,3).setValue(x.c===null?'Missing':x.c);
    s.getRange(r,4,1,3).setFormulas([[`=IF(AND(ISNUMBER(B${r}),ISNUMBER(C${r})),B${r}*C${r},"Missing")`,x.a===null?'="Missing"':`=B${r}*${x.a}`,x.a===null?'="Missing"':`=IF(AND(ISNUMBER(G${r}),G${r}>0),${x.a}/G${r},"Missing")`]]);
    if(x.quote)s.getRange(r,7).setFormula('=IFNA(GOOGLEFINANCE("'+String(x.quote).replace(/"/g,'')+'","price"),"Missing quote")');
    else s.getRange(r,7).setValue(x.price===null?'Missing quote':x.price);
    s.getRange(r,8).setFormula(`=IF(AND(ISNUMBER(B${r}),ISNUMBER(G${r}),G${r}>0),B${r}*G${r},"Missing")`);
    s.getRange(r,9).setValue(x.frequency||'Unknown');
    s.getRange(r,10,1,2).setFormulas([[`=IF(AND(ISNUMBER(D${r}),ISNUMBER(G${r}),G${r}>0),D${r}/G${r},"Missing")`,`=IF(LOWER(L${r})="no",B${r},IF(LOWER(L${r})="yes",IF(ISNUMBER(J${r}),B${r}+J${r},"Missing"),"Invalid preference"))`]]);
    s.getRange(r,14).setValue(x.status);
  });
  // B and L are deliberately never written here.
}
function reinvestDividends(){return locked_(()=>{refreshProjections_();log_('projections','success','Projection-only refresh. Actual quantities unchanged.');});}
function importActualDividendPayments(){return locked_(()=>{
  const {ss,p}=config_(),s=ss.getSheetByName('Dividend Transactions'),old=objects_(s,PAYMENT_HEADERS),batch=staged_('payments');
  const next=DividendCore.payments(old,batch);backupSheet_(s,'Payments');
  try{if(next.length)s.getRange(2,1,next.length,PAYMENT_HEADERS.length).setValues(next.map(x=>PAYMENT_HEADERS.map(k=>x[k]===undefined?'':x[k])));
    SpreadsheetApp.flush();p.setProperty('LAST_PAYMENTS_SUCCESS',new Date().toISOString());log_('payments','success','Imported by source transaction ID. Legacy overlap remains staged.');
  }catch(e){p.setProperty('PARTIAL_FAILURE','Payment write failed. Restore latest Backup Payments.');throw e;}
});}
function objects_(s,headers){return s.getDataRange().getValues().slice(1).filter(r=>r[0]).map(r=>Object.fromEntries(headers.map((k,i)=>[k,r[i] instanceof Date?Utilities.formatDate(r[i],'America/New_York',k==='Month'?'yyyy-MM':'yyyy-MM-dd'):r[i]])));}
function legacy_(){
  const {ss}=config_(),d=ss.getSheetByName(PORTFOLIO.daily),m=ss.getSheetByName(PORTFOLIO.monthly),daily=[],monthly=[],invalid=[];
  const blocks=calendarBlocks_();blocks.forEach(b=>{
    const v=d.getRange(b.header+1,3,12,31).getValues(),dates=DividendCore.calendar(b.year);
    v.forEach((row,i)=>row.forEach((amount,j)=>{if(dates[i][j])daily.push({date:dates[i][j],amount});else if(amount!==''&&amount!==0)invalid.push({row:b.header+1+i,column:3+j,amount});}));
  });
  const months=monthHeaders_(),count=monthlyRowCount_(),tickers=m.getRange(8,1,count,1).getValues();
  months.forEach(x=>m.getRange(8,x.column,count,1).getValues().forEach((r,i)=>{if(tickers[i][0])monthly.push({month:x.month,symbol:DividendCore.symbol(tickers[i][0]),amount:r[0]});else if(r[0]!==''&&r[0]!==0)throw new Error('Unallocated monthly amount');}));
  return {daily,monthly,invalid};
}
function previewLegacyMigration(){return locked_(()=>{
  const {ss,p}=config_(),legacy=legacy_();
  const d=table_(ss,'Legacy Daily Preview',['PaymentDate','Amount']),m=table_(ss,'Legacy Monthly Preview',['Month','Ticker','Amount']);
  if(legacy.daily.length)d.getRange(2,1,legacy.daily.length,2).setValues(legacy.daily.map(x=>[x.date,x.amount]));
  if(legacy.monthly.length)m.getRange(2,1,legacy.monthly.length,3).setValues(legacy.monthly.map(x=>[x.month,x.symbol,x.amount]));
  p.setProperty('MIGRATION_PREVIEW_HASH',digest_(legacy));
  log_('migration preview',legacy.invalid.length?'conflict':'review required','Invalid-date nonzero cells: '+legacy.invalid.length+'. No historical values replaced.');
  return validateDashboardTotals_();
});}
// Explicit separate approval: set APPROVED_MIGRATION_HASH to the reviewed preview
// hash only after user approval and resolving invalid-date entries in the test copy.
function approveLegacyMigration(){return locked_(()=>{
  const {ss,p}=config_(),legacy=legacy_(),hash=digest_(legacy);
  DividendCore.date(p.getProperty('LEGACY_COVERAGE_THROUGH'));
  if(legacy.invalid.length)throw new Error('Resolve invalid-date amounts before migration');
  if(p.getProperty('APPROVED_MIGRATION_HASH')!==hash||p.getProperty('MIGRATION_PREVIEW_HASH')!==hash)throw new Error('Reviewed migration approval required');
  if(p.getProperty('MIGRATED'))return;
  backupSheet_(ss.getSheetByName(PORTFOLIO.daily),'Daily');backupSheet_(ss.getSheetByName(PORTFOLIO.monthly),'Monthly');
  const d=table_(ss,'Legacy Daily Summary',['PaymentDate','Amount']),m=table_(ss,'Legacy Monthly Summary',['Month','Ticker','Amount']);
  d.getRange(2,1,legacy.daily.length,2).setValues(legacy.daily.map(x=>[x.date,x.amount]));
  m.getRange(2,1,legacy.monthly.length,3).setValues(legacy.monthly.map(x=>[x.month,x.symbol,x.amount]));
  p.setProperty('MIGRATED',hash);log_('migration','success','Separate legacy summaries retained; no invented transactions.');
});}
function calendarBlocks_(){
  const {ss}=config_(),s=ss.getSheetByName(PORTFOLIO.daily),v=s.getRange(1,2,s.getLastRow(),1).getValues(),out=[];
  v.forEach((r,i)=>{if(Number.isInteger(r[0])&&r[0]>=2000&&r[0]<=2100)out.push({year:r[0],header:i+1,start:i-6});});
  if(new Set(out.map(x=>x.year)).size!==out.length)throw new Error('Duplicate calendar years');
  return out;
}
function monthHeaders_(){
  const {ss}=config_(),s=ss.getSheetByName(PORTFOLIO.monthly),v=s.getRange(7,3,1,s.getLastColumn()-2).getValues()[0];
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'],out=[];
  v.forEach((x,i)=>{
    if(x==='')return;let key;
    if(x instanceof Date)key=Utilities.formatDate(x,'America/New_York','yyyy-MM');
    else {const match=/^([A-Za-z]+) '(\d{2})$/.exec(x);if(!match||months.indexOf(match[1])<0)throw new Error('Ambiguous month header column '+(i+3));key='20'+match[2]+'-'+String(months.indexOf(match[1])+1).padStart(2,'0');}
    out.push({month:key,column:i+3});
  });
  if(new Set(out.map(x=>x.month)).size!==out.length)throw new Error('Duplicate month headers');return out;
}
function testYear_(){const {p}=config_();const test=p.getProperty('TEST_DATE');if(test)DividendCore.date(test);return Number((test||Utilities.formatDate(new Date(),'America/New_York','yyyy-MM-dd')).slice(0,4));}
function ensureCurrentYearCalendar(){return locked_(()=>ensureCalendar_(testYear_()));}
function ensureCalendar_(year){
  const {ss,p}=config_(),s=ss.getSheetByName(PORTFOLIO.daily),t=ss.getSheetByName('Calendar Template');if(!t)throw new Error('Run setup first');
  let blocks=calendarBlocks_();if(!blocks.length)throw new Error('No known calendar anchor');
  const pending=p.getProperty('CALENDAR_PENDING');
  if(pending){
    const state=JSON.parse(pending),found=blocks.find(b=>b.year===state.year);
    if(found){
      if(found.start!==1||s.getRange('C9:AG20').getValues().some(row=>row.some(v=>typeof v==='number'&&v!==0)))throw new Error('Interrupted populated calendar requires backup review');
      fillCalendarBlock_(s,t,state.year);
    }else{
      if(s.getRange(1,2,24,1).getValues().some(r=>r[0]!==''))throw new Error('Interrupted insertion requires backup review');
      fillCalendarBlock_(s,t,state.year);
    }
    p.deleteProperty('CALENDAR_PENDING');blocks=calendarBlocks_();
  }
  for(let y=Math.max(...blocks.map(b=>b.year))+1;y<=year;y++){
    backupSheet_(s,'Calendar');p.setProperty('CALENDAR_PENDING',JSON.stringify({year:y}));s.insertRowsBefore(1,24);
    fillCalendarBlock_(s,t,y);p.deleteProperty('CALENDAR_PENDING');
  }
  // Verify valid date grid. Existing history is preserved until approved migration.
  log_('calendar rollover','success','Calendar checked through '+year);
}
function fillCalendarBlock_(s,t,y){
  t.getRange('A1:AG24').copyTo(s.getRange('A1:AG24'));
  for(let r=1;r<=24;r++)s.setRowHeight(r,t.getRowHeight(r));
  const dates=DividendCore.calendar(y);s.getRange('C9:AG20').clearContent();
  s.getRange('B2').setValue(y+' Total Dividends');s.getRange('G2').setValue(y+' Daily Dividend Calendar');
  s.getRange('AE2').setValue('Growth vs. Prior Full Year');s.getRange('B8').setValue(y);
  s.getRange('B3').setFormula('=IF(COUNT(C9:AG20)=0,"No verified coverage",SUM(C9:AG20))');s.getRange('AE3').setFormula('=IF(AND(ISNUMBER(B3),ISNUMBER(B27)),IF(B27=0,"N/A",B3/B27-1),"N/A")');
  s.getRange('C9:AG20').setValues(dates.map(row=>row.map(x=>x?'No verified coverage':'')));
  s.getRange('B5').setValue('Partial current year compared with full prior year');
}
function ensureMonthlyTimeline(){return ensureMonthlyTimelineThroughYear(testYear_());}
function ensureMonthlyTimelineThroughYear(year){return locked_(()=>{
  const {ss}=config_(),s=ss.getSheetByName(PORTFOLIO.monthly),existing=monthHeaders_(),all=DividendCore.timeline(existing.map(x=>x.month),year);
  backupSheet_(s,'Timeline');
  all.forEach(key=>{
    let current=monthHeaders_();if(current.some(x=>x.month===key))return;
    const after=current.find(x=>x.month>key),column=after?after.column:Math.max(2,...current.map(x=>x.column))+1;
    if(column>s.getMaxColumns())s.insertColumnsAfter(s.getMaxColumns(),1);else s.insertColumnsBefore(column,1);
    const src=column>3?column-1:column+1;
    const count=monthlyRowCount_();
    s.getRange(6,src,count+2,1).copyTo(s.getRange(6,column,count+2,1));s.setColumnWidth(column,s.getColumnWidth(src));
    s.getRange(8,column,count,1).clearContent();
    const [y,m]=key.split('-').map(Number);s.getRange(7,column).setValue(new Date(y,m-1,1,12)).setNumberFormat("mmmm 'yy");
    const sumRange=s.getRange(8,column,count,1).getA1Notation();s.getRange(6,column).setFormula('=IF(COUNT('+sumRange+')=0,"No verified coverage",SUM('+sumRange+'))');
    s.getRange(8,column,count,1).setValue('No verified coverage');
  });
  monthHeaders_().forEach(x=>{const [y,m]=x.month.split('-').map(Number);s.getRange(7,x.column).setValue(new Date(y,m-1,1,12)).setNumberFormat("mmmm 'yy");});
  s.setFrozenColumns(2);log_('monthly timeline','success','Timeline checked through '+year);
});}
function refreshHistoryDashboards(){return locked_(()=>{
  const {ss,p}=config_();if(!p.getProperty('MIGRATED'))throw new Error('Legacy migration approval required before replacing history');
  if(p.getProperty('PARTIAL_FAILURE'))throw new Error('Resolve partial failure before continuing');
  const d=ss.getSheetByName('Legacy Daily Summary').getDataRange().getValues().slice(1).map(r=>({date:String(r[0]),amount:r[1]}));
  const m=ss.getSheetByName('Legacy Monthly Summary').getDataRange().getValues().slice(1).map(r=>({month:String(r[0]),symbol:r[1],amount:r[2]}));
  const approvals=objects_(ss.getSheetByName('Coverage Approvals'),['Month','Complete','Approved','Evidence']);
  const h=DividendCore.history(objects_(ss.getSheetByName('Dividend Transactions'),PAYMENT_HEADERS),d,m,approvals,p.getProperty('LEGACY_COVERAGE_THROUGH'));
  const daily=ss.getSheetByName(PORTFOLIO.daily),monthly=ss.getSheetByName(PORTFOLIO.monthly);
  let tickerRows=monthly.getRange(8,1,monthlyRowCount_(),1).getValues().map((r,i)=>({symbol:DividendCore.symbol(r[0]),row:i+8})).filter(x=>x.symbol);
  const unknown=Object.keys(h.lifetime).filter(s=>!tickerRows.some(r=>r.symbol===s));
  backupSheet_(daily,'DailyRefresh');backupSheet_(monthly,'MonthlyRefresh');
  try{
    if(unknown.length){
      const count=monthlyRowCount_(),before=8+count;
      monthly.insertRowsBefore(before,unknown.length);
      unknown.forEach((s,i)=>{monthly.getRange(before-1,1,1,monthly.getLastColumn()).copyTo(monthly.getRange(before+i,1,1,monthly.getLastColumn()));monthly.getRange(before+i,1,1,monthly.getLastColumn()).clearContent();monthly.getRange(before+i,1).setValue(s);tickerRows.push({symbol:s,row:before+i});});
      p.setProperty('MONTHLY_ROWS',String(count+unknown.length));
    }
    calendarBlocks_().forEach(b=>{const dates=DividendCore.calendar(b.year);daily.getRange(b.header+1,3,12,31).setValues(dates.map(row=>row.map(date=>!date?'':Object.prototype.hasOwnProperty.call(h.daily,date)?h.daily[date]:'No verified coverage')));});
    monthHeaders_().forEach(x=>tickerRows.forEach(t=>{const k=t.symbol+'|'+x.month;monthly.getRange(t.row,x.column).setValue(Object.prototype.hasOwnProperty.call(h.monthly,k)?h.monthly[k]:'No verified coverage');}));
    tickerRows.forEach(t=>monthly.getRange(t.row,2).setValue(h.lifetime[t.symbol]===undefined?'No verified coverage':h.lifetime[t.symbol]));
    monthHeaders_().forEach(x=>monthly.getRange(6,x.column).setFormula('=SUM('+monthly.getRange(8,x.column,monthlyRowCount_(),1).getA1Notation()+')'));
    p.setProperty('LAST_HISTORY_SUCCESS',new Date().toISOString());log_('history','success','Rebuilt from separate legacy summaries and reconciled detail. Staged overlaps: '+h.conflicts.length);
  }catch(e){p.setProperty('PARTIAL_FAILURE','History write incomplete; restore DailyRefresh and MonthlyRefresh backups');throw e;}
});}
function monthlyRowCount_(){return Number(config_().p.getProperty('MONTHLY_ROWS')||'22');}
function validateDashboardTotals(){return locked_(validateDashboardTotals_);}
function validateDashboardTotals_(){
  const {ss}=config_(),legacy=legacy_(),months=new Set([...legacy.daily.map(x=>x.date.slice(0,7)),...legacy.monthly.map(x=>x.month)]);
  const report=[...months].sort().map(month=>{const daily=legacy.daily.filter(x=>x.date.startsWith(month)).reduce((s,x)=>s+(typeof x.amount==='number'?x.amount:0),0),monthly=legacy.monthly.filter(x=>x.month===month).reduce((s,x)=>s+(typeof x.amount==='number'?x.amount:0),0);return [month,daily,monthly,daily-monthly,Math.abs(daily-monthly)<0.005?'MATCH':'CONFLICT'];});
  const s=table_(ss,'Reconciliation',['Month','Daily','Monthly','Difference','Status']);if(report.length)s.getRange(2,1,report.length,5).setValues(report);
  return {report,invalid:legacy.invalid};
}
function viewSyncStatus(){const {p}=config_();SpreadsheetApp.getUi().alert(JSON.stringify({holdings:p.getProperty('LAST_HOLDINGS_SUCCESS')||'Never',payments:p.getProperty('LAST_PAYMENTS_SUCCESS')||'Never',dividendReference:'Manual, no automatic provider',history:p.getProperty('LAST_HISTORY_SUCCESS')||'Not migrated',partialFailure:p.getProperty('PARTIAL_FAILURE')||'None',scheduling:'Not installed'},null,2));}
function configureAuthorizedTestCopy(){
  const id='YOUR_TEST_SPREADSHEET_ID';
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  if(!ss||ss.getId()!==id)throw new Error('Run only from the authorized bound test-copy project');
  PropertiesService.getScriptProperties().setProperty('TEST_SPREADSHEET_ID',id);
  setupTestCopy();
}
