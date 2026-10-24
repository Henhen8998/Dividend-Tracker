// Local, provider-independent JSON import fallback. Never modifies source workbook.
const fs=require('node:fs');const c=require('../src/Core.js');
const [kind,input,existingFile,output]=process.argv.slice(2);
if(!['holdings','payments'].includes(kind)||!input||!existingFile||!output)throw new Error('Usage: node tools/import-preview.cjs holdings|payments input.json existing.json output.json');
const batch=JSON.parse(fs.readFileSync(input,'utf8')),existing=JSON.parse(fs.readFileSync(existingFile,'utf8'));
const result=kind==='holdings'?c.holdings(batch,existing,Date.now()):c.payments(existing,batch);
fs.writeFileSync(output,JSON.stringify({mode:'MANUAL IMPORT PREVIEW; no external write',result},null,2));
console.log('Validated preview written. No workbook or account changes.');
