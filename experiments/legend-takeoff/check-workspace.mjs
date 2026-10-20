// Controller integration checks in a small DOM harness, using real PDF parsing,
// rendering and scan engine. This is not a browser/visual test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { openPdf } from '../../src/headless/pdfjs-node.ts';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { scanForSimilar } from '../../src/engine/scan.ts';
import { vectorize } from '../../src/engine/vector.ts';
import { nextFlowStep, sampleSetup } from './workspace-flow.ts';
import { moneyCents, priceQuantities } from './pricing.mjs';
import * as navigation from './workspace-view.ts';
import { getTrade } from './trades.mjs';
import * as model from './workspace-model.ts';
import * as projects from './workspace-project.ts';

// Setup prompts distinguish unassessed, unresolved, reviewed and priced states.
const flowBase={open:true,excluded:true,example:true,assessed:false,hits:[],ratesReady:false,otherPending:0,truncated:false};
assert.equal(nextFlowStep({...flowBase,open:false}).action,'sample');
assert.equal(nextFlowStep({...flowBase,excluded:false}).action,'exclude');
assert.equal(nextFlowStep({...flowBase,example:false}).action,'example');
assert.equal(nextFlowStep(flowBase).action,'scan');
assert.equal(nextFlowStep({...flowBase,assessed:true}).action,'manual');
assert.equal(nextFlowStep({...flowBase,assessed:true,hits:[{decision:'unresolved'}]}).action,'review');
assert.equal(nextFlowStep({...flowBase,assessed:true,hits:[{decision:'supported'}],ratesReady:true}).action,'review');
assert.equal(nextFlowStep({...flowBase,assessed:true,hits:[{decision:'confirmed'}]}).action,'price');
assert.equal(nextFlowStep({...flowBase,assessed:true,hits:[{decision:'confirmed'}],ratesReady:true}).action,'export');
assert.equal(nextFlowStep({...flowBase,assessed:true,hits:[{decision:'confirmed'}],ratesReady:true,otherPending:1}).action,'next-type');
assert.equal(nextFlowStep({...flowBase,assessed:true,hits:[{decision:'confirmed'}],ratesReady:true,truncated:true}).action,'review');
const fixtureSetup=JSON.parse(readFileSync(new URL('output/dev-clean/evidence.json',import.meta.url),'utf8'));
assert.ok(sampleSetup(fixtureSetup,fixtureSetup.sourceSha256));
assert.equal(sampleSetup(fixtureSetup,'wrong-document-hash'),null);

const elements=new Map(),downloads=[];
const decode=s=>s.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
class Element {
 constructor(id){this.id=id;this.value='';this.textContent='';this.innerHTML='';this.style={};this.dataset={};this.disabled=false;this.hidden=false;this.clientWidth=1000;this.clientHeight=600;this.scrollLeft=0;this.scrollTop=0;this.handlers={};this.attributes={};}
 addEventListener(name,fn){this.handlers[name]=fn;}
 setAttribute(k,v){this.attributes[k]=v;}
 getAttribute(k){return this.attributes[k]??null;}
 setPointerCapture(){}
 focus(){this.focused=true;}
 getBoundingClientRect(){
  if(this.id==='scroll-area')return{left:0,top:0,width:this.clientWidth,height:this.clientHeight};
  const scroll=elements.get('scroll-area'),width=parseFloat(elements.get('page-wrap').style.width)||600,height=parseFloat(elements.get('page-wrap').style.height)||500;
  return{left:24+Math.max(0,(scroll.clientWidth-48-width)/2)-scroll.scrollLeft,top:24-scroll.scrollTop,width,height};
 }
 querySelectorAll(selector){const key=selector.includes('data-code')?'code':'id';return[...this.innerHTML.matchAll(new RegExp(`data-${key}="([^"]+)"`,'g'))].map(m=>{const e=new Element('');e.dataset[key]=decode(m[1]);return e;});}
 click(){if(this.href)downloads.push({name:this.download,url:this.href});else this.onclick?.();}
}
const html=readFileSync(new URL('workspace.html',import.meta.url),'utf8');
for(const tag of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)){const element=tag[1]==='drawing'?createCanvas(1,1):new Element(tag[1]);element.value=tag[0].match(/value="([^"]*)"/)?.[1]??'';elements.set(tag[1],element);}
elements.get('currency').value='AUD';
const document={getElementById:id=>elements.get(id),createElement:tag=>tag==='canvas'?createCanvas(1,1):new Element(tag)};
const pdfjs={GlobalWorkerOptions:{},OPS,getDocument:options=>({promise:openPdf(options.data)})};
const blobs=new Map();let blobSeq=0;
const windowHandlers={},confirmationMessages=[];let allowDiscard=true;
const context=vm.createContext({document,pdfjs,workerUrl:'/assets/pdf.worker.mjs',PDFDocument,StandardFonts,rgb,scanForSimilar,vectorize,priceQuantities,moneyCents,nextFlowStep,sampleSetup,getTrade,...navigation,...model,...projects,URLSearchParams,
 crypto:webcrypto,Uint8Array,Uint8ClampedArray,ArrayBuffer,Map,Set,Intl,Date,Math,Number,Error,Promise,console,Blob,
 URL:{createObjectURL:blob=>{const id='blob:'+ ++blobSeq;blobs.set(id,blob);return id;},revokeObjectURL:()=>{}},
 setTimeout:()=>0,requestAnimationFrame:fn=>queueMicrotask(fn),window:{devicePixelRatio:1,location:{search:''},confirm:message=>{confirmationMessages.push(message);return allowDiscard;},addEventListener:(name,fn)=>{windowHandlers[name]=fn}},
 fetch:async()=>{throw Error('Unexpected network call');}});
