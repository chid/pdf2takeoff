import { z } from 'zod';
import { hitId, type SheetState } from './workspace-model.ts';

const coordinate=z.number().finite().min(-10_000_000).max(10_000_000);
const point=z.object({x:coordinate,y:coordinate});
const bounds=z.object({x0:coordinate,y0:coordinate,x1:coordinate,y1:coordinate})
 .refine(b=>b.x1>b.x0&&b.y1>b.y0,'Invalid rectangle');
const code=z.string().trim().min(1).max(40);
const scanHit=point.extend({score:z.number().finite().optional(),label:z.string().max(160).optional()});
const hit=scanHit.extend({
 id:z.string().max(400),code,page:z.number().int().positive(),method:z.string().max(80),
 decision:z.enum(['supported','confirmed','unresolved','rejected']),manual:z.boolean(),conflict:z.boolean().optional(),
});
const entry=z.object({
 code,description:z.string().max(160),exemplar:point.nullable(),assessed:z.boolean(),
 provider:z.string().max(80).nullable(),note:z.string().max(4000),hits:z.array(hit).max(100_000),truncated:z.boolean(),
 inScope:z.boolean().optional(),stale:z.boolean().optional(),
 lastScan:z.object({exemplar:point,provider:z.string().max(80),note:z.string().max(4000),truncated:z.boolean(),hits:z.array(scanHit).max(100_000)}).optional(),
});
const schema=z.object({
 schemaVersion:z.literal(1),kind:z.literal('legend-project'),coordinateFrame:z.literal('pdf-points-bottom-left'),
 source:z.object({fileName:z.string().max(1000),sha256:z.string().regex(/^[a-f0-9]{64}$/),pageCount:z.number().int().positive()}),
 page:z.number().int().positive(),currentCode:code,trade:z.enum(['electrical','general-builders','plumbing','hvac','fire','data']),
 currency:z.enum(['AUD','USD','GBP','EUR']),initialSetup:z.enum(['manual','sample-fixture']),
 draft:z.object({code:z.string().max(40),description:z.string().max(160)}).optional(),
 sheets:z.record(z.string().regex(/^[1-9]\d*$/),z.object({exclusions:z.array(bounds).max(10_000),entries:z.array(entry).min(1).max(1000),bounds:bounds.optional()})),
 rates:z.record(code,z.object({material:z.string().max(100),labour:z.string().max(100),source:z.string().max(240)})),
 createdAt:z.string().datetime(),
});
export type ProjectBundle=z.infer<typeof schema>;

// Quantities and prices are recomputed after loading; PDFs are never embedded.
export function parseProject(text:string):ProjectBundle {
 if(text.length>20_000_000)throw Error('Project file is too large (limit 20 MB)');
 let value:unknown;
 try{value=JSON.parse(text);}catch{throw Error('Project file is not valid JSON');}
 if(!value||typeof value!=='object'||!('kind'in value)||value.kind!=='legend-project')
  throw Error('Choose a Legend project file created with Save project, not an evidence export');
 if(!('schemaVersion'in value)||value.schemaVersion!==1)
  throw Error('Unsupported project version. Open it with a compatible version of Legend; the file has not been changed');
 const result=schema.safeParse(value);
 if(!result.success)throw Error('Invalid project data at '+result.error.issues[0].path.join('.'));
 const project=result.data;
 if(project.page>project.source.pageCount||!project.sheets[project.page]||
    !project.sheets[project.page].entries.some(e=>e.code===project.currentCode))
  throw Error('Project selection does not match its pages and equipment types');
 const ids=new Set<string>();
 for(const [number,sheet] of Object.entries(project.sheets)){
  if(Number(number)>project.source.pageCount)throw Error('Project refers to a page outside the source PDF');
  if(new Set(sheet.entries.map(e=>e.code)).size!==sheet.entries.length)throw Error('Project contains duplicate equipment codes');
  for(const e of sheet.entries){
   if(e.provider&&e.assessed&&!e.lastScan)throw Error('Scanned evidence is missing its original exemplar');
   if(e.lastScan){
    // Derive staleness rather than trusting an imported flag.
    e.stale=!e.exemplar||Math.hypot(e.exemplar.x-e.lastScan.exemplar.x,e.exemplar.y-e.lastScan.exemplar.y)>1e-6;
   }
   for(const h of e.hits){
    if(h.page!==Number(number)||h.code!==e.code||h.id!==hitId(project.source.sha256,h.page,h.code,h))
     throw Error('A hit does not match its source, page, equipment code or coordinates');
    if(ids.has(h.id))throw Error('Project contains duplicate evidence IDs');
    ids.add(h.id);
   }
  }
 }
 return project;
}

export function projectSheets(project:ProjectBundle):Record<number,SheetState>{
 return project.sheets;
}
