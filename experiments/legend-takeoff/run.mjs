// Local, deterministic pilot. No cloud calls, no detector training, no shared API edits.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { openPdf } from '../../src/headless/pdfjs-node.ts';
import { scanDocAt, vectorDocPage, pageWordsWithOcr } from '../../src/headless/ops.ts';
import { renderRasterNode } from '../../src/headless/raster-node.ts';
import { createCanvas, ImageData } from '@napi-rs/canvas';

const root = dirname(fileURLToPath(import.meta.url));
const protocolBytes = readFileSync(join(root, 'fixtures.json'));
const protocol = JSON.parse(protocolBytes);
const out = join(root, 'output');
mkdirSync(out, { recursive: true });
const hash = data => createHash('sha256').update(data).digest('hex');
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const codes = ['DL1', 'SO1'];
const descriptions = {DL1: 'Recessed downlight', SO1: 'Socket outlet'};
const inside = (p, b) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
const dist = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
// Families differ in geometry, not just placement. All symbols use single vector paths.
const shapes = {
  a: {DL1:'M -8 -8 L 8 -8 L 8 8 L -8 8 Z M -8 -8 L 8 8 M -8 8 L 8 -8', SO1:'M -9 -6 L 9 -6 L 9 6 L -9 6 Z M -3 -6 L -3 6 M 3 -6 L 3 6'},
  b: {DL1:'M 0 -10 L 10 0 L 0 10 L -10 0 Z M 0 -10 L 0 10 M -10 0 L 10 0', SO1:'M -10 -7 L 10 -7 L 10 7 L -10 7 Z M -10 -7 L 10 7'},
  c: {DL1:'M -4 -9 L 4 -9 L 9 -4 L 9 4 L 4 9 L -4 9 L -9 4 L -9 -4 Z M -9 0 L 9 0', SO1:'M -8 -8 L 8 -8 L 8 8 L -8 8 Z M -8 0 L 8 0'}
};
function symbol(page, style, code, x, y, scale=1, rotation=0) {
  page.drawSvgPath(shapes[style][code], {x,y,scale,rotate:degrees(rotation),borderWidth:0.8,borderColor:rgb(0,0,0)});
}
async function fixture(sheet) {
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date('2026-10-20T00:00:00Z'));
  pdf.setModificationDate(new Date('2026-10-20T00:00:00Z'));
  const page = pdf.addPage([600,500]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const text = (s,x,y,size=10) => page.drawText(s,{x,y,size,font});
  text(`Electrical pilot / ${sheet.id}`,30,470,16);
  const regions = [];
  if (sheet.legend) {
    regions.push({x0:25,y0:360,x1:390,y1:450});
    text('LEGEND',30,435,11);
    for (let i=0;i<codes.length;i++) {
      const code=codes[i], y=415-i*30;
      symbol(page,sheet.style,code,55,y);
      text(`${code} - ${descriptions[code]}`,90,y-3);
      if (sheet.ambiguous && code==='DL1') symbol(page,sheet.style,'SO1',75,y);
    }
  }
  if(sheet.repeatLegend) {
    regions.push({x0:420,y0:350,x1:590,y1:450});
    text('REPEATED LEGEND',425,435,9);
    codes.forEach((code,i)=>{symbol(page,sheet.style,code,445,415-i*30);text(code,475,412-i*30);});
  }
  text('INSTALLATION AREA',30,320,11);
  sheet.instances.forEach(([code,x,y,scale,rot])=>symbol(page,sheet.style,code,x,y,scale,rot));
  if(sheet.lookalike) page.drawRectangle({x:330,y:262,width:16,height:16,borderWidth:0.8,borderColor:rgb(0,0,0)});
  text('Synthetic fixture - no customer drawings - Apache-2.0',30,25,9);
  return {bytes:await pdf.save(), regions};
}
// Narrow parser: declared code at start of text row, one small path to its left.
// Multiple paths/candidates or repeated code => unresolved; never guess nearest.
async function extract(doc, region, documentId) {
  if(!region) return [];
  const {words} = await pageWordsWithOcr(doc,1,undefined,{ocr:false});
  const vec = await vectorDocPage(doc,1);
  const rows = words.filter(w=>inside({x:w.xPt,y:w.yPt},region));
  return codes.map(code=>{
    const labels = rows.filter(w=>w.text===code);
    const base = {id:`${documentId}:p1:${code}`,code,page:1,coordinateFrame:protocol.coordinateFrame,association:'unresolved',sourceBounds:region};
    if(labels.length!==1) return {...base,reason:'missing or repeated code'};
    const label=labels[0];
    const sourceWords=rows.filter(w=>Math.abs(w.yPt-label.yPt)<5 && w.xPt>=label.xPt).sort((a,b)=>a.xPt-b.xPt);
    const candidates=vec.paths.filter(p=>{
      const w=p.x1-p.x0,h=p.y1-p.y0,c={x:(p.x0+p.x1)/2,y:(p.y0+p.y1)/2};
      return w>=6 && h>=6 && w<=28 && h<=28 && inside(c,region) && c.x<label.xPt-10 && label.xPt-c.x<100 && Math.abs(c.y-label.yPt)<10;
    });
    return {...base,sourceText:sourceWords.map(w=>w.text).join(' '),description:sourceWords.map(w=>w.text).join(' ').replace(new RegExp(`^${code}\\s*-?\\s*`),''),
      candidates:candidates.map(p=>({x0:p.x0,y0:p.y0,x1:p.x1,y1:p.y1})),
      ...(candidates.length===1 ? {association:'supported-by-layout',exemplar:{x:(candidates[0].x0+candidates[0].x1)/2,y:(candidates[0].y0+candidates[0].y1)/2}} : {reason:'expected exactly one candidate path'})};
  });
}
// Frozen one-to-one matching, maximum cardinality within 10pt. No totals-only scoring.
export function score(hits,truth,radius=10) {
  const owner=new Map();
  function augment(i,seen) {
    const options=truth.map((p,j)=>({j,d:dist(hits[i],p)})).filter(v=>v.d<=radius).sort((a,b)=>a.d-b.d || a.j-b.j);
    for(const {j} of options) {if(seen.has(j))continue;seen.add(j);if(!owner.has(j)||augment(owner.get(j),seen)){owner.set(j,i);return true;}}
    return false;
  }
  hits.forEach((_,i)=>augment(i,new Set()));
  const tp=owner.size,fp=hits.length-tp,fn=truth.length-tp;
  return {tp,fp,fn,precision:hits.length?tp/hits.length:null,recall:truth.length?tp/truth.length:null,exactCount:hits.length===truth.length,absoluteCountError:Math.abs(hits.length-truth.length)};
}
function dedup(hits) {
  const kept=[];
  for(const p of [...hits].sort((a,b)=>a.x-b.x || a.y-b.y)) if(!kept.some(q=>dist(p,q)<=protocol.rules.dedupRadiusPt))kept.push(p);
  return kept;
}
// Meaningful protocol checks: competing hits must not claim a truth twice;
// matching must recover a valid assignment that greedy nearest can miss.
assert.deepEqual(Object.values(score([{x:0,y:0},{x:1,y:0}],[{x:0,y:0}])).slice(0,3),[1,1,0]);
assert.equal(score([{x:4,y:0},{x:0,y:0}],[{x:0,y:0},{x:10,y:0}],6).tp,2);
assert.equal(dedup([{x:0,y:0},{x:2,y:0},{x:20,y:0}]).length,2);

