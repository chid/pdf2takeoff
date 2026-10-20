/// <reference types="vite/client" />
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { vectorize } from '../../src/engine/vector.ts';
import { scanForSimilar } from '../../src/engine/scan.ts';
import type { RasterPage } from '../../src/engine/ports.ts';
import type { Pt } from '../../src/engine/types.ts';
import { anchoredScroll, clampZoom, fitScale, pageAnchor, type XY } from './workspace-view.ts';
import { getTrade } from './trades.mjs';
import { parseProject, projectSheets, type ProjectBundle } from './workspace-project.ts';
import { nextFlowStep, sampleSetup } from './workspace-flow.ts';
import { moneyCents, priceQuantities } from './pricing.mjs';
import { contains, hitId, includedHits, quantities, replaceScan, effectiveDecision, refreshConflicts, selectExemplar, type Bounds, type SheetState, type SymbolEntry, type EvidenceHit } from './workspace-model.ts';
pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const button=(id:string)=>$<HTMLButtonElement>(id), input=(id:string)=>$<HTMLInputElement>(id);
const scrollArea=$('scroll-area');
let activeTrade=getTrade(new URLSearchParams(window.location.search).get('trade'));
function applyTradeLabels(){
 $<HTMLSelectElement>('trade-select').value=activeTrade.id;
 $('trade-badge').textContent=activeTrade.name.toUpperCase()+' / REAL PDF';
 $('trade-heading').textContent=activeTrade.name.toUpperCase()+' / CURRENT PAGE';
 input('code').value=activeTrade.items[0].code;input('description').value=activeTrade.items[0].description;
 $('trade-note').textContent='Suggested codes only. '+activeTrade.outside+' are outside this counting workspace.';
}
applyTradeLabels();
const canvas=$<HTMLCanvasElement>('drawing'),overlay=$<SVGSVGElement & HTMLElement>('overlay');
let doc:PDFDocumentProxy|null=null,bytes:Uint8Array|null=null,documentHash='',fileName='',pageNum=1,page:PDFPageProxy|null=null,viewport:PageViewport|null=null,zoom=1,busy=false,mode='review',selected:string|null=null,currentCode=activeTrade.items[0].code;
let initialSetup:'manual'|'sample-fixture'='manual';
let savedWork='';
let sheets:Record<number,SheetState>={},rates:Record<string,{material:string;labour:string;source:string}>=Object.create(null);
let drag:Pt|null=null,preview:Bounds|null=null,sequence=0;
let spaceDown=false,zooming=false,fitMode:'page'|'width'|null='page';
let panStart:{screen:XY;scroll:XY;pointerId:number}|null=null;
const touches=new Map<number,XY>();
let pinch:{distance:number;zoom:number;anchor:XY}|null=null;
let zoomRequest:{target:number;anchor:XY;screen:XY}|null=null;
const escape=(s:unknown)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function makeEntry(code:string,description=''):SymbolEntry{return{code,description,exemplar:null,assessed:false,provider:null,note:'Not scanned',hits:[],truncated:false};}
const sheet=()=>sheets[pageNum]??(sheets[pageNum]={exclusions:[],entries:activeTrade.items.map(i=>makeEntry(i.code,i.description))});
function entry():SymbolEntry{let e=sheet().entries.find(e=>e.code===currentCode);if(!e){e={code:currentCode,description:'',exemplar:null,assessed:false,provider:null,note:'Not scanned',hits:[],truncated:false};sheet().entries.push(e);}return e;}
function say(text:string,error=false){$('status').textContent=text;$('status').dataset.error=String(error);}
function setBusy(value:boolean){busy=value;syncControls();}
function syncControls(){const ready=!!doc&&!busy;for(const id of ['mode-pan','mode-review','mode-exclude','mode-example','mode-manual','select-type','zoom-in','zoom-out','fit','fit-width','save-json','save-csv','save-pdf','save-project','scope-type'])button(id).disabled=!ready;button('prev').disabled=!ready||pageNum<=1;button('next').disabled=!ready||pageNum>=(doc?.numPages??0);input('page-number').disabled=!ready;button('undo-exclusion').disabled=!ready||!sheet().exclusions.length;button('scan').disabled=!ready||!page||!entry().exemplar||!sheet().exclusions.length||entry().inScope===false;$<HTMLSelectElement>('type-select').disabled=!ready;for(const id of ['pdf-input','empty-input'])input(id).disabled=busy;input('project-input').disabled=!ready;button('sample').disabled=busy;$<HTMLSelectElement>('trade-select').disabled=busy;input('zoom-percent').disabled=!ready;button('zoom-legend').disabled=!ready||!sheet().exclusions.length;button('zoom-selection').disabled=!ready||!(selected||entry().exemplar);for(const id of ['confirm','flag','reject'])button(id).disabled=!ready||!includedHits(sheet()).some(h=>h.id===selected);for(const id of ['mode-example','mode-manual'])button(id).disabled=!ready||entry().inScope===false;renderFlow();}
function setMode(next:string){mode=next;overlay.dataset.mode=mode;for(const m of ['pan','review','exclude','example','manual'])button('mode-'+m).setAttribute('aria-pressed',String(m===mode));if(next==='pan')say('Drag the drawing to move around. Pinch or Ctrl/⌘ + wheel zooms around the pointer.');if(next==='exclude')say('Drag a rectangle around the entire legend. Add more exclusions for repeated legends or schedules.');if(next==='example')say('Click the centre of a clear symbol example on this drawing.');if(next==='manual')say('Click a missed installation to add one manually confirmed item for '+currentCode+'.');}
function view(p:Pt):Pt{const [x,y]=viewport!.convertToViewportPoint(p.x,p.y);return {x,y};}
function eventPoint(event:PointerEvent):Pt{const r=overlay.getBoundingClientRect();const x=(event.clientX-r.left)*viewport!.width/r.width,y=(event.clientY-r.top)*viewport!.height/r.height;const [px,py]=viewport!.convertToPdfPoint(x,y);return{x:px,y:py};}
function svgRect(b:Bounds,temporary=false){const corners=[view({x:b.x0,y:b.y0}),view({x:b.x1,y:b.y1})];return `<rect x="${Math.min(corners[0].x,corners[1].x)}" y="${Math.min(corners[0].y,corners[1].y)}" width="${Math.abs(corners[1].x-corners[0].x)}" height="${Math.abs(corners[1].y-corners[0].y)}" fill="${temporary?'#e7774120':'#7d965b20'}" stroke="${temporary?'#e77741':'#768b50'}" stroke-width="1" stroke-dasharray="4 3"/>`;}
function drawOverlay(){if(!viewport)return;const hits=includedHits(sheet());overlay.innerHTML=sheet().exclusions.map(b=>svgRect(b)).join('')+(preview?svgRect(preview,true):'')+sheet().entries.filter(e=>e.exemplar).map(e=>{const p=view(e.exemplar!);return `<path d="M${p.x-9},${p.y}h18M${p.x},${p.y-9}v18" stroke="#217d6e" stroke-width="2"/>`;}).join('')+hits.map((h,i)=>{const p=view(h),decision=effectiveDecision(h),colour=decision==='rejected'?'#b0523f':decision==='unresolved'?'#c98b22':h.manual||decision==='confirmed'?'#24846b':'#247aa2';return `<g><circle data-hit="${escape(h.id)}" cx="${p.x}" cy="${p.y}" r="${selected===h.id?12:10}" fill="${colour}20" stroke="${colour}" stroke-width="${selected===h.id?2.5:1.3}" ${h.decision==='rejected'?'stroke-dasharray="3 2"':''}/><text x="${p.x+11}" y="${p.y-10}" fill="${colour}" font-size="9" pointer-events="none">${i+1}</text></g>`;}).join('');}
function money(cents:number){return new Intl.NumberFormat('en-AU',{style:'currency',currency:$<HTMLSelectElement>('currency').value}).format(cents/100);}
function updatePricing(){const estimate=priceQuantities(quantities(sheet()),rates);$('price-lines').innerHTML=estimate.lines.map(l=>`<div><span>${escape(l.code)} · ${l.quantity??'unassessed'}</span><span>${l.status==='out-of-scope'?'Out of scope':l.totalCents===null?'Not priced':money(l.totalCents)}</span></div>`).join('');$('price-total').textContent=`${estimate.complete?'Draft subtotal':'Partial priced subtotal'}: ${money(estimate.pricedSubtotalCents)}`;$('price-note').textContent=estimate.complete?'Current page supported quantities priced. Check evidence and scope before using this draft.':'Incomplete: some included types need rates or a fresh assessment, or have unresolved items. These gaps are excluded from the subtotal.';}
function update(syncInputs=true){refreshConflicts(sheet());const e=entry(),hits=includedHits(sheet());if(syncInputs){input('code').value=e.code;input('description').value=e.description;const r=rates[currentCode];input('material').value=r?.material??'';input('labour').value=r?.labour??'';input('rate-source').value=r?.source??'';}$<HTMLSelectElement>('type-select').innerHTML=sheet().entries.map(t=>`<option value="${escape(t.code)}" ${t.code===currentCode?'selected':''}>${escape(t.code)}${t.inScope===false?' (out of scope)':''}</option>`).join('');$('exemplar-note').textContent=e.exemplar?`Example: (${e.exemplar.x.toFixed(1)}, ${e.exemplar.y.toFixed(1)}) PDF points · page ${pageNum}`:'No example selected. Choose Pick example, then click a clear symbol instance.';$('quantities').innerHTML=quantities(sheet()).map(q=>`<tr><td><button data-code="${escape(q.code)}">${escape(q.code)}</button></td><td>${q.status==='out-of-scope'?'Out of scope':q.status==='stale'?'Rescan required':q.supported??'Not assessed'}</td><td>${q.unresolved??'Unknown'}</td></tr>`).join('');$('quantities').querySelectorAll<HTMLButtonElement>('[data-code]').forEach(b=>b.onclick=()=>{if(busy)return;currentCode=b.dataset.code!;selected=null;update();});button('scope-type').textContent=e.inScope===false?'Include this type in scope':'Exclude this type from scope';$('method-note').textContent=`${e.stale?'EXAMPLE CHANGED: rescan required. Previous evidence retained. ':''}${e.inScope===false?'OUT OF SCOPE: excluded from this page’s count and price draft. ':''}${e.provider?'Method: '+e.provider+' · ':''}${e.note}${e.truncated?' · INCOMPLETE: provider truncated results.':''} Current page only.`;
 const hit=hits.find(h=>h.id===selected);$('hit-detail').innerHTML=hit?`<strong>${escape(hit.code)} · hit ${hits.indexOf(hit)+1}</strong><br>Page ${hit.page} · (${hit.x.toFixed(1)}, ${hit.y.toFixed(1)}) PDF pt<br>${escape(hit.method)} · ${escape(effectiveDecision(hit))}${hit.conflict?' (conflicting type; review: '+escape(hit.decision)+')':''}<br><span class="fine">${escape(hit.id.slice(-70))}</span>`:'Select a numbered hit to inspect or correct it.';for(const id of ['confirm','flag','reject'])button(id).disabled=!hit||busy;$('hit-list').innerHTML=hits.map((h,i)=>`<button data-id="${escape(h.id)}">${i+1} · ${escape(h.code)} · ${escape(effectiveDecision(h))}</button>`).join('');$('hit-list').querySelectorAll<HTMLButtonElement>('[data-id]').forEach(b=>b.onclick=()=>selectHit(b.dataset.id!));drawOverlay();updatePricing();syncControls();}
