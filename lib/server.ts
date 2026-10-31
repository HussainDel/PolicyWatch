import { MongoClient } from 'mongodb';
import { GoogleGenAI } from '@google/genai';
import { createHash } from 'crypto';

export const INSUFFICIENT = "I couldn't find sufficient supporting information in the indexed documents to answer this question reliably.";
const globalMongo = globalThis as typeof globalThis & { mongoPromise?: Promise<MongoClient> };
export async function db() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured. Add it to your environment.');
  if (!globalMongo.mongoPromise) globalMongo.mongoPromise = new MongoClient(process.env.MONGODB_URI).connect().catch(e => { globalMongo.mongoPromise = undefined; throw e; });
  return (await globalMongo.mongoPromise).db(process.env.MONGODB_DB_NAME || 'policywatch');
}
function ai() { if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured. Add it to your environment.'); return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }); }
const embedModel = () => process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
async function embed(text: string, taskType: 'RETRIEVAL_DOCUMENT'|'RETRIEVAL_QUERY') {
  const result = await ai().models.embedContent({model: embedModel(), contents: text, config: {taskType, outputDimensionality: 768}});
  const values = result.embeddings?.[0]?.values;
  if (!values || values.length !== 768) throw new Error('Embedding failed or returned an unexpected dimension.');
  return values;
}
type Page = {pageNumber:number;text:string};
export async function ingest(input: {title:string;version:string;category:string;filename:string;pages:Page[]; demo?:boolean}) {
  const {title,version,category,filename,pages} = input;
  if (![title,version,category,filename].every(x=>typeof x==='string' && x.trim().length>0 && x.length<=200) || !Array.isArray(pages) || !pages.length || pages.length>500 || pages.some(p=>!Number.isInteger(p.pageNumber)||p.pageNumber<1||typeof p.text!=='string'||p.text.length>100000)) throw new Error('Invalid document metadata or pages.');
  const cleaned = pages.map(p=>({pageNumber:p.pageNumber,text:p.text.replace(/\s+/g,' ').trim()})).filter(p=>p.text);
  if (!cleaned.length) throw new Error('No extractable text found. Scanned PDFs require OCR, which is not supported.');
  if (cleaned.reduce((n,p)=>n+p.text.length,0)>1500000) throw new Error('Extracted text is too large (maximum 1.5 MB).');
  const id = createHash('sha256').update(JSON.stringify([title.trim().toLowerCase(), version.trim().toLowerCase(), cleaned])).digest('hex');
  const database=await db(); const docs=database.collection('documents'), chunks=database.collection('chunks');
  // Failed attempts can be retried; indexed and in-flight documents remain protected.
  const failed = await docs.deleteOne({_id:id as never,status:'failed'});
  if (failed.deletedCount) await chunks.deleteMany({documentId:id});
  // The deterministic _id makes concurrent duplicate uploads safe.
  try { await docs.insertOne({_id:id as never,title:title.trim(),version:version.trim(),category:category.trim(),filename:filename.trim(),pages:cleaned,status:'processing',createdAt:new Date(),demo:!!input.demo}); }
  catch(e: unknown) { if ((e as {code?:number}).code===11000) throw new Error('This document and version has already been uploaded.'); throw e; }
  try {
    const pieces: {pageNumber:number;text:string}[]=[];
    for (const page of cleaned) { const words=page.text.split(/\s+/); for(let i=0;i<words.length;i+=400) { pieces.push({pageNumber:page.pageNumber,text:words.slice(i,i+500).join(' ')}); if(i+500>=words.length) break; } }
    if (pieces.length>300) throw new Error('Document has too many chunks (maximum 300).');
    const records=[];
    for(let i=0;i<pieces.length;i++) { const p=pieces[i]; records.push({documentId:id,documentTitle:title.trim(),version:version.trim(),category:category.trim(),pageNumber:p.pageNumber,chunkIndex:i,text:p.text,embedding:await embed(p.text,'RETRIEVAL_DOCUMENT'),createdAt:new Date()}); }
    if(records.length) await chunks.insertMany(records);
    await docs.updateOne({_id:id as never},{$set:{status:'indexed',chunkCount:records.length}});
    return {id,chunkCount:records.length};
  } catch(e) { await chunks.deleteMany({documentId:id}); await docs.updateOne({_id:id as never},{$set:{status:'failed',error:e instanceof Error?e.message:'Processing failed'}}); throw e; }
}
type Evidence = {id:string;documentId:string;documentTitle:string;version:string;pageNumber:number;text:string;category:string};
export async function retrieve(query:string, filter:Record<string,string>={}, limit=8):Promise<Evidence[]> {
  const database=await db(); const vector=await embed(query,'RETRIEVAL_QUERY');
  const match:Record<string,string>={}; for(const k of ['documentId','documentTitle','version','category']) if(filter[k]) match[k]=filter[k];
  const index=process.env.MONGODB_VECTOR_INDEX_NAME || 'vector_index';
  let semantic: Record<string,any>[];
  try { semantic=await database.collection('chunks').aggregate([{$vectorSearch:{index,path:'embedding',queryVector:vector,numCandidates:Math.max(100,limit*20),limit:Math.min(limit*3,60),...(Object.keys(match).length?{filter:match}:{})}},{$project:{embedding:0}}]).toArray(); }
  catch(e) { throw new Error(`MongoDB Vector Search failed. Create and wait for the ${index} index on chunks.embedding (768 dimensions), with metadata filter fields. See README. ${e instanceof Error?e.message:''}`); }
  // Atlas can return zero results for a missing/not-ready index. Check its status explicitly.
  try { const indexes=await database.collection('chunks').listSearchIndexes(index).toArray(); if(!indexes.length || (indexes[0] as {queryable?:boolean}).queryable !== true) throw new Error('not ready'); }
  catch { throw new Error(`Vector Search index "${index}" is missing or not queryable. Create it on chunks and wait until ready; see README.`); }
  let keyword:Record<string,any>[]=[];
  try { keyword=await database.collection('chunks').find({...match,$text:{$search:query}}, {projection:{embedding:0,score:{$meta:'textScore'}}}).sort({score:{$meta:'textScore'}}).limit(limit*3).toArray(); } catch { /* semantic retrieval remains available without a text index */ }
  const ranked=new Map<string,{doc:Record<string,any>;score:number}>();
  for(const list of [semantic,keyword]) list.forEach((doc,i)=>{const id=String(doc._id); const existing=ranked.get(id); ranked.set(id,{doc,score:(existing?.score||0)+1/(60+i+1)});});
  return [...ranked.values()].sort((a,b)=>b.score-a.score).slice(0,limit).map(({doc:d})=>({id:String(d._id),documentId:d.documentId,documentTitle:d.documentTitle,version:d.version,pageNumber:d.pageNumber,text:d.text,category:d.category}));
}
export async function generate(question:string,evidence:Evidence[],mode:'chat'|'compare'|'conflicts') {
  if (!evidence.length) return {answer:INSUFFICIENT,claims:[],sources:[]};
  const prompt = `You are an evidence-only policy analyst. Use ONLY the passages below. Never invent facts, quotations, source IDs, dates, or page numbers. Preserve numbers exactly. Distinguish interpretation from facts. If evidence is insufficient, say exactly: ${INSUFFICIENT}\nReturn JSON only: {"claims":[{"text":"one concise factual claim or analysis","sourceIds":["source id"]}]}. Every claim must cite supporting source IDs. No unsupported claims. ${mode==='compare'?'Compare only supported passages from BOTH document versions for every claim. Categorize each claim as Added, Removed, Modified, Eligibility, Deadlines, Penalties/obligations, Unchanged, or Inconclusive. Absence of a statement in retrieved excerpts is not proof of addition or removal. If either side is missing, mark inconclusive.':''} ${mode==='conflicts'?'Explain whether the statements genuinely conflict, dates if present, and precedence only if explicitly established. Never assume newest overrides older. Require evidence from both sides for a conflict conclusion.':''}\nQuestion: ${question}\nEvidence: ${JSON.stringify(evidence.map(({id,documentTitle,version,pageNumber,text})=>({id,documentTitle,version,pageNumber,text})))} `;
  const response=await ai().models.generateContent({model:process.env.GEMINI_MODEL||'gemini-2.5-flash',contents:prompt,config:{responseMimeType:'application/json',temperature:0.1}});
  let data: {claims?:{text?:unknown;sourceIds?:unknown}[]}; try {data=JSON.parse(response.text||'{}');} catch {throw new Error('The AI returned an invalid response. Please retry.');}
  const allowed=new Map(evidence.map(e=>[e.id,e]));
  const claims=(Array.isArray(data.claims)?data.claims:[]).filter(c=>typeof c.text==='string' && Array.isArray(c.sourceIds) && c.sourceIds.length>0 && c.sourceIds.every((id:unknown)=>typeof id==='string' && allowed.has(id))).filter(c=>mode==='chat'||new Set((c.sourceIds as string[]).map(id=>allowed.get(id)?.documentId)).size>=2).map(c=>({text:c.text,sourceIds:c.sourceIds}));
  return {answer:claims.length?'':INSUFFICIENT,claims,sources:evidence};
}
export const demos=[
 {title:'Internship Policy',version:'2025',category:'Internship',filename:'Synthetic Internship Policy 2025',pages:[{pageNumber:1,text:'SYNTHETIC DEMONSTRATION DOCUMENT — Internship Policy 2025. Eligibility: Students may apply after completing semester 4. A minimum cumulative CGPA of 7.0 is required. Students must have no active backlogs at the time of application.'},{pageNumber:2,text:'Internship duration and documentation: The internship must last at least 6 weeks. Students must submit an offer letter before the internship and a completion report within 30 days after it ends. Attendance during the internship must be at least 75%.'}]},
 {title:'Internship Policy',version:'2026',category:'Internship',filename:'Synthetic Internship Policy 2026',pages:[{pageNumber:1,text:'SYNTHETIC DEMONSTRATION DOCUMENT — Internship Policy 2026. Eligibility: Students may apply after completing semester 5. A minimum cumulative CGPA of 7.5 is required. Students must have no active backlogs at the time of application.'},{pageNumber:2,text:'Internship duration and documentation: The internship must last at least 8 weeks. Students must submit an offer letter and a faculty approval form before the internship and a completion report within 30 days after it ends. Attendance during the internship must be at least 75%.'}]},
 {title:'Examination and Attendance Regulations',version:'2026',category:'Examination',filename:'Synthetic Examination and Attendance Regulations 2026',pages:[{pageNumber:1,text:'SYNTHETIC DEMONSTRATION DOCUMENT — Examination and Attendance Regulations 2026. To be eligible for examinations, students must have at least 75% course attendance and have cleared all applicable course fees. Students with an active backlog may sit examinations in other courses subject to departmental approval.'},{pageNumber:2,text:'Students must submit examination registration forms 30 days before the examination. These course attendance rules apply to classroom courses; internship attendance is governed by the internship policy.'}]}
];
