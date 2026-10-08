const crypto=require("crypto");
const {put,get,del} = require("@vercel/blob");
const {okAccess}=require("./_signalwire");

const BRIDGE_KEY=String(process.env.BRIDGE_KEY||"");
const PREFIX="call-prompts/";
const MAX_SCENARIO=12000;
const MAX_DETAIL=6500;

function send(res,status,obj){
  res.statusCode=status;
  res.setHeader("content-type","application/json");
  res.setHeader("cache-control","no-store");
  res.end(JSON.stringify(obj));
}

function bridgeOk(req,b){
  const h=String(req.headers["x-bridge-key"]||"");
  const bodyKey=String(b?.bridge_key||"");
  return !!(BRIDGE_KEY && (h===BRIDGE_KEY || bodyKey===BRIDGE_KEY));
}

function pathFor(id){return PREFIX+id+".json"}

async function readJson(req){
  if(req.body && typeof req.body==="object")return req.body;
  let raw="";
  for await(const c of req){raw+=c.toString();if(raw.length>200000)throw Object.assign(new Error("Request too large."),{status:413});}
  if(!raw)return {};
  try{return JSON.parse(raw)}catch{throw Object.assign(new Error("Invalid JSON."),{status:400});}
}

async function storePrompt(payload){
  const id=crypto.randomUUID();
  const doc={
    id,
    created_at:new Date().toISOString(),
    scenario:String(payload.scenario||"").slice(0,MAX_SCENARIO),
    detail:String(payload.detail||"").slice(0,MAX_DETAIL),
    recipient_name:String(payload.recipient_name||"Unknown").slice(0,80),
    ai_model:String(payload.ai_model||"openai:gpt-5.6-luna").slice(0,80),
    voice:String(payload.voice||"").slice(0,40),
    accent:String(payload.accent||"").slice(0,40)
  };
  await put(pathFor(id), JSON.stringify(doc), {access:"private", contentType:"application/json", allowOverwrite:true});
  return doc;
}

async function loadPrompt(id){
  if(!/^[0-9a-f-]{36}$/i.test(String(id||"")))return null;
  const g=await get(pathFor(id), {access:"private", useCache:false});
  if(!g?.stream)return null;
  const parts=[];
  for await(const c of g.stream)parts.push(Buffer.from(c));
  try{
    const doc=JSON.parse(Buffer.concat(parts).toString("utf8"));
    const age=Date.now()-Date.parse(doc.created_at||0);
    if(Number.isFinite(age) && age>24*60*60*1000){
      try{await del(pathFor(id))}catch{}
      return null;
    }
    return doc;
  }catch{return null}
}

module.exports=async function(req,res){
  try{
    if(req.method==="GET"){
      const url=new URL(req.url||"/","http://local");
      const id=url.searchParams.get("id")||"";
      // Relay retrieves with bridge key
      if(!bridgeOk(req,{}))return send(res,401,{error:"Unauthorized."});
      const doc=await loadPrompt(id);
      if(!doc)return send(res,404,{error:"Prompt not found."});
      return send(res,200,{success:true,prompt:doc});
    }
    if(req.method!=="POST")return send(res,405,{error:"POST required."});
    const b=await readJson(req);
    // Owner stores before placing a call
    if(!okAccess(b) && !bridgeOk(req,b))return send(res,401,{error:"Unauthorized."});
    if(b.action==="load"){
      const doc=await loadPrompt(b.id);
      if(!doc)return send(res,404,{error:"Prompt not found."});
      return send(res,200,{success:true,prompt:doc});
    }
    if(b.action==="delete"){
      if(!bridgeOk(req,b) && !okAccess(b))return send(res,401,{error:"Unauthorized."});
      const id=String(b.id||"");
      if(!/^[0-9a-f-]{36}$/i.test(id))return send(res,400,{error:"Invalid prompt id."});
      try{await del(pathFor(id))}catch(e){console.error("prompt_delete",e.message)}
      return send(res,200,{success:true,deleted:id});
    }
    const doc=await storePrompt(b);
    return send(res,200,{success:true,prompt_id:doc.id,scenario_chars:doc.scenario.length,detail_chars:doc.detail.length});
  }catch(e){
    console.error("prompt_store",String(e.message||e).slice(0,200));
    return send(res,e.status||500,{error:String(e.message||e)});
  }
};

// Shared helper for other API routes (same process may not import this easily on Vercel — duplicated inline in callers)
module.exports.storePrompt=storePrompt;
module.exports.loadPrompt=loadPrompt;
module.exports.MAX_SCENARIO=MAX_SCENARIO;
module.exports.MAX_DETAIL=MAX_DETAIL;