function selectHit(id:string){if(busy)return;selected=id;const hit=includedHits(sheet()).find(h=>h.id===id);if(hit)currentCode=hit.code;update();}
// Prepare rendering before changing the active document. A bad replacement
// must not destroy the current PDF, quantities, exclusions or entered rates.
async function renderBitmap(pdfPage:PDFPageProxy,level:number){
 const base=pdfPage.getViewport({scale:1});
 const ratio=Math.min(window.devicePixelRatio||1,2);
 const scale=Math.min(level*ratio,Math.sqrt(25_000_000/(base.width*base.height)));
 const renderViewport=pdfPage.getViewport({scale});
 const bitmap=document.createElement('canvas');
 bitmap.width=Math.max(1,Math.floor(renderViewport.width));bitmap.height=Math.max(1,Math.floor(renderViewport.height));
 await pdfPage.render({canvas:bitmap,canvasContext:bitmap.getContext('2d')!,viewport:renderViewport}).promise;
 return{bitmap,base};
}
function installBitmap(bitmap:HTMLCanvasElement,base:PageViewport,level:number){
 canvas.width=bitmap.width;canvas.height=bitmap.height;
 canvas.getContext('2d')!.drawImage(bitmap,0,0);
 viewport=base;zoom=level;
 const wrap=$('page-wrap');wrap.hidden=false;wrap.style.width=base.width*level+'px';wrap.style.height=base.height*level+'px';
 overlay.setAttribute('viewBox',`0 0 ${base.width} ${base.height}`);
 $('empty').hidden=true;input('page-number').value=String(pageNum);input('page-number').max=String(doc!.numPages);
 $('page-total').textContent='/ '+doc!.numPages;input('zoom-percent').value=String(Math.round(zoom*100));
}
async function paint(fit=false,syncInputs=false){
 if(!doc)return;setBusy(true);const seq=++sequence;
 try{
  const nextPage=await doc.getPage(pageNum),base=nextPage.getViewport({scale:1});
  if(fit)fitMode=fitMode??'page';
  const level=fit?fitScale({x:base.width,y:base.height},{x:scrollArea.clientWidth,y:scrollArea.clientHeight||600},fitMode!):zoom;
  const rendered=await renderBitmap(nextPage,level);
  if(seq!==sequence)return;
  page=nextPage;sheet().bounds=pageBounds(nextPage);installBitmap(rendered.bitmap,rendered.base,level);entry();update(syncInputs);
 }finally{setBusy(false);}
}
async function openFile(data:Uint8Array,name:string,requestedTrade=activeTrade){
 if(busy)return false;setBusy(true);say('Opening PDF on this device…');
 let candidate:PDFDocumentProxy|null=null;
 let loadingTask:ReturnType<typeof pdfjs.getDocument>|null=null;
 try{
  loadingTask=pdfjs.getDocument({data:data.slice(),useSystemFonts:true,cMapUrl:'/pdf-resources/cmaps/',cMapPacked:true,standardFontDataUrl:'/pdf-resources/standard_fonts/',wasmUrl:'/pdf-resources/wasm/'});
  candidate=await loadingTask.promise;
  const first=await candidate.getPage(1),base=first.getViewport({scale:1});
  const level=fitScale({x:base.width,y:base.height},{x:scrollArea.clientWidth,y:scrollArea.clientHeight||600},'page');
  const prepared=await renderBitmap(first,level);
  const digest=await crypto.subtle.digest('SHA-256',data.slice().buffer);
  const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  if(!confirmReplacement()){await candidate.destroy();candidate=null;say('Replacement cancelled. Current work retained.');return false;}
  const previous=doc;
  doc=candidate;candidate=null;bytes=data;documentHash=hash;fileName=name;pageNum=1;page=first;
  activeTrade=requestedTrade;initialSetup='manual';sheets={};rates=Object.create(null);currentCode=activeTrade.items[0].code;selected=null;
  panStart=null;pinch=null;touches.clear();fitMode='page';
  applyTradeLabels();$('file-title').textContent=name;
  installBitmap(prepared.bitmap,prepared.base,level);sheet().bounds=pageBounds(first);entry();update();savedWork=workState();
  scrollArea.scrollTop=0;scrollArea.scrollLeft=0;setMode('exclude');
  say('Drawing open. Drag a rectangle around the legend to exclude its examples from installation counts.');
  if(previous)void previous.destroy().catch(error=>console.warn('Previous PDF cleanup:',error));
  return true;
 }catch(error){
  if(candidate)await candidate.destroy().catch(()=>{});else await loadingTask?.destroy?.().catch(()=>{});
  say('Could not open PDF: '+errorMessage(error)+'. The current drawing and work have been retained.',true);
  return false;
 }finally{setBusy(false);input('pdf-input').value='';input('empty-input').value='';}
}
function errorMessage(error:unknown){return error instanceof Error?error.message:String(error);}
function pageBounds(pdfPage:PDFPageProxy):Bounds{
 const [x0,y0,x1,y1]=pdfPage.view;return{x0,y0,x1,y1};
}
function draftInputs(){return{code:input('code').value,description:input('description').value};}
function workState(){
 const e=entry(),draft=draftInputs();
 return JSON.stringify({sheets,rates,trade:activeTrade.id,initialSetup,currency:$<HTMLSelectElement>('currency').value,
  draft:draft.code===e.code&&draft.description===e.description?null:draft});
}
function hasUnsavedWork(){return!!doc&&workState()!==savedWork;}
function confirmReplacement(){
 return !hasUnsavedWork()||window.confirm('Replace the current work and discard unsaved changes on all pages? Choose Cancel to save a project file first.');
}
function projectBundle():ProjectBundle{
 return{schemaVersion:1,kind:'legend-project',coordinateFrame:'pdf-points-bottom-left',
  source:{fileName,sha256:documentHash,pageCount:doc!.numPages},page:pageNum,currentCode,
  trade:activeTrade.id as ProjectBundle['trade'],currency:$<HTMLSelectElement>('currency').value as ProjectBundle['currency'],
  initialSetup,sheets,rates,draft:draftInputs(),createdAt:new Date().toISOString()};
}
async function restoreProject(text:string){
 if(!doc||busy)return false;setBusy(true);
 try{
  const project=parseProject(text);
  if(project.source.sha256!==documentHash||project.source.pageCount!==doc.numPages)
   throw Error('This project belongs to a different PDF. Open its original PDF, then load the project again');
  const restored=projectSheets(project);
  // Rebuild visible bounds from the verified document, never from imported data.
  for(const [number,s] of Object.entries(restored)){
   s.bounds=pageBounds(await doc.getPage(Number(number)));refreshConflicts(s);
  }
  const restoredPage=await doc.getPage(project.page),base=restoredPage.getViewport({scale:1});
  const level=fitScale({x:base.width,y:base.height},{x:scrollArea.clientWidth,y:scrollArea.clientHeight||600},'page');
  const prepared=await renderBitmap(restoredPage,level);
  if(!confirmReplacement()){say('Project loading cancelled. Current work retained.');return false;}
  sheets=restored;rates=Object.assign(Object.create(null),project.rates);pageNum=project.page;page=restoredPage;
  activeTrade=getTrade(project.trade);currentCode=project.currentCode;initialSetup=project.initialSetup;selected=null;
  panStart=null;pinch=null;touches.clear();drag=null;preview=null;fitMode='page';
  $<HTMLSelectElement>('currency').value=project.currency;applyTradeLabels();
  installBitmap(prepared.bitmap,prepared.base,level);update();
  if(project.draft){input('code').value=project.draft.code;input('description').value=project.draft.description;}
  scrollArea.scrollTop=0;scrollArea.scrollLeft=0;setMode('review');savedWork=workState();
  say('Project restored from the matching PDF. All saved pages, decisions, scope and rates are available.');
  return true;
 }catch(error){say('Could not load project: '+errorMessage(error)+'. Current work retained.',true);return false;}
 finally{setBusy(false);}
}
async function raster(scale:number):Promise<RasterPage>{const p=page!,vp=p.getViewport({scale});if(vp.width*vp.height>25_000_000)throw Error('Raster fallback exceeds the 25-megapixel limit on this sheet. Try a smaller digital PDF or count manually');const c=document.createElement('canvas');c.width=Math.max(1,Math.floor(vp.width));c.height=Math.max(1,Math.floor(vp.height));const ctx=c.getContext('2d',{willReadFrequently:true})!;await p.render({canvas:c,canvasContext:ctx,viewport:vp}).promise;return{width:c.width,height:c.height,data:ctx.getImageData(0,0,c.width,c.height).data,toPdf:(x,y)=>{const [px,py]=vp.convertToPdfPoint(x,y);return{x:px,y:py};},toRaster:(x,y)=>{const [px,py]=vp.convertToViewportPoint(x,y);return{x:px,y:py};}};}
async function scan(){
 if(!doc||!page||busy||!entry().exemplar||entry().inScope===false)return;
 const e=entry(),exemplar={...e.exemplar!};setBusy(true);say('Scanning this page with your selected example…');
 await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
 try{
  const result=await scanForSimilar(pageNum,exemplar,{detector:async()=>null,renderRaster:async(_n,scale)=>raster(scale),vector:async()=>{const layers=await doc!.getOptionalContentConfig();return vectorize(await page!.getOperatorList(),pdfjs.OPS,{isVisible:g=>layers.isVisible(g as never)});},warn:message=>console.warn('Legend:',message)});
  if('error'in result)throw Error(result.error);
  e.provider=result.provider;e.note=result.note??'Scan completed';e.truncated=!!result.truncated;
  e.lastScan={exemplar,provider:e.provider,note:e.note,truncated:e.truncated,hits:result.hits.map(h=>({...h}))};e.stale=false;
  sheet().bounds=pageBounds(page);replaceScan(e,result.hits,documentHash,pageNum);refreshConflicts(sheet());
  const conflicts=includedHits(sheet()).some(h=>h.conflict);setMode('review');update();
  const count=quantities(sheet()).find(q=>q.code===e.code)!.supported;
  say(`${e.code}: ${count} supported detections · ${result.provider}. Legend regions and content outside the visible page excluded.${conflicts?' Overlapping types need review; existing decisions are retained.':''}${e.truncated?' Results were truncated; this is an incomplete count.':''} ${count===0?'No installations currently contribute to the supported count. This does not establish that the drawing contains no equipment. Review any uncertain or rejected matches, check the example, and add missed items manually.':'Review matches and check for missed items.'}`,count===0);
 }catch(error){say('Scan failed: '+errorMessage(error)+'. Previous results, if any, are retained; no new quantity was added.',true);}
 finally{setBusy(false);update();}
}
function download(name:string,data:BlobPart,type:string){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function snapshot(){return{schemaVersion:1,kind:'real-pdf-takeoff',source:{fileName,sha256:documentHash},page:pageNum,coordinateFrame:'pdf-points-bottom-left',createdAt:new Date().toISOString(),cloudCalls:0,currency:$<HTMLSelectElement>('currency').value,scope:'current-page-supported-quantities',trade:activeTrade.id,initialSetup,exclusions:['unresolved hits','unassessed quantities','tax','markup','cabling','accessories','other job costs'],sheet:sheet(),displayHits:includedHits(sheet()).map((h,i)=>({...h,effectiveDecision:effectiveDecision(h),number:i+1})),quantities:quantities(sheet()),rates,pricing:priceQuantities(quantities(sheet()),rates)};}
for(const id of ['pdf-input','empty-input'])input(id).onchange=async()=>{
 const file=input(id).files?.[0];if(!file||busy)return;
 setBusy(true);say('Reading PDF on this device…');
 try{const data=new Uint8Array(await file.arrayBuffer());setBusy(false);await openFile(data,file.name);}
 catch(error){say('Could not read file: '+errorMessage(error)+'. Current work is retained.',true);}
 finally{setBusy(false);input(id).value='';}
};
button('sample').onclick=async()=>{
 if(busy)return;setBusy(true);say('Loading the guided electrical sample…');
 try{
  const response=await fetch('output/dev-clean/drawing.pdf');if(!response.ok)throw Error('Sample not available');
  const data=new Uint8Array(await response.arrayBuffer());
  let metadata:unknown=null;
  try{const setup=await fetch('output/dev-clean/evidence.json');if(setup.ok)metadata=await setup.json();}catch{/* The PDF still works with manual setup. */}
  setBusy(false);
  const opened=await openFile(data,'sample-electrical.pdf',getTrade('electrical'));
  if(opened){
   const setup=sampleSetup(metadata,documentHash);
   if(setup){
    sheet().exclusions=setup.exclusions;
    sheet().entries=setup.entries.map(item=>({...makeEntry(item.code,item.description),exemplar:item.exemplar}));
    currentCode=setup.entries[0].code;initialSetup='sample-fixture';setMode('review');update();
    say('Guided sample: legend exclusions and symbol examples are preselected from matching fixture metadata. No detections are loaded. Choose Find matching symbols to run the real scanner.');
   }else say('Sample opened. Guided setup could not be verified; mark its legend and pick an example manually.');
  }
 }catch(error){say('Could not load sample: '+errorMessage(error)+'. Current work is retained.',true);}
 finally{setBusy(false);}
};
for(const m of ['pan','review','exclude','example','manual'])button('mode-'+m).onclick=()=>{if(!busy)setMode(m);};
button('undo-exclusion').onclick=()=>{sheet().exclusions.pop();update();say('Last exclusion removed. Quantities recalculated; inspect any newly included legend hits.');};
overlay.addEventListener('pointerdown',(event:PointerEvent)=>{if((busy&&!zooming)||!viewport||!doc)return;
 if(event.pointerType==='touch'&&(mode==='pan'||mode==='review')){
  touches.set(event.pointerId,{x:event.clientX,y:event.clientY});overlay.setPointerCapture(event.pointerId);
  if(touches.size===2){const [a,b]=[...touches.values()];const centre={x:(a.x+b.x)/2,y:(a.y+b.y)/2};pinch={distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),zoom,anchor:pageAnchor(centre,overlay.getBoundingClientRect(),{x:viewport.width,y:viewport.height})};panStart=null;drag=null;preview=null;overlay.dataset.panning='true';return;}
 }
 if(mode==='pan'||spaceDown||event.button===1){event.preventDefault();panStart={screen:{x:event.clientX,y:event.clientY},scroll:{x:scrollArea.scrollLeft,y:scrollArea.scrollTop},pointerId:event.pointerId};overlay.setPointerCapture(event.pointerId);overlay.dataset.panning='true';return;}
 if(mode==='review'){const id=(event.target as SVGElement).getAttribute('data-hit');if(id)selectHit(id);return;}const point=eventPoint(event);if(sheet().bounds&&!contains(point,sheet().bounds!))return;if(mode==='exclude'){drag=point;overlay.setPointerCapture(event.pointerId);}else if(mode==='example'){if(entry().inScope===false)return;selectExemplar(entry(),point);setMode('review');update();say('Example selected for '+currentCode+'. Choose Find matching symbols.');}else if(mode==='manual'){if(entry().inScope===false)return;if(sheet().exclusions.some(b=>contains(point,b))){say('That point is in an exclusion region. Choose an installed item outside the legend.',true);return;}if(includedHits(sheet()).some(h=>Math.hypot(h.x-point.x,h.y-point.y)<=3&&h.decision!=='rejected')){say('A detection already exists at this location. Review that hit instead.',true);return;}const e=entry();const hit:EvidenceHit={...point,id:hitId(documentHash,pageNum,currentCode,point),code:currentCode,page:pageNum,method:'manual',decision:'confirmed',manual:true};e.hits=e.hits.filter(h=>h.id!==hit.id);e.hits.push(hit);e.assessed=true;if(!e.provider)e.note='Manual count: completeness has not been independently checked';selected=hit.id;update();say('Manually confirmed item added for '+currentCode+'.');}});
