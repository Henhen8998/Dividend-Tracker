const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function env(){
 const writes=[],properties=new Map([['TEST_SPREADSHEET_ID','TEST-ID'],['MANAGED_ROWS','1']]);
 const prop={getProperty:k=>properties.get(k)||null,setProperty:(k,v)=>properties.set(k,v),deleteProperty:k=>properties.delete(k)};
 const holdings={getRange(...a){const range={getValues:()=>[['TEST',10,1,10,12,0.1,20,200,'Monthly',0.5,10.5,'Yes']],setValue:v=>{writes.push([a,'value',v]);return range;},setNote:v=>range,setFormula:v=>writes.push([a,'formula',v]),setFormulas:v=>writes.push([a,'formulas',v])};return range;}};
 const reference={getDataRange:()=>({getValues:()=>[['CanonicalSymbol'],['TEST',1,12,'Forward regular','Monthly','USD','2026-10-20','SYNTHETIC','verified',20,'']]})};
 const ss={getId:()=> 'TEST-ID',getSpreadsheetTimeZone:()=> 'America/New_York',getSheetByName:n=>n==='Dividend Tracker'?holdings:n==='Dividend Data'?reference:{appendRow:r=>writes.push(['log',r])}};
 const context={console,Date,Map,Set,JSON,PropertiesService:{getScriptProperties:()=>prop},SpreadsheetApp:{getActiveSpreadsheet:()=>ss},LockService:{getDocumentLock:()=>({tryLock:()=>true,releaseLock:()=>{}})}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('src/Core.js','utf8')+'\n'+fs.readFileSync('src/Sheets.gs','utf8')+'\n'+fs.readFileSync('src/Scheduling.gs','utf8'),context);
 return {context,writes,properties};
}
test('compatibility wrapper refreshes managed calculations only, never B or L or outside formulas',()=>{
 const {context,writes}=env();context.reinvestDividends();
 assert.ok(writes.some(w=>Array.isArray(w[0])&&w[0][1]===10));
 assert.ok(!writes.some(w=>Array.isArray(w[0])&&[2,12].includes(w[0][1])));
 assert.ok(writes.some(w=>Array.isArray(w[0])&&w[0][0]==='N1'));
 assert.ok(!writes.some(w=>Array.isArray(w[0])&&String(w[0][0]).startsWith('M')));
});
test('test-copy configuration and scheduling fail closed',()=>{
 const {context,properties}=env();properties.delete('TEST_SPREADSHEET_ID');assert.throws(()=>context.reinvestDividends(),/Configure/);
 properties.set('TEST_SPREADSHEET_ID','WRONG-ID');assert.throws(()=>context.reinvestDividends(),/test copy/);
 properties.set('TEST_SPREADSHEET_ID','TEST-ID');assert.throws(()=>context.installScheduledRefresh(),/approval/);
});
test('all Apps Script modules parse together and have no broker writes, credentials, network adapters or trigger creation on open',()=>{
 const text=['Core.js','Sheets.gs','Scheduling.gs'].map(n=>fs.readFileSync('src/'+n,'utf8')).join('\n');
 new vm.Script(text);assert.doesNotMatch(text,/UrlFetchApp|place_equity_order|cancel_equity_order|password\s*=/);
 const open=text.slice(text.indexOf('function onOpen()'),text.indexOf('function setupTestCopy()'));
 assert.doesNotMatch(open,/\.create\(|ensureCurrentYearCalendar\(\)/);
});
