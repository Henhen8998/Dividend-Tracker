const {test}=require('node:test');const assert=require('node:assert/strict');
const c=require('../src/Core.js');
const now=Date.parse('2026-10-20T16:00:00Z');
const position=(symbol,quantity)=>({BrokerageSymbol:symbol,Quantity:quantity,InstrumentType:'stock',InstrumentVerified:true});
const snapshot=(positions)=>({AccountSuffix:'0000',Complete:true,Status:'success',Source:'SYNTHETIC',SnapshotId:'SYNTHETIC-1',RetrievedAt:'2026-10-20T15:00:00Z',Positions:positions});
const payment=(id,net=2,extra={})=>({TransactionID:id,PaymentDate:'2026-10-15',Ticker:'TEST',NetAmount:net,Currency:'USD',Status:'paid',EntryType:'dividend',...extra});
const batch=Transactions=>({Source:'SYNTHETIC',AccountSuffix:'0000',Complete:true,Status:'success',Transactions});
test('snapshot is idempotent and order-independent; preference and fractions survive',()=>{
 const old=[{symbol:'TEST',quantity:1,reinvest:'Yes'},{symbol:'BRK.B',quantity:2,reinvest:'No'}];
 const s=snapshot([position('BRK-B','2.123456789'),position('TEST','1.987654321')]);
 const a=c.holdings(s,old,now);assert.equal(a.rows[0].quantity,1.987654321);assert.equal(a.rows[0].reinvest,'Yes');
 assert.deepEqual(c.holdings(s,a.rows,now).rows,a.rows);assert.equal(a.rows[1].symbol,'BRK.B');
});
test('wrong account, partial, failed, stale, future, empty, duplicates, unsupported instruments fail closed',()=>{
 for(const changes of [{AccountSuffix:'9999'},{Complete:false},{Status:'failed'},{RetrievedAt:'2020-01-01T00:00:00Z'},{RetrievedAt:'2027-01-01T00:00:00Z'},{Positions:[]},{Positions:[position('BRK.B',1),position('BRK-B',2)]},{Positions:[{...position('TEST',1),InstrumentVerified:false}]}])assert.throws(()=>c.holdings({...snapshot([position('TEST',1)]),...changes},[],now));
});
test('missing holdings are retained pending review; new preferences default No',()=>{
 const p=c.holdings(snapshot([position('NEW',1)]),[{symbol:'OLD',quantity:3,reinvest:'Yes'}],now);
 assert.deepEqual(p.sold,['OLD']);assert.equal(p.rows[0].quantity,3);assert.equal(p.rows[1].reinvest,'No');
});
test('zero missing holdings only with specific verified reconciliation evidence',()=>{
 const s={...snapshot([]),EmptyVerified:true,VerifiedMissingSymbols:['OLD'],ReconciliationEvidence:'SYNTHETIC reviewed statement'};
 const plan=c.holdings(s,[{symbol:'OLD',quantity:3,reinvest:'Yes'}],now);
 assert.equal(plan.rows[0].quantity,0);assert.deepEqual(plan.unverifiedSold,[]);
 assert.throws(()=>c.holdings({...s,ReconciliationEvidence:''},[{symbol:'OLD',quantity:3}],now));
});
test('zero dividend is distinct from missing; missing and zero prices never produce fake values',()=>{
 assert.equal(c.projection(10,0,0,10,'Yes').distribution,0);
 assert.equal(c.projection(10,null,null,null,'Yes').distribution,null);
 assert.equal(c.projection(10,1,4,0,'Yes').value,null);
 assert.equal(c.projection(10,1,4,0,'No').projected,10);
});
test('DRIP returns projections without mutating actual quantities',()=>{
 const p=c.projection(10,1,12,20,'Yes');assert.equal(p.projected,10.5);assert.equal(p.quantity,10);
 for(let i=0;i<3;i++)assert.deepEqual(c.projection(10,1,12,20,'Yes'),p);
});
test('frequency-aware forward and TTM annualization; unknown cannot silently multiply by four',()=>{
 assert.equal(c.annualize(1,'Monthly','Forward regular'),12);assert.equal(c.annualize(1,'Quarterly','Forward regular'),4);
 assert.equal(c.annualize(1,'Variable','TTM',8.3),8.3);assert.throws(()=>c.annualize(1,'Daily','Forward regular'));
});
test('receipts upsert by stable ID; identical economic payments with distinct IDs both count',()=>{
 const p=c.payments([],batch([payment('1'),payment('2')]));assert.equal(c.aggregate(p).daily['2026-10-15'],4);
 assert.deepEqual(c.payments(p,batch([payment('1'),payment('2')])),p);
 const corrected=c.payments(p,batch([payment('1',3)]));assert.equal(c.aggregate(corrected).lifetime.TEST,5);
});
test('pending excluded, DRIP purchase rejected, reversal explicit and accounted once',()=>{
 let p=c.payments([],batch([payment('1'),payment('2',3,{Status:'pending'})]));assert.equal(c.aggregate(p).lifetime.TEST,2);
 assert.throws(()=>c.payments(p,batch([payment('3',2,{EntryType:'reinvestment'})])));
 p=c.payments(p,batch([payment('rev',-2,{EntryType:'reversal',RelatedTransactionID:'1'})]));assert.equal(c.aggregate(p).lifetime.TEST,0);
 assert.throws(()=>c.payments(p,batch([payment('1',2,{Status:'reversed'})])));
});
test('bad payment batches do not mutate previous ledger',()=>{
 const p=c.payments([],batch([payment('1')])),saved=JSON.stringify(p);
 for(const x of [{...batch([]),AccountSuffix:'9999'},batch([payment('')]),batch([payment('2',2,{Currency:'EUR'})]),batch([payment('2',2,{PaymentDate:'2026-02-30'})]),batch([payment('2',2,{GrossAmount:4,Withholding:1})])])assert.throws(()=>c.payments(p,x));
 assert.equal(JSON.stringify(p),saved);
});
test('calendar validity and leap-year boundaries',()=>{
 assert.equal(c.calendar(2027)[1][28],null);assert.equal(c.calendar(2028)[1][28],'2028-02-29');
 assert.equal(c.calendar(2027)[11][30],'2027-12-31');assert.equal(c.calendar(2028)[0][0],'2028-01-01');
});
test('timeline fills gaps and partial years once and preserves future months',()=>{
 const t=c.timeline(['2026-01','2026-03','2027-01','2027-02','2029-01'],2027);
 assert.equal(t.length,25);assert.ok(t.includes('2026-02'));assert.ok(t.includes('2027-12'));assert.deepEqual(c.timeline(t,2027),t);
 assert.throws(()=>c.timeline(['2027-01','2027-01'],2027));
});
test('timeline does not invent periods before earliest existing history',()=>{
 const months=c.timeline(['2024-08','2024-10'],2024);assert.deepEqual(months,['2024-08','2024-09','2024-10','2024-11','2024-12']);
});
test('legacy daily/monthly remain separate; partial detail never erases legacy',()=>{
 const ledger=c.payments([],batch([payment('1',2)]));
 const h=c.history(ledger,[{date:'2026-10-15',amount:10}],[{symbol:'TEST',month:'2026-10',amount:9}],[]);
 assert.equal(h.daily['2026-10-15'],10);assert.equal(h.monthly['TEST|2026-10'],9);assert.equal(h.lifetime.TEST,9);assert.equal(h.conflicts.length,1);
 assert.throws(()=>c.history(ledger,[{date:'2026-10-15',amount:10}],[{symbol:'TEST',month:'2026-10',amount:9}],[{Month:'2026-10',Complete:true,Approved:true,Evidence:'synthetic'}]));
});
test('reconciled complete detail supersedes once and sold ticker lifetime stays',()=>{
 const ledger=c.payments([],batch([payment('1',2)]));const h=c.history(ledger,[{date:'2026-10-15',amount:2}],[{symbol:'TEST',month:'2026-10',amount:2}],[{Month:'2026-10',Complete:true,Approved:true,Evidence:'synthetic'}]);
 assert.equal(h.lifetime.TEST,2);assert.equal(h.daily['2026-10-15'],2);
});
test('future legacy zeros are not verified coverage; receipts after coverage cutoff remain usable',()=>{
 const ledger=c.payments([],batch([payment('1',2,{PaymentDate:'2027-01-15'})]));
 const h=c.history(ledger,[{date:'2027-01-15',amount:0}],[{symbol:'TEST',month:'2027-01',amount:0}],[],'2026-10-20');
 assert.equal(h.daily['2027-01-15'],2);assert.equal(h.lifetime.TEST,2);assert.equal(h.conflicts.length,0);
});