overlay.addEventListener('pointermove',(event:PointerEvent)=>{if(touches.has(event.pointerId))touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
 if(pinch&&touches.size===2){const [a,b]=[...touches.values()];void requestZoom(pinch.zoom*Math.hypot(a.x-b.x,a.y-b.y)/pinch.distance,{x:(a.x+b.x)/2,y:(a.y+b.y)/2},pinch.anchor);return;}
 if(panStart&&panStart.pointerId===event.pointerId){scrollArea.scrollLeft=panStart.scroll.x-(event.clientX-panStart.screen.x);scrollArea.scrollTop=panStart.scroll.y-(event.clientY-panStart.screen.y);return;}
 if(!drag||!viewport)return;const point=eventPoint(event);preview={x0:Math.min(drag.x,point.x),y0:Math.min(drag.y,point.y),x1:Math.max(drag.x,point.x),y1:Math.max(drag.y,point.y)};drawOverlay();});
overlay.addEventListener('pointerup',(event:PointerEvent)=>{touches.delete(event.pointerId);if(pinch){if(touches.size<2)pinch=null;panStart=null;overlay.dataset.panning='false';return;}
 if(panStart){panStart=null;overlay.dataset.panning='false';return;}
 if(!drag)return;const p=eventPoint(event);const b={x0:Math.min(drag.x,p.x),y0:Math.min(drag.y,p.y),x1:Math.max(drag.x,p.x),y1:Math.max(drag.y,p.y)};drag=null;preview=null;if(b.x1-b.x0<3||b.y1-b.y0<3){drawOverlay();say('Drag a larger rectangle around the legend.',true);return;}sheet().exclusions.push(b);setMode('review');update();say('Exclusion saved. Pick an example for '+currentCode+' inside the legend.');});