const report={protocolSha256:hash(protocolBytes),gitCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),node:process.version,
  limitations:['Six synthetic sheets only; not real-world accuracy evidence.','Ground truth is authored placement data, not independent human verification.','Held-out families b/c are distinct from development a; authored and visible in this repository.','No AI review implemented or replayed. No live cloud calls.','Manual legend selection and baseline exemplars are disclosed inputs.','Parser supports one path per symbol and horizontal code-first rows only.'],
  cloud:{mode:'not-assessed',calls:0,costUsd:0},rules:protocol.rules,results:[]};
for(const sheet of protocol.sheets) {
  const dir=join(out,sheet.id);mkdirSync(dir,{recursive:true});
  const {bytes,regions}=await fixture(sheet);writeFileSync(join(dir,'drawing.pdf'),bytes);
  const documentId=hash(bytes).slice(0,12),doc=await openPdf(bytes);
  try {
    const page=await doc.getPage(1),vp=page.getViewport({scale:1.5});
    for(const p of [{x:0,y:0},{x:600,y:500},{x:150,y:240}]){
      const r=vp.convertToViewportPoint(p.x,p.y),back=vp.convertToPdfPoint(...r);
      assert.ok(Math.hypot(back[0]-p.x,back[1]-p.y)<1e-8);
    }
    const raster=await renderRasterNode(doc,1,1.5),canvas=createCanvas(raster.width,raster.height);
    canvas.getContext('2d').putImageData(new ImageData(raster.data,raster.width,raster.height),0,0);
    writeFileSync(join(dir,'drawing.png'),canvas.toBuffer('image/png'));
    const entries=await extract(doc,regions[0],documentId);
    writeJson(join(dir,'legend.json'),entries);
    const evidence={documentId,sourceSha256:hash(bytes),page:1,coordinateFrame:protocol.coordinateFrame,excludedRegions:regions,legend:entries,configurations:[]};
    for(const config of ['manual-exemplar','extracted-legend']) {
      const hits=[],quantities=[];
      for(const code of codes) {
        const start=performance.now();
        const entry=entries.find(e=>e.code===code);
        const exemplar=config==='manual-exemplar' && sheet.legend ? {x:55,y:code==='DL1'?415:385} : entry?.exemplar;
        const result=exemplar?await scanDocAt(doc,1,exemplar):{error:'No resolved legend exemplar'};
        const assessed=!('error' in result);
        const candidates=assessed?dedup(result.hits.filter(p=>!regions.some(b=>inside(p,b)))):[];
        for(const p of candidates)hits.push({id:`${documentId}:p1:${code}:${hash(`${p.x.toFixed(3)},${p.y.toFixed(3)}`).slice(0,10)}`,page:1,code,x:p.x,y:p.y,coordinateFrame:protocol.coordinateFrame,legendEntryId:`${documentId}:p1:${code}`,method:result.provider,score:p.score,reviewState:'detector-supported',humanConfirmed:false});
        const truth=sheet.instances.filter(p=>p[0]===code).map(p=>({x:p[1],y:p[2]}));
        const row={sheet:sheet.id,split:sheet.split,config,code,status:assessed?'assessed':'not-assessed',supported:assessed?candidates.length:null,unresolved:assessed?0:null,
          reason:assessed?null:result.error,provider:assessed?result.provider:null,truncated:assessed?Boolean(result.truncated):false,
          // Unassessed has no reported quantity, but all truth remains missed for end-to-end recall.
          ...score(candidates,truth,protocol.rules.matchRadiusPt),runtimeMs:Math.round(performance.now()-start),manualSelections:config==='manual-exemplar'&&sheet.legend?1:0,manualCorrections:0};
        if(!assessed){row.exactCount=null;row.absoluteCountError=null;}
        quantities.push(row);report.results.push(row);
      }
      evidence.configurations.push({config,hits,quantities});
    }
    report.results.push(...codes.map(code=>({sheet:sheet.id,split:sheet.split,config:'extracted-legend+ai',code,status:'not-assessed',reason:'AI review not implemented',supported:null})));
    writeJson(join(dir,'evidence.json'),evidence);
    // Visible evidence numbers are burned into a copy; output is always regenerated from original bytes.
    const annotated=await PDFDocument.load(bytes),ap=annotated.getPages()[0],font=await annotated.embedFont(StandardFonts.Helvetica);
    const main=evidence.configurations.find(c=>c.config==='extracted-legend');
    main.hits.forEach((h,i)=>{h.number=i+1;ap.drawCircle({x:h.x,y:h.y,size:14,borderWidth:1,borderColor:rgb(0,0.45,0.8)});ap.drawText(`${i+1}`,{x:h.x+15,y:h.y+10,size:9,font,color:rgb(0,0.35,0.7)});});
    entries.forEach(e=>{if(e.exemplar)ap.drawRectangle({x:e.exemplar.x-13,y:e.exemplar.y-13,width:26,height:26,borderWidth:1,borderColor:rgb(0.1,0.6,0.2)});});
    writeFileSync(join(dir,'annotated.pdf'),await annotated.save());
    writeJson(join(dir,'evidence.json'),evidence);
  } finally {await doc.destroy();}
}
const cols=['sheet','split','config','code','status','supported','unresolved','provider','tp','fp','fn','precision','recall','exactCount','absoluteCountError','runtimeMs'];
writeFileSync(join(out,'quantities.csv'),cols.join(',')+'\n'+report.results.map(r=>cols.map(c=>r[c]??'').join(',')).join('\n')+'\n');
report.associations={supported:0,unresolved:0,correct:0};
for(const s of protocol.sheets){const es=JSON.parse(readFileSync(join(out,s.id,'legend.json')));for(const e of es){if(e.exemplar){report.associations.supported++;const expected={x:55,y:e.code==='DL1'?415:385};if(dist(e.exemplar,expected)<1)report.associations.correct++;}else report.associations.unresolved++;}}
writeJson(join(out,'report.json'),report);
console.log(JSON.stringify({gitCommit:report.gitCommit,associations:report.associations,results:report.results.filter(r=>r.config==='extracted-legend')},null,2));
