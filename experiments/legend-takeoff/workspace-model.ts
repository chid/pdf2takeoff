import type { Pt, ScanHit } from '../../src/engine/types.ts';
export type Decision = 'supported' | 'confirmed' | 'unresolved' | 'rejected';
export interface Bounds {x0:number;y0:number;x1:number;y1:number}
export interface EvidenceHit extends Pt {id:string;code:string;page:number;method:string;score?:number;decision:Decision;manual:boolean;conflict?:boolean}
export interface ScanEvidence {exemplar:Pt;provider:string;note:string;truncated:boolean;hits:ScanHit[]}
export interface SymbolEntry {code:string;description:string;exemplar:Pt|null;assessed:boolean;provider:string|null;note:string;hits:EvidenceHit[];truncated:boolean;inScope?:boolean;stale?:boolean;lastScan?:ScanEvidence}
export interface SheetState {exclusions:Bounds[];entries:SymbolEntry[];bounds?:Bounds}
export const contains=(p:Pt,b:Bounds)=>p.x>=b.x0&&p.x<=b.x1&&p.y>=b.y0&&p.y<=b.y1;
export const hitId=(hash:string,page:number,code:string,p:Pt)=>`${hash}:p${page}:${encodeURIComponent(code)}:${p.x.toFixed(3)},${p.y.toFixed(3)}`;
export function includedHits(sheet:SheetState){return sheet.entries.filter(e=>e.inScope!==false).flatMap(e=>e.hits).filter(h=>(!sheet.bounds||contains(h,sheet.bounds))&&!sheet.exclusions.some(b=>contains(h,b)));}
export const effectiveDecision=(h:EvidenceHit):Decision=>h.conflict&&h.decision!=='rejected'?'unresolved':h.decision;
// Conflicts are derived from current evidence. Never overwrite a human decision.
export function refreshConflicts(sheet:SheetState){
 for(const e of sheet.entries)for(const h of e.hits)h.conflict=false;
 const staleCodes=new Set(sheet.entries.filter(e=>e.stale).map(e=>e.code));
 const hits=includedHits(sheet).filter(h=>h.decision!=='rejected'&&!staleCodes.has(h.code));
 for(let i=0;i<hits.length;i++)for(let j=i+1;j<hits.length;j++){
  const a=hits[i],b=hits[j];
  if(a.code!==b.code&&Math.hypot(a.x-b.x,a.y-b.y)<=3)a.conflict=b.conflict=true;
 }
}
export function quantities(sheet:SheetState){
 refreshConflicts(sheet);
 const hits=includedHits(sheet);
 return sheet.entries.map(e=>{
  const status=e.inScope===false?'out-of-scope':e.stale?'stale':e.assessed?'assessed':'not-assessed';
  return{code:e.code,status,supported:status==='assessed'?hits.filter(h=>h.code===e.code&&['supported','confirmed'].includes(effectiveDecision(h))).length:null,
   unresolved:status==='assessed'&&!e.truncated?hits.filter(h=>h.code===e.code&&effectiveDecision(h)==='unresolved').length:null};
 });
}
export function selectExemplar(entry:SymbolEntry,point:Pt){
 entry.exemplar={...point};
 entry.stale=entry.lastScan?Math.hypot(point.x-entry.lastScan.exemplar.x,point.y-entry.lastScan.exemplar.y)>1e-6:entry.assessed&&!!entry.provider;
}
export function replaceScan(entry:SymbolEntry,hits:ScanHit[],hash:string,page:number){
 const old=new Map(entry.hits.filter(h=>!h.manual).map(h=>[h.id,h]));
 const kept:ScanHit[]=[];
 for(const p of [...hits].filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)).sort((a,b)=>a.x-b.x||a.y-b.y))if(!kept.some(q=>Math.hypot(p.x-q.x,p.y-q.y)<=3))kept.push(p);
 const manual=entry.hits.filter(h=>h.manual);
 const scanned:EvidenceHit[]=kept.filter(p=>!manual.some(h=>Math.hypot(p.x-h.x,p.y-h.y)<=3)).map(p=>{const id=hitId(hash,page,entry.code,p);return {...p,id,code:entry.code,page,method:entry.provider??'unknown',decision:old.get(id)?.decision??'supported',manual:false};});
 entry.hits=[...scanned,...manual];entry.assessed=true;
}