overlay.addEventListener('pointercancel',()=>{drag=null;preview=null;panStart=null;pinch=null;touches.clear();overlay.dataset.panning='false';drawOverlay();});
button('scope-type').onclick=()=>{if(busy)return;const e=entry();e.inScope=e.inScope===false;selected=null;update();say(e.inScope?'Type included. Its existing evidence and rates were retained.':'Type excluded from this page’s scope. Its evidence and rates are retained and can be included again.');};
button('select-type').onclick=()=>{if(busy)return;const code=input('code').value.trim();if(!code){say('Enter an equipment code.',true);return;}currentCode=code;entry().description=input('description').value.trim();selected=null;update();say('Selected '+code+'. Pick its example on this page.');};
$<HTMLSelectElement>('type-select').onchange=()=>{currentCode=$<HTMLSelectElement>('type-select').value;selected=null;update();};
input('description').onchange=()=>{if(input('code').value.trim()===currentCode)entry().description=input('description').value.trim();};
button('scan').onclick=scan;
for(const [id,decision] of [['confirm','confirmed'],['flag','unresolved'],['reject','rejected']] as const)button(id).onclick=()=>{if(busy)return;const h=sheet().entries.flatMap(e=>e.hits).find(h=>h.id===selected);if(!h)return;h.decision=decision;update();say('Review decision recorded. Current-page quantities and prices recalculated.');};
async function changePage(number:number){
 if(!doc||busy)return;
 if(!Number.isInteger(number)||number<1||number>doc.numPages){input('page-number').value=String(pageNum);return;}
 const previous=pageNum,previousSelection=selected;
 pageNum=number;selected=null;panStart=null;pinch=null;touches.clear();setMode('review');
 try{await paint(true,true);scrollArea.scrollTop=0;scrollArea.scrollLeft=0;}
 catch(error){pageNum=previous;selected=previousSelection;input('page-number').value=String(previous);update();say('Could not render page: '+errorMessage(error)+'. The previous page remains open.',true);return;}
 say('Page '+pageNum+'. Each page needs its own legend exclusions and example; results are not transferred across pages.');
}
button('prev').onclick=()=>void changePage(pageNum-1);button('next').onclick=()=>void changePage(pageNum+1);input('page-number').onchange=()=>void changePage(Number(input('page-number').value));
function screenCentre():XY {const box=scrollArea.getBoundingClientRect();return{x:box.left+scrollArea.clientWidth/2,y:box.top+(scrollArea.clientHeight||600)/2};}
async function requestZoom(target:number,screen=screenCentre(),anchor?:XY):Promise<void>{
 if(!doc||!viewport||(busy&&!zooming)||!Number.isFinite(target))return;
 const box=overlay.getBoundingClientRect();
 zoomRequest={target:clampZoom(target),screen,anchor:anchor??pageAnchor(screen,box,{x:viewport.width,y:viewport.height})};
 fitMode=null;
 if(zooming)return;
 zooming=true;
 try{while(zoomRequest){const request=zoomRequest;zoomRequest=null;zoom=request.target;await paint();
  const position=anchoredScroll({x:scrollArea.scrollLeft,y:scrollArea.scrollTop},overlay.getBoundingClientRect(),request.anchor,zoom,request.screen);
  scrollArea.scrollLeft=position.x;scrollArea.scrollTop=position.y;
 }}catch(error){zoomRequest=null;say('Could not change drawing zoom: '+errorMessage(error),true);}finally{zooming=false;syncControls();}
}
async function fitView(mode:'page'|'width'){
 if(!doc||!viewport||busy)return;fitMode=mode;
 try{await paint(true);scrollArea.scrollTop=0;scrollArea.scrollLeft=Math.max(0,(viewport.width*zoom-scrollArea.clientWidth+48)/2);say(mode==='page'?'Entire page fitted to the drawing area.':'Page width fitted. Scroll vertically to explore the drawing.');}catch(error){say('Could not fit drawing: '+errorMessage(error),true);}
}
async function zoomTo(bounds:Bounds){
 if(!viewport||busy)return;const a=view({x:bounds.x0,y:bounds.y0}),b=view({x:bounds.x1,y:bounds.y1});
 const centre={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
 const target=fitScale({x:Math.max(50,Math.abs(b.x-a.x)),y:Math.max(50,Math.abs(b.y-a.y))},{x:scrollArea.clientWidth,y:scrollArea.clientHeight||600},'page',100);
 await requestZoom(target,screenCentre(),centre);
}
for(const [id,factor] of [['zoom-in',1.3],['zoom-out',1/1.3]] as const)button(id).onclick=()=>void requestZoom((zoomRequest?.target??zoom)*factor);
button('fit').onclick=()=>void fitView('page');button('fit-width').onclick=()=>void fitView('width');
input('zoom-percent').onchange=()=>{const value=Number(input('zoom-percent').value);if(value>0)void requestZoom(value/100);else input('zoom-percent').value=String(Math.round(zoom*100));};
button('zoom-legend').onclick=()=>{const bounds=sheet().exclusions.at(-1);if(bounds)void zoomTo(bounds);};
button('zoom-selection').onclick=()=>{const point=includedHits(sheet()).find(h=>h.id===selected)??entry().exemplar;if(point)void zoomTo({x0:point.x-35,y0:point.y-35,x1:point.x+35,y1:point.y+35});};
scrollArea.addEventListener('wheel',(event:WheelEvent)=>{
 if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();if(!viewport||(!zooming&&busy))return;
 const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?(scrollArea.clientHeight||600):1);
 void requestZoom((zoomRequest?.target??zoom)*Math.exp(-Math.max(-350,Math.min(350,delta))*.002),{x:event.clientX,y:event.clientY});
},{passive:false});
function typing(event:KeyboardEvent){const target=event.target as HTMLElement|null;return!!target&&(target.isContentEditable||['INPUT','TEXTAREA','SELECT','BUTTON'].includes(target.tagName));}
window.addEventListener('keydown',event=>{
 if(typing(event)||event.ctrlKey||event.metaKey||event.altKey)return;
 if(event.code==='Space'){event.preventDefault();spaceDown=true;overlay.dataset.space='true';return;}
 if(!doc||busy)return;
 if(['+','=','-','0','f','F','h','H','Escape'].includes(event.key))event.preventDefault();
 if(event.key==='+'||event.key==='=')void requestZoom(zoom*1.3);
 if(event.key==='-')void requestZoom(zoom/1.3);
 if(event.key==='0')void fitView('page');
 if(event.key.toLowerCase()==='f')void fitView('width');
 if(event.key.toLowerCase()==='h')setMode('pan');
 if(event.key==='Escape'){setMode('review');drag=null;preview=null;panStart=null;pinch=null;touches.clear();overlay.dataset.panning='false';drawOverlay();}
});
window.addEventListener('keyup',event=>{if(event.code==='Space'){spaceDown=false;overlay.dataset.space='false';}});
window.addEventListener('blur',()=>{spaceDown=false;panStart=null;pinch=null;touches.clear();overlay.dataset.space='false';overlay.dataset.panning='false';});
for(const id of ['material','labour','rate-source'])input(id).oninput=()=>{rates[currentCode]={material:input('material').value,labour:input('labour').value,source:input('rate-source').value};updatePricing();renderFlow();};$<HTMLSelectElement>('currency').onchange=updatePricing;
button('save-project').onclick=()=>{
 if(!doc||busy)return;
 try{
  const data=JSON.stringify(projectBundle(),null,2);
  // A successful save must be accepted by the same schema and byte limit as load.
  parseProject(data);
  if(new Blob([data]).size>20_000_000)throw Error('Project file is too large (limit 20 MB)');
  download(fileName.replace(/\.pdf$/i,'')+'-legend-project.json',data,'application/json');savedWork=workState();
  say('Project file downloaded for all pages. Keep the original PDF; open it and choose Load project to restore this work.');
 }catch(error){
  say('Could not save project: '+errorMessage(error)+'. Current work has been retained; no project was saved.',true);
 }
};
input('project-input').onchange=async()=>{
 const file=input('project-input').files?.[0];if(!file||busy||!doc)return;
 setBusy(true);
 try{
  if(file.size>20_000_000)throw Error('Project file is too large (limit 20 MB)');
  const text=await file.text();setBusy(false);await restoreProject(text);
 }catch(error){say('Could not read project: '+errorMessage(error)+'. Current work retained.',true);}
 finally{setBusy(false);input('project-input').value='';}
};
button('save-json').onclick=()=>download(fileName.replace(/\.pdf$/i,'')+`-p${pageNum}-evidence.json`,JSON.stringify(snapshot(),null,2),'application/json');
button('save-csv').onclick=()=>{const draft=snapshot();const quote=(value:unknown)=>{let text=String(value??'');if(/^[=+\-@\t\r]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};const cols=['document','sha256','page','currency','code','quantity','unresolved','materialPerUnit','labourPerUnit','lineSubtotal','status','rateSource'];const csv=cols.join(',')+'\n'+draft.pricing.lines.map(l=>[fileName,documentHash,pageNum,draft.currency,l.code,l.quantity,l.unresolved,l.materialCents===null?'':(l.materialCents/100).toFixed(2),l.labourCents===null?'':(l.labourCents/100).toFixed(2),l.totalCents===null?'':(l.totalCents/100).toFixed(2),l.status,l.source].map(quote).join(',')).join('\n');download(`takeoff-p${pageNum}.csv`,csv,'text/csv');};
button('save-pdf').onclick=async()=>{if(!bytes||busy)return;if(sheet().entries.some(e=>e.inScope!==false&&e.stale)){say('Rescan changed examples before exporting an annotated PDF. Previous evidence is available in JSON and project files.',true);return;}setBusy(true);say('Preparing an annotated copy on this device…');try{const pdf=await PDFDocument.load(bytes.slice()),p=pdf.getPages()[pageNum-1],font=await pdf.embedFont(StandardFonts.Helvetica);includedHits(sheet()).forEach((h,i)=>{if(h.decision==='rejected')return;const colour=effectiveDecision(h)==='unresolved'?rgb(.8,.5,.1):rgb(.05,.45,.6);p.drawCircle({x:h.x,y:h.y,size:10,borderWidth:1,borderColor:colour});p.drawText(String(i+1),{x:h.x+11,y:h.y+10,size:9,font,color:colour});});download(fileName.replace(/\.pdf$/i,'')+`-p${pageNum}-reviewed.pdf`,new Uint8Array(await pdf.save()),'application/pdf');say('Annotated copy exported for this page. Numbers match displayHits in the JSON export; rejected hits are not marked.');}catch(error){say('PDF export failed: '+errorMessage(error),true);}finally{setBusy(false);}};
window.addEventListener('beforeunload',event=>{if(hasUnsavedWork()){event.preventDefault();event.returnValue='';}});

$<HTMLSelectElement>('trade-select').onchange=()=>{
 activeTrade=getTrade($<HTMLSelectElement>('trade-select').value);applyTradeLabels();
 if(!doc){input('code').value=activeTrade.items[0].code;input('description').value=activeTrade.items[0].description;return;}
 for(const item of activeTrade.items)if(!sheet().entries.some(e=>e.code===item.code))sheet().entries.push(makeEntry(item.code,item.description));
 currentCode=activeTrade.items[0].code;selected=null;update();say(activeTrade.name+' presets added. Existing types and results were retained. Select an example from your drawing.');
};

function flowInput(e:SymbolEntry|null){
 const r=e?rates[e.code]:null;
 return{open:!!doc,excluded:!!doc&&sheet().exclusions.length>0,example:!!e?.exemplar,assessed:!!e?.assessed&&!e?.stale,inScope:e?.inScope!==false,
  hits:e?includedHits(sheet()).filter(h=>h.code===e.code).map(h=>({...h,decision:effectiveDecision(h)})):[],ratesReady:moneyCents(r?.material)!==null&&moneyCents(r?.labour)!==null,
  otherPending:0,truncated:!!e?.truncated};
}
function pendingTypes(){
 return doc?sheet().entries.filter(e=>e.code!==currentCode&&e.inScope!==false&&nextFlowStep(flowInput(e)).action!=='export'):[];
}
function currentFlow(){
 return nextFlowStep({...flowInput(doc?entry():null),otherPending:pendingTypes().length});
}
function renderFlow(){
 const flow=currentFlow();$('flow-progress').textContent=`STEP ${flow.number} OF 6`;
 $('flow-title').textContent=flow.title;$('flow-detail').textContent=flow.detail;
 button('flow-next').textContent=flow.label;button('flow-next').disabled=busy;
}
button('flow-next').onclick=async()=>{
 if(busy)return;
 const action=currentFlow().action;
 if(action==='scope'){button('scope-type').click();return;}
 if(action==='sample'){button('sample').click();return;}
 if(action==='exclude'||action==='example'||action==='manual'){setMode(action);return;}
 if(action==='scan'){void scan();return;}
 if(action==='next-type'){
  const next=pendingTypes()[0];
  if(next){currentCode=next.code;selected=null;setMode('review');update();$<HTMLSelectElement>('type-select').focus();say(next.code+' selected. Follow the next step to finish this type, or exclude it from scope.');}
  return;
 }
 if(action==='review'){
  const hits=includedHits(sheet()).filter(h=>h.code===currentCode);
  const hit=hits.find(h=>effectiveDecision(h)==='unresolved')??hits.find(h=>h.decision==='supported')??hits[0];
  if(hit){setMode('review');selectHit(hit.id);await zoomTo({x0:hit.x-35,y0:hit.y-35,x1:hit.x+35,y1:hit.y+35});button('confirm').focus();}
  else setMode('manual');
  return;
 }
 if(action==='price'){input(moneyCents(rates[currentCode]?.material)===null?'material':'labour').focus();return;}
 button('save-csv').click();
};
renderFlow();