const source=ts.transpileModule(readFileSync(new URL('workspace.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import .*;\n/gm,'');
vm.runInContext(source,context);
const run=code=>vm.runInContext(code,context);
const bytes=new Uint8Array(readFileSync(new URL('output/dev-clean/drawing.pdf',import.meta.url)));
context.testBytes=bytes;
await run('openFile(testBytes,"user-plan.pdf")');
assert.equal(run('doc.numPages'),1);assert.equal(run('documentHash'),createHash('sha256').update(bytes).digest('hex'));
assert.equal(elements.get('scan').disabled,true);
run("sheet().exclusions.push({x0:25,y0:360,x1:390,y1:450});entry().exemplar={x:55,y:415};update()");
assert.equal(elements.get('scan').disabled,false);
await run('scan()');
assert.equal(run('entry().provider'),'vector');
assert.equal(run('quantities(sheet())[0].supported'),3);
assert.equal(run('includedHits(sheet()).length'),3);
const ids=run('entry().hits.map(h=>h.id).join("|")');
await run('scan()');assert.equal(run('entry().hits.map(h=>h.id).join("|")'),ids);
assert.equal(run('quantities(sheet())[0].supported'),3);
// Review decisions alter current quantities and rate-derived prices.
run("rates.DL1={material:'40',labour:'20',source:'Test assumption'};selected=includedHits(sheet())[0].id");
elements.get('flag').onclick();
assert.equal(run('quantities(sheet())[0].supported'),2);
assert.equal(run('quantities(sheet())[0].unresolved'),1);
assert.equal(run('snapshot().pricing.pricedSubtotalCents'),12000);
assert.equal(run('snapshot().pricing.complete'),false);
elements.get('reject').onclick();
assert.equal(run('snapshot().pricing.complete'),false);assert.equal(run('snapshot().pricing.lines.find(l=>l.code==="DL1").status'),'priced');
await run('scan()');assert.equal(run('entry().hits.find(h=>h.id===selected).decision'),'rejected');
// Navigation keeps the screen point anchored and preserves selected evidence.
run('selected=includedHits(sheet())[1].id');const selectedBefore=run('selected');
const screen={x:500,y:300};context.screen=screen;
const anchor=run('pageAnchor(screen,overlay.getBoundingClientRect(),{x:viewport.width,y:viewport.height})');context.savedAnchor=anchor;
elements.get('code').value='DRAFT-CODE';elements.get('description').value='Unsubmitted description';
await run('requestZoom(2,screen)');
assert.equal(elements.get('code').value,'DRAFT-CODE');assert.equal(elements.get('description').value,'Unsubmitted description');
const screenAfter=run('({x:overlay.getBoundingClientRect().left+savedAnchor.x*zoom,y:overlay.getBoundingClientRect().top+savedAnchor.y*zoom})');
assert.ok(Math.hypot(screenAfter.x-screen.x,screenAfter.y-screen.y)<1e-6);
assert.equal(run('selected'),selectedBefore);
await run("fitView('page')");assert.ok(run('viewport.width*zoom<=scrollArea.clientWidth-48+1e-6 && viewport.height*zoom<=scrollArea.clientHeight-48+1e-6'));
await run("fitView('width')");assert.ok(run('Math.abs(viewport.width*zoom-(scrollArea.clientWidth-48))<1e-6'));
run("setMode('pan')");const scroll=elements.get('scroll-area');scroll.scrollLeft=100;scroll.scrollTop=150;
elements.get('overlay').handlers.pointerdown({clientX:300,clientY:200,pointerId:11,button:0,preventDefault(){}});
elements.get('overlay').handlers.pointermove({clientX:250,clientY:170,pointerId:11});assert.equal(scroll.scrollLeft,150);assert.equal(scroll.scrollTop,180);
elements.get('overlay').handlers.pointerup({pointerId:11});assert.equal(run('panStart'),null);
// A text field retains its keys; Space pans only outside editable controls.
windowHandlers.keydown({code:'Space',key:' ',target:{tagName:'INPUT'},preventDefault(){throw Error('Should not intercept text input');}});assert.equal(run('spaceDown'),false);
windowHandlers.keydown({code:'Space',key:' ',target:{tagName:'DIV'},preventDefault(){}});assert.equal(run('spaceDown'),true);windowHandlers.keyup({code:'Space'});assert.equal(run('spaceDown'),false);
// Image-only PDF exercises the real raster adapter and CV fallback, locally.
const imageDoc=await PDFDocument.create();const image=await imageDoc.embedPng(readFileSync(new URL('output/dev-clean/drawing.png',import.meta.url)));
imageDoc.addPage([600,500]).drawImage(image,{x:0,y:0,width:600,height:500});context.imageBytes=await imageDoc.save();
await run('openFile(imageBytes,"raster-plan.pdf")');
run("sheet().exclusions.push({x0:25,y0:360,x1:390,y1:450});entry().exemplar={x:55,y:415}");await run('scan()');
assert.equal(run('entry().provider'),'cv');
// Known engine limitation on this resampled fixture: the exemplar is found, installations missed.
assert.equal(run('quantities(sheet())[0].supported'),0);assert.ok(elements.get('status').textContent.includes('does not establish'));
console.log('KNOWN LIMIT: CV fallback misses installations on this resampled image-only fixture; warning is shown.');
// Coordinate transforms on a rotated, cropped PDF are checked via controller events.
const rotated=await PDFDocument.load(bytes);rotated.getPages()[0].setRotation(degrees(90));rotated.getPages()[0].setCropBox(20,20,560,460);
context.rotatedBytes=await rotated.save();
await run('openFile(rotatedBytes,"rotated-cropped.pdf")');
const point=run('view({x:55,y:415})');
const dimensions=elements.get('overlay').getBoundingClientRect();
const vp=run('({width:viewport.width,height:viewport.height})');
context.pointer={clientX:dimensions.left+point.x/vp.width*dimensions.width,clientY:dimensions.top+point.y/vp.height*dimensions.height};
const converted=run('eventPoint(pointer)');assert.ok(Math.hypot(converted.x-55,converted.y-415)<1e-7);
// Use real pointer handlers to select an example after placing an exclusion.
run("sheet().exclusions.push({x0:25,y0:360,x1:390,y1:450});setMode('example')");
elements.get('overlay').handlers.pointerdown({...context.pointer,pointerId:1});
assert.ok(run('Math.hypot(entry().exemplar.x-55,entry().exemplar.y-415)<1e-7'));
await run('scan()');assert.equal(run('quantities(sheet())[0].supported'),3);
// Export annotations and ensure rejected numbering remains consistent with JSON.
run("selected=includedHits(sheet())[0].id");elements.get('reject').onclick();
await elements.get('save-pdf').onclick();
const exported=downloads.at(-1);assert.ok(exported.name.endsWith('-reviewed.pdf'));
const annotated=await PDFDocument.load(await blobs.get(exported.url).arrayBuffer());assert.equal(annotated.getPageCount(),1);
assert.deepEqual(Array.from(run('snapshot().displayHits.map(h=>h.number)')),[1,2,3]);
// Page state does not transfer exemplar or results across sheets.
const multi=await PDFDocument.load(bytes);multi.addPage([600,500]);context.multiBytes=await multi.save();
await run('openFile(multiBytes,"two-pages.pdf")');
run("sheet().exclusions.push({x0:25,y0:360,x1:390,y1:450});entry().exemplar={x:55,y:415}");await run('scan()');
await run('changePage(2)');assert.equal(run('entry().assessed'),false);assert.equal(run('entry().exemplar'),null);assert.equal(run('sheet().exclusions.length'),0);
await run('changePage(1)');assert.equal(run('quantities(sheet())[0].supported'),3);
// Scanned rasters run through CV rather than a trained/remote detector.
// The fixture and engine's existing raster checks cover that fallback separately.
const truncated={code:'X',description:'',exemplar:null,assessed:true,provider:'vector',note:'',truncated:true,hits:[]};
assert.equal(model.quantities({entries:[truncated],exclusions:[]})[0].unresolved,null);
assert.equal(priceQuantities(model.quantities({entries:[truncated],exclusions:[]}),{X:{material:'1',labour:'0'}}).complete,false);
// Failed replacement PDFs keep the active document and every saved-in-memory quantity/rate.
const beforeDocument=run('doc'),beforeState=run('JSON.stringify({hash:documentHash,sheets,rates,fileName,pageNum})');
const actualLoader=pdfjs.getDocument;let failedCandidateDestroyed=false;
const existingPage=run('page');
pdfjs.getDocument=()=>({promise:Promise.resolve({getPage:async()=>({getViewport:options=>existingPage.getViewport(options),render:()=>({promise:Promise.reject(Error('Injected PDF render failure'))})}),destroy:async()=>{failedCandidateDestroyed=true;}})});
await run('openFile(testBytes,"bad-render.pdf")');
assert.equal(run('doc'),beforeDocument);assert.equal(run('JSON.stringify({hash:documentHash,sheets,rates,fileName,pageNum})'),beforeState);
assert.equal(failedCandidateDestroyed,true);assert.ok(elements.get('status').textContent.includes('retained'));
pdfjs.getDocument=actualLoader;
// A failed page navigation keeps the previous page and evidence selection.
const realGetPage=beforeDocument.getPage.bind(beforeDocument);beforeDocument.getPage=async n=>{if(n===2)throw Error('Injected page failure');return realGetPage(n);};
await run('changePage(2)');assert.equal(run('pageNum'),1);assert.equal(run('doc'),beforeDocument);
beforeDocument.getPage=realGetPage;
// Loading sample bytes holds the busy state; failed fetches do not switch trade/source.
const beforeSample=run('activeTrade.id');let finishFetch;
context.fetch=()=>new Promise(resolve=>{finishFetch=resolve;});
const loadingSample=elements.get('sample').onclick();assert.equal(run('busy'),true);assert.equal(elements.get('pdf-input').disabled,true);
finishFetch({ok:false});await loadingSample;assert.equal(run('activeTrade.id'),beforeSample);assert.equal(run('busy'),false);assert.equal(run('doc'),beforeDocument);
// A scanner finding a previously manual item must retain its identity and human decision.
for(const decision of ['confirmed','rejected']){
 const point={x:123,y:234},id=model.hitId('source',1,'MAN',point);
 const e={code:'MAN',description:'',exemplar:point,assessed:true,provider:'vector',note:'',truncated:false,hits:[{...point,id,code:'MAN',page:1,method:'manual',manual:true,decision}]};
 model.replaceScan(e,[{x:123.5,y:234.2}],'source',1);
 assert.equal(e.hits.length,1);assert.equal(e.hits[0].id,id);assert.equal(e.hits[0].manual,true);assert.equal(e.hits[0].decision,decision);
}
console.log('PASS: failed-file/page recovery, serialized sample loading, draft-input retention and manual-review preservation');
// Trade selection adds editable items without discarding existing evidence.
elements.get('trade-select').value='plumbing';elements.get('trade-select').onchange();
assert.equal(run('currentCode'),'WC');assert.equal(run('snapshot().trade'),'plumbing');assert.ok(run('sheet().entries.some(e=>e.code==="DL1"&&e.assessed)'));
assert.equal(run('entry().assessed'),false);assert.equal(run('entry().description'),'Toilet fixture');
// General builder presets are available without erasing other trade results.
elements.get('trade-select').value='general-builders';elements.get('trade-select').onchange();
assert.equal(run('currentCode'),'D01');assert.equal(run('snapshot().trade'),'general-builders');
assert.equal(run('entry().description'),'Door set');
assert.ok(run('sheet().entries.some(e=>e.code==="DL1"&&e.assessed)'));
assert.ok(run('sheet().entries.some(e=>e.code==="W01")'));
console.log('PASS: navigation anchors, panning, fit modes, selection retention, keyboard text-input protection and trade presets');
console.log('PASS: real PDF open/render/scan, exclusions, stable reruns, review-to-price, rotated crop coordinates, annotated export, page isolation and truncation coverage');
// Guided sample loads verified setup only, never saved detector hits or quantities.
context.fetch=async url=>url.endsWith('drawing.pdf')?{ok:true,arrayBuffer:async()=>bytes.slice().buffer}:{ok:true,json:async()=>fixtureSetup};
await elements.get('sample').onclick();
assert.equal(run('initialSetup'),'sample-fixture');
assert.equal(run('sheet().exclusions.length'),1);
assert.ok(run('sheet().entries.every(e=>!e.assessed && e.hits.length===0)'));
assert.equal(run('currentFlow().action'),'scan');
assert.ok(elements.get('status').textContent.includes('No detections are loaded'));
await run('scan()');assert.equal(run('quantities(sheet())[0].supported'),3);assert.equal(run('entry().provider'),'vector');
assert.equal(run('currentFlow().action'),'review');
assert.equal(run('snapshot().initialSetup'),'sample-fixture');
// Complete one type through the guide, then continue into the remaining scope.
for(let i=0;i<3;i++){
 await elements.get('flow-next').onclick();
 assert.equal(elements.get('confirm').focused,true);
 elements.get('confirm').onclick();
}
assert.equal(run('currentFlow().action'),'price');
run("rates.DL1={material:'40',labour:'20',source:'Test assumption'};update()");
assert.equal(run('currentFlow().action'),'next-type');
await elements.get('flow-next').onclick();assert.equal(run('currentCode'),'SO1');
await run('scan()');
run("currentCode='DL1';update()");
assert.equal(run('currentFlow().action'),'next-type'); // Assessed still needs review and rates.
run("sheet().entries.find(e=>e.code==='SO1').inScope=false;update()");
assert.equal(run('currentFlow().action'),'export');
// A mismatched setup hash falls back to manual selection with no guessed coordinates.
context.fetch=async url=>url.endsWith('drawing.pdf')?{ok:true,arrayBuffer:async()=>bytes.slice().buffer}:{ok:true,json:async()=>({...fixtureSetup,sourceSha256:'wrong-document-hash'})};
await elements.get('sample').onclick();
assert.equal(run('initialSetup'),'manual');assert.equal(run('sheet().exclusions.length'),0);assert.equal(run('currentFlow().action'),'exclude');
console.log('PASS: next-action guidance, verified sample setup, fresh scanner results and mismatched-setup fallback');
// Resolving an overlapping classification survives rescanning the rejected type.
await run('openFile(testBytes,"conflicts.pdf")');
run("sheet().exclusions.push({x0:25,y0:360,x1:390,y1:450});entry().exemplar={x:55,y:415}");
await run('scan()');
run("currentCode='SO1';entry().exemplar={x:55,y:415}");await run('scan()');
assert.equal(run('quantities(sheet())[0].supported'),0);
assert.equal(run('snapshot().displayHits[0].effectiveDecision'),'unresolved');
for(const code of ['DL1','SO1']){
 const hitIds=Array.from(run(`includedHits(sheet()).filter(h=>h.code==='${code}').map(h=>h.id)`));
 for(const id of hitIds){context.reviewId=id;run('selectHit(reviewId)');elements.get(code==='DL1'?'confirm':'reject').onclick();}
}
assert.equal(run('quantities(sheet())[0].supported'),3);
await run('scan()');
assert.equal(run('quantities(sheet())[0].supported'),3);
assert.ok(run("includedHits(sheet()).filter(h=>h.code==='DL1').every(h=>h.decision==='confirmed'&&!h.conflict)"));
assert.ok(run("includedHits(sheet()).filter(h=>h.code==='SO1').every(h=>h.decision==='rejected'&&!h.conflict)"));
// CropBox visibility applies to totals and annotations, including rotated pages.
const clipped=await PDFDocument.load(bytes);clipped.getPages()[0].setCropBox(0,300,600,200);clipped.getPages()[0].setRotation(degrees(90));
context.clippedBytes=await clipped.save();await run('openFile(clippedBytes,"clipped.pdf")');
run("sheet().exclusions.push({x0:25,y0:360,x1:390,y1:450});entry().exemplar={x:55,y:415}");await run('scan()');
assert.equal(run('quantities(sheet())[0].supported'),0);
assert.equal(run('snapshot().displayHits.length'),0);
assert.ok(run('entry().lastScan.hits.some(h=>h.y<300)'),'Raw scanner evidence is retained');
// A new exemplar invalidates pricing but preserves the previous scan and reviews.
await run('openFile(testBytes,"example-change.pdf")');
run("sheet().exclusions.push({x0:25,y0:360,x1:390,y1:450});entry().exemplar={x:55,y:415};rates.DL1={material:'40',labour:'20',source:'Regression'}");
await run('scan()');
const clickPdf=(x,y)=>{
 context.testPoint={x,y};
 const point=run('view(testPoint)'),box=elements.get('overlay').getBoundingClientRect(),vp=run('({width:viewport.width,height:viewport.height})');
 elements.get('overlay').handlers.pointerdown({clientX:box.left+point.x/vp.width*box.width,clientY:box.top+point.y/vp.height*box.height,pointerId:99});
};
run("setMode('example')");clickPdf(55,380);
assert.equal(run('entry().stale'),true);
assert.equal(run('quantities(sheet())[0].supported'),null);
assert.equal(run('snapshot().pricing.lines[0].totalCents'),null);
assert.equal(run('entry().lastScan.exemplar.y'),415);
assert.equal(run('currentFlow().action'),'scan');
const exportCount=downloads.length;await elements.get('save-pdf').onclick();assert.equal(downloads.length,exportCount);
const realScan=context.scanForSimilar;context.scanForSimilar=async()=>({error:'Injected scan failure'});
await run('scan()');assert.equal(run('entry().stale'),true);assert.equal(run('entry().lastScan.exemplar.y'),415);
context.scanForSimilar=realScan;await run('scan()');
assert.equal(run('entry().stale'),false);assert.equal(run('entry().lastScan.exemplar.y'),380);
// Scope is reversible and explicitly exported, without pretending an unused type is zero.
run("currentCode='SO1';update()");elements.get('scope-type').onclick();
assert.equal(run('currentFlow().action'),'scope');
run("currentCode='SW1';update()");elements.get('scope-type').onclick();
assert.equal(run('snapshot().pricing.complete'),true);
assert.equal(run("snapshot().pricing.lines.find(l=>l.code==='SO1').status"),'out-of-scope');
assert.equal(run("quantities(sheet()).find(q=>q.code==='SO1').supported"),null);
elements.get('scope-type').onclick();assert.equal(run('snapshot().pricing.complete'),false);
elements.get('scope-type').onclick();
// Cancelled replacements and failed loads never erase active work.
const protectedState=run('workState()'),protectedDoc=run('doc');
allowDiscard=false;const promptsBefore=confirmationMessages.length;
assert.equal(await run('openFile(testBytes,"replacement.pdf")'),false);
assert.equal(confirmationMessages.length,promptsBefore+1);assert.equal(run('workState()'),protectedState);assert.equal(run('doc'),protectedDoc);
allowDiscard=true;
// Save/load round trip includes every page, shared rates, currency, drafts and review decisions.
await run('openFile(multiBytes,"project-source.pdf")');
run("sheet().exclusions.push({x0:25,y0:360,x1:390,y1:450});entry().exemplar={x:55,y:415};rates.DL1={material:'40',labour:'20',source:'Regression'}");
await run('scan()');run("selected=includedHits(sheet())[0].id");elements.get('reject').onclick();
await run('changePage(2)');run("setMode('manual')");clickPdf(100,100);
run("currentCode='SO1';update()");elements.get('scope-type').onclick();
run("currentCode='DL1';update()");
elements.get('currency').value='USD';
elements.get('code').value='UNSUBMITTED';elements.get('description').value='Retain this draft';
const expectedProjectState=run('workState()');
const expectedTotals=run('JSON.stringify(Object.values(sheets).map(s=>priceQuantities(quantities(s),rates)))');
elements.get('save-project').onclick();
const savedProject=downloads.at(-1);assert.ok(savedProject.name.endsWith('-legend-project.json'));
context.savedProjectText=await blobs.get(savedProject.url).text();
assert.equal(run('hasUnsavedWork()'),false);
const savedBundle=JSON.parse(context.savedProjectText);assert.equal(Object.keys(savedBundle.sheets).length,2);assert.equal('bytes'in savedBundle,false);
await run('openFile(testBytes,"wrong-source.pdf")');
const wrongSourceState=run('workState()');assert.equal(await run('restoreProject(savedProjectText)'),false);
assert.equal(run('workState()'),wrongSourceState);assert.ok(elements.get('status').textContent.includes('different PDF'));
await run('openFile(multiBytes,"project-source.pdf")');
assert.equal(await run('restoreProject(savedProjectText)'),true);
assert.equal(run('pageNum'),2);assert.equal(elements.get('code').value,'UNSUBMITTED');
assert.deepEqual(JSON.parse(run('workState()')),JSON.parse(expectedProjectState));
assert.equal(run('JSON.stringify(Object.values(sheets).map(s=>priceQuantities(quantities(s),rates)))'),expectedTotals);
assert.equal(run('hasUnsavedWork()'),false);
assert.equal(run('sheets[2].entries.find(e=>e.code==="SO1").inScope'),false);
await run('changePage(1)');
assert.equal(run('quantities(sheet())[0].supported'),2);
assert.equal(run('includedHits(sheet())[0].decision'),'rejected');
await run('changePage(2)');
elements.get('material').value='50';elements.get('material').oninput();
const modifiedState=run('workState()');allowDiscard=false;
assert.equal(await run('restoreProject(savedProjectText)'),false);assert.equal(run('workState()'),modifiedState);allowDiscard=true;
// Invalid, future-version, duplicate-ID and inconsistent-page files leave work intact.
for(const text of ['{',JSON.stringify({...savedBundle,schemaVersion:2}),JSON.stringify({...savedBundle,page:99}),
 JSON.stringify({...savedBundle,source:{...savedBundle.source,pageCount:1}}),
 JSON.stringify({...savedBundle,sheets:{...savedBundle.sheets,2:{...savedBundle.sheets[2],entries:[{...savedBundle.sheets[2].entries[0],hits:[...savedBundle.sheets[2].entries[0].hits,...savedBundle.sheets[2].entries[0].hits]}]}}})]){
 context.invalidProjectText=text;assert.equal(await run('restoreProject(invalidProjectText)'),false);assert.equal(run('workState()'),modifiedState);
}
let warned=false;windowHandlers.beforeunload({preventDefault(){warned=true;}});assert.equal(warned,true);
// Number inputs can retain pasted leading zeros beyond the loader's field limit.
// A rejected save must keep the existing unsaved-work warning active.
elements.get('material').value='0'.repeat(101);elements.get('material').oninput();
const beforeInvalidSave=downloads.length;
elements.get('save-project').onclick();
assert.equal(downloads.length,beforeInvalidSave);
assert.equal(run('hasUnsavedWork()'),true);
assert.ok(elements.get('status').textContent.includes('Could not save project'));
let failedSaveWarned=false;windowHandlers.beforeunload({preventDefault(){failedSaveWarned=true;}});
assert.equal(failedSaveWarned,true);
elements.get('material').value='50';elements.get('material').oninput();
elements.get('save-project').onclick();
assert.equal(downloads.length,beforeInvalidSave+1);
assert.equal(projects.parseProject(await blobs.get(downloads.at(-1).url).text()).rates.DL1.material,'50');
assert.equal(run('hasUnsavedWork()'),false);
let savedWorkWarned=false;windowHandlers.beforeunload({preventDefault(){savedWorkWarned=true;}});
assert.equal(savedWorkWarned,false);
console.log('PASS: invalid-save protection, retained unload warning and corrected-save recovery');
console.log('PASS: review preservation, cropped-page counts, stale exemplars, reversible scope, replacement protection and verified all-page project restore');
await run('doc.destroy()');
