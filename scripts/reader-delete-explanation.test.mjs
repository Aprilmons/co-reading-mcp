import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const temp = await mkdtemp(path.join(os.tmpdir(), "co-reading-delete-"));
process.env.READING_MCP_DATA_DIR = temp;
await mkdir(path.join(temp, "books/test/chunks"), { recursive: true });
await writeFile(path.join(temp, "books/test/chunks/c.txt"), "A new day.");
await writeFile(path.join(temp, "books/test/manifest.json"), JSON.stringify({bookId:"test",title:"Fixture",chunks:[{id:"c", title:"Start", order:0, path:"chunks/c.txt"}]}));
const db = await import("../src/store.js");
const {handleApi} = await import("../src/http-routes.js");
after(() => rm(temp, {recursive:true,force:true}));
const payload = (extras = {}) => ({bookId:"test",chunkId:"c",quote:"new",anchor:{start:2,end:5},visibility:"private",note:"Answer",question:"Why?",provider:"deepseek",model:"fixture",clientRequestId:"explanation_"+randomUUID(),...extras});
const reason = (errorCode) => (e) => e.code === errorCode;
const params = input => ({clientRequestId:input.clientRequestId,expectedRevision:1});
async function request(method, route, payload, allowed=true) {
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]);
  req.method=method; req.headers={}; let result;
  const res={writeHead(status){this.status=status},end(data){result={status:this.status,body:JSON.parse(data)}}};
  await handleApi(req,res,new URL("http://fixture.invalid"+route),{readerDeleteAuthenticated:allowed});
  return result;
}
test("only the matched original request can delete; HTTP readback, replay prevention and receipt survive unrelated writes",async()=>{
  const p=payload({note:"Unique answer to remove"}),{annotation:a}=await db.createReaderExplanation(p);
  assert.equal(a._readerRequests,undefined);
  const route="/api/reader/explanations/"+a.id, body=params(p);
  assert.equal((await request("GET","/api/reader/capabilities",undefined,false)).body.readerExplanations.delete,false);
  assert.equal((await request("GET","/api/reader/capabilities")).body.readerExplanations.delete,true);
  assert.equal((await request("DELETE",route,body,false)).status,403);
  assert.equal((await request("DELETE",route,{...body,clientRequestId:payload().clientRequestId})).body.error.code,"not_owner");
  assert.equal((await request("DELETE",route,{...body,expectedRevision:2})).body.error.code,"revision_conflict");
  assert.equal((await request("GET","/api/reader/annotations/"+a.id)).status,200);
  assert.deepEqual((await request("DELETE",route,body)).body,{deleted:true,id:a.id});
  assert.equal((await request("GET","/api/reader/annotations/"+a.id)).status,404);
  const n = await db.createReaderAnnotation({bookId:p.bookId,chunkId:p.chunkId,anchor:p.anchor,quote:p.quote,note:"Human",clientRequestId:"reader_"+randomUUID()});
  await db.updateReaderAnnotation(n.annotation.id,{expectedRevision:1,note:"New human text",clientRequestId:"edit_"+randomUUID()});
  await assert.rejects(db.deleteReaderExplanation(n.annotation.id,body),reason("not_owner"));
  await assert.rejects(db.createReaderExplanation(p),reason("item_removed"));
  assert.deepEqual((await request("DELETE",route,body)).body,{deleted:true,id:a.id});
  assert.equal((await request("GET","/api/annotations")).body.some(r=>r.id===a.id),false);
  const onDisk = await readFile(path.join(temp,"annotations.jsonl"),"utf8"); assert.ok(!onDisk.includes(p.note) && !onDisk.includes(p.clientRequestId));
});
test("replies, active collections and referenced cards are never cascaded",async()=>{
  const p=payload(), parent=(await db.createReaderExplanation(p)).annotation;
  const child=payload({parentId:parent.id}), reply=(await db.createReaderExplanation(child)).annotation;
  await assert.rejects(db.deleteReaderExplanation(parent.id, params(p)),reason("has_replies"));
  const {collection}=await db.collectReaderAnnotation({annotationId:reply.id,kind:"term",title:"kept excerpt",clientRequestId:"excerpt_"+randomUUID()});
  await assert.rejects(db.deleteReaderExplanation(reply.id,params(child)),reason("in_collection"));
  await db.deleteReaderCollection(collection.id);
  await db.deleteReaderExplanation(reply.id,params(child));
  await writeFile(path.join(temp,"cards.jsonl"),JSON.stringify({id:"card_fixture",sourceAnnotationIds:[parent.id],bookId:"test",chunkId:"c"})+"\n");
  await assert.rejects(db.deleteReaderExplanation(parent.id,params(p)),reason("in_card"));
  assert.equal((await db.getReaderAnnotation(parent.id)).annotation.note,p.note);
});
test("deleting a private explanation may not unmask a legacy source-less copied card",async()=>{
  // A distinct chunk with no other hidden annotations in this fixture.
  const manifest={bookId:"second",chunks:[{id:"c",title:"C",order:0,path:"chunks/c.txt"}]};
  await mkdir(path.join(temp,"books/second/chunks"),{recursive:true});
  await writeFile(path.join(temp,"books/second/chunks/c.txt"),"A new day.");
  await writeFile(path.join(temp,"books/second/manifest.json"),JSON.stringify(manifest));
  const p=payload({bookId:"second"}),a=(await db.createReaderExplanation(p)).annotation;
  await writeFile(path.join(temp,"cards.jsonl"),JSON.stringify({id:"old",bookId:"second",chunkId:"c"})+"\n");
  await assert.rejects(db.deleteReaderExplanation(a.id,params(p)),reason("in_card"));
});
