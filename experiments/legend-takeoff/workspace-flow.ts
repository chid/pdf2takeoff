import type { EvidenceHit } from './workspace-model.ts';
export interface FlowInput {
  open:boolean;
  excluded:boolean;
  example:boolean;
  assessed:boolean;
  hits:EvidenceHit[];
  ratesReady:boolean;
  otherPending:number;
  truncated:boolean;
  inScope?:boolean;
}
export interface FlowStep {
  number:number;
  title:string;
  detail:string;
  label:string;
  action:'sample'|'scope'|'exclude'|'example'|'scan'|'review'|'manual'|'price'|'next-type'|'export';
}
export function nextFlowStep(s:FlowInput):FlowStep {
  if(!s.open)return{number:1,title:'Start with a drawing',detail:'Choose your PDF, or use the guided electrical sample to try a real scan.',label:'Try guided sample',action:'sample'};
  if(s.inScope===false)return{number:2,title:'This type is outside your scope',detail:'Its evidence and rates are retained. Include it again to count and price it, or select another type.',label:'Include this type',action:'scope'};
  if(!s.excluded)return{number:2,title:'Exclude the legend',detail:'Drag around legend and schedule examples so they are not counted as installed equipment.',label:'Mark legend',action:'exclude'};
  if(!s.example)return{number:3,title:'Choose this type’s example',detail:'Pick one clear instance of the selected equipment symbol.',label:'Pick example',action:'example'};
  if(!s.assessed)return{number:4,title:'Run the scan',detail:'The example is ready. Scan this page to create fresh, numbered evidence.',label:'Find matching symbols',action:'scan'};
  if(s.truncated)return{number:5,title:'This scan is incomplete',detail:'The provider truncated its results. Inspect the evidence and add missed items; a complete count has not been established.',label:'Inspect results',action:'review'};
  if(s.hits.some(h=>h.decision==='unresolved'))return{number:5,title:'Resolve an uncertain hit',detail:'Inspect the flagged item, then confirm or reject it. Price totals follow the review decision.',label:'Inspect uncertain hit',action:'review'};
  if(s.hits.some(h=>h.decision==='supported'))return{number:5,title:'Check what was counted',detail:'Confirm correct matches, reject false positives, and look for missed equipment. Detection alone is not human verification.',label:'Inspect next match',action:'review'};
  if(!s.hits.some(h=>h.decision==='confirmed'))return{number:5,title:'No accepted installations yet',detail:'No accepted hit does not establish zero equipment. Check the drawing or add a missed item manually.',label:'Add missed item',action:'manual'};
  if(!s.ratesReady)return{number:6,title:'Apply your material and labour rates',detail:'Enter both per-unit rates for this type. Explicit zero is allowed; blank rates remain unpriced.',label:'Enter rates',action:'price'};
  if(s.otherPending)return{number:6,title:'Continue with the next type',detail:'This type is reviewed and priced. Other included types still need setup, review or rates. Exclude unused types from scope.',label:'Continue to next type',action:'next-type'};
  return{number:6,title:'Export a price draft',detail:'Export the current-page quantities and rates. Use Save project to keep work on every page for reopening.',label:'Export quantity + price CSV',action:'export'};
}

interface SampleSetup {
  exclusions:{x0:number;y0:number;x1:number;y1:number}[];
  entries:{code:string;description:string;exemplar:{x:number;y:number}}[];
}
// Read only setup selections, never the fixture's saved detections or totals.
export function sampleSetup(value:unknown,sha256:string):SampleSetup|null {
  if(!value||typeof value!=='object')return null;
  const data=value as Record<string,unknown>;
  if(data.sourceSha256!==sha256||data.page!==1||data.coordinateFrame!=='pdf-points-bottom-left')return null;
  if(!Array.isArray(data.excludedRegions)||!data.excludedRegions.length||!Array.isArray(data.legend))return null;
  const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<1e7;
  const exclusions:SampleSetup['exclusions']=[];
  for(const item of data.excludedRegions){
    if(!item||typeof item!=='object')return null;
    const b=item as Record<string,unknown>;
    if(!finite(b.x0)||!finite(b.y0)||!finite(b.x1)||!finite(b.y1)||b.x1<=b.x0||b.y1<=b.y0)return null;
    exclusions.push({x0:b.x0,y0:b.y0,x1:b.x1,y1:b.y1});
  }
  const entries:SampleSetup['entries']=[];
  for(const item of data.legend){
    if(!item||typeof item!=='object')return null;
    const entry=item as Record<string,unknown>,point=entry.exemplar as Record<string,unknown>|undefined;
    if(entry.association!=='supported-by-layout'||typeof entry.code!=='string'||!entry.code.trim()||entry.code.length>40||!point||!finite(point.x)||!finite(point.y))return null;
    const {x,y}=point;
    if(!exclusions.some(b=>x>=b.x0&&x<=b.x1&&y>=b.y0&&y<=b.y1))return null;
    entries.push({code:entry.code,description:typeof entry.description==='string'?entry.description.slice(0,160):'',exemplar:{x,y}});
  }
  if(!entries.length||new Set(entries.map(e=>e.code)).size!==entries.length)return null;
  return{exclusions,entries};
}
