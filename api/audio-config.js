const http=require("http");
const crypto=require("crypto");
const WebSocket=require("ws");
const {WebSocketServer}=WebSocket;
const {list,put}=require("@vercel/blob");
const {okAccess,normalizePhone}=require("./_signalwire");

const BRIDGE_KEY=String(process.env.BRIDGE_KEY||"");
const UPSTREAM="wss://jestcall-gemini-relay.onrender.com/signalwire";

function send(res,status,obj){
  res.statusCode=status;
  res.setHeader("content-type","application/json");
  res.setHeader("cache-control","no-store");
  res.end(JSON.stringify(obj));
}
async function readJson(req){
  if(req.body&&typeof req.body==="object")return req.body;
  let raw="";
  for await(const chunk of req){raw+=chunk.toString();if(raw.length>20000)throw new Error("Request too large.")}
  if(!raw)return {};
  try{return JSON.parse(raw)}catch{return {}}
}
function pathFor(phone){return "blocked/"+crypto.createHash("sha256").update("jestcall-block:"+phone).digest("hex")+".json"}
async function isBlocked(phone){
  const p=pathFor(phone),o=await list({prefix:p,limit:1});
  return Array.isArray(o.blobs)&&o.blobs.some(b=>b.pathname===p);
}
function b64url(v){
  const b=Buffer.isBuffer(v)?v:Buffer.from(typeof v==="string"?v:JSON.stringify(v));
  return b.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function privateKey(){
  let k=String(process.env.VONAGE_PRIVATE_KEY||process.env.VONAGE_PRIVATE_KEY_B64||"").trim();
  if(!k)return "";
  if((k.startsWith('"')&&k.endsWith('"'))||(k.startsWith("'")&&k.endsWith("'"))){
    try{k=JSON.parse(k)}catch{k=k.slice(1,-1)}
  }
  k=String(k).replace(/^\uFEFF/,"").replace(/\r\n/g,"\n").replace(/\r/g,"\n");
  if(k.includes("\\n"))k=k.replace(/\\n/g,"\n");
  if(!k.includes("-----BEGIN ")&&/^[A-Za-z0-9+/_=-]+$/.test(k.replace(/\s/g,""))){
    try{const d=Buffer.from(k.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8");if(d.includes("-----BEGIN "))k=d}catch{}
  }
  const m=k.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/);
  if(m)k=m[0];
  return k.trim()+"\n";
}
function keyReady(){
  try{const k=privateKey();if(!k)return false;crypto.createPrivateKey(k);return true}catch{return false}
}
function vonageJwt(){
  const app=String(process.env.VONAGE_APPLICATION_ID||""),key=privateKey();
  if(!app||!key)throw new Error("Vonage application credentials are not configured.");
  const now=Math.floor(Date.now()/1000);
  const head=b64url({alg:"RS256",typ:"JWT"});
  const body=b64url({application_id:app,iat:now,nbf:now,exp:now+300,jti:crypto.randomUUID()});
  const input=head+"."+body;
  const signer=crypto.createSign("RSA-SHA256");signer.update(input);signer.end();
  return input+"."+b64url(signer.sign(key));
}
function safeEq(a,b){
  const x=Buffer.from(String(a||"")),y=Buffer.from(String(b||""));
  return x.length===y.length&&crypto.timingSafeEqual(x,y);
}
function eventSig(session){return crypto.createHmac("sha256",BRIDGE_KEY).update("vonage-event:"+session).digest("hex")}
function uuidOk(v){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v||""))}
function hostFor(req){return String(req.headers["x-forwarded-host"]||req.headers.host||"zilostools.vercel.app").split(",")[0].trim()}
async function jsonFetch(url,opts={}){
  const r=await fetch(url,opts),t=await r.text();let d={};
  try{d=t?JSON.parse(t):{}}catch{d={message:t}}
  return {r,d};
}
function vonageError(d,status){
  const m=d?.detail||d?.title||d?.error_title||d?.error_text||d?.message||d?.error||"Vonage rejected the request.";
  return "Vonage rejected the request ("+status+"): "+String(m).slice(0,500);
}
async function hangupVonage(id){
  const jwt=vonageJwt();
  const {r,d}=await jsonFetch("https://api.nexmo.com/v1/calls/"+encodeURIComponent(id),{
    method:"PUT",
    headers:{authorization:"Bearer "+jwt,"content-type":"application/json"},
    body:JSON.stringify({action:"hangup"})
  });
  if(!r.ok)throw Object.assign(new Error(vonageError(d,r.status)),{status:r.status});
  return true;
}
async function handleVonageEvent(req,res,url){
  if(!BRIDGE_KEY)return send(res,503,{error:"Bridge key not configured."});
  const session=String(url.searchParams.get("session")||""),sig=String(url.searchParams.get("sig")||"");
  if(!/^[0-9a-f-]{36}$/i.test(session)||!safeEq(sig,eventSig(session)))return send(res,401,{error:"Unauthorized."});
  const b=await readJson(req),uuid=String(b.uuid||"");
  if(uuidOk(uuid)){
    const path="vonage-calls/"+session+"/"+uuid+".json";
    try{await put(path,JSON.stringify({uuid,status:String(b.status||""),updated_at:new Date().toISOString()}),{access:"private",allowOverwrite:true,contentType:"application/json"})}catch{}
  }
  return send(res,200,{ok:true});
}
async function handlePost(req,res,url){
  if(url.searchParams.get("mode")==="vonage-event")return handleVonageEvent(req,res,url);
  let b;
  try{b=await readJson(req)}catch(e){return send(res,413,{error:e.message})}
  const action=String(b.action||"");
  if(action==="vonage-numbers"){
    if(!okAccess(b))return send(res,401,{error:"Incorrect owner access code."});
    const n=normalizePhone(process.env.VONAGE_PHONE_NUMBER);
    if(!n)return send(res,503,{error:"VONAGE_PHONE_NUMBER is not configured."});
    return send(res,200,{provider:"vonage",numbers:[{phone_number:n,friendly_name:"Vonage"}]});
  }
  if(action==="vonage-end"){
    if(!okAccess(b))return send(res,401,{error:"Incorrect owner access code."});
    const id=String(b.call_id||"").trim();
    if(!uuidOk(id))return send(res,400,{error:"Missing or invalid Vonage call ID."});
    try{await hangupVonage(id);return send(res,200,{success:true})}
    catch(e){return send(res,e.status||502,{error:e.message||"Could not end Vonage call."})}
  }
  if(action==="vonage-call"){
    if(!okAccess(b))return send(res,401,{error:"Incorrect owner access code."});
    if(b.authorized!==true)return send(res,400,{error:"You must confirm authorization before placing the call."});
    const to=normalizePhone(b.to_number),from=normalizePhone(b.from_number),owned=normalizePhone(process.env.VONAGE_PHONE_NUMBER);
    if(!to)return send(res,400,{error:"Enter a valid destination number."});
    if(!from||!owned||from!==owned)return send(res,400,{error:"Choose the configured Vonage number."});
    try{if(await isBlocked(to))return send(res,403,{error:"This destination is on the Zilos Tools do-not-call list."})}
    catch{return send(res,500,{error:"Could not check the do-not-call list."})}
    if(!BRIDGE_KEY)return send(res,503,{error:"Bridge key is not configured."});
    if(!process.env.VONAGE_APPLICATION_ID||!keyReady())return send(res,503,{error:"Vonage application credentials are not configured for this deployment."});
    const session=crypto.randomUUID(),host=hostFor(req);
    const name=String(b.recipient_name||"friend").trim().slice(0,80);
    const scenarioFull=String(b.scenario||"Friendly mix-up").trim().slice(0,12000);
    const detailFull=String(b.detail||"").trim().slice(0,6500);
    const voice=String(b.voice||"Puck").trim().slice(0,40);
    const accent=String(b.accent||"American").trim().slice(0,40);
    const ai_model=String(b.ai_model||"openai:gpt-5.6-luna").trim().slice(0,80);
    const prompt_id=crypto.randomUUID();
    try{
      await put("call-prompts/"+prompt_id+".json",JSON.stringify({id:prompt_id,created_at:new Date().toISOString(),scenario:scenarioFull,detail:detailFull,recipient_name:name,ai_model,voice,accent}),{access:"private",contentType:"application/json",allowOverwrite:true});
    }catch(e){return send(res,500,{error:"Could not store call prompt."});}
    const scenario=scenarioFull.slice(0,80);
    const detail="";
    const wsUrl="wss://"+host+"/api/audio-config";
    const evUrl="https://"+host+"/api/audio-config?mode=vonage-event&session="+encodeURIComponent(session)+"&sig="+eventSig(session);
    const ncco=[{action:"connect",endpoint:[{
      type:"websocket",uri:wsUrl,"content-type":"audio/l16;rate=16000",
      headers:{session_id:session,recipient_name:name,scenario,detail,voice,accent,ai_model,prompt_id,to_number:to},
      authorization:{type:"custom",value:"Bearer "+BRIDGE_KEY}
    }]}];
    let jwt;
    try{jwt=vonageJwt()}catch(e){return send(res,503,{error:e.message})}
    const {r,d}=await jsonFetch("https://api.nexmo.com/v1/calls/",{
      method:"POST",
      headers:{authorization:"Bearer "+jwt,"content-type":"application/json"},
      body:JSON.stringify({
        to:[{type:"phone",number:to.replace(/^\+/,"")}],
        from:{type:"phone",number:from.replace(/^\+/,"")},
        event_url:[evUrl],event_method:"POST",ncco
      })
    });
    if(!r.ok)return send(res,r.status,{error:vonageError(d,r.status)});
    const callId=String(d.uuid||"");
    if(!uuidOk(callId))return send(res,502,{error:"Vonage accepted the request but did not return a call ID."});
    return send(res,200,{success:true,provider:"vonage",call_id:callId,relay_call_id:"vonage:"+session,status:String(d.status||"started")});
  }

  if(!okAccess(b))return send(res,401,{error:"Incorrect owner access code."});
  const id=String(b.call_id||"");
  if(!id)return send(res,400,{error:"Missing call ID."});
  if(!BRIDGE_KEY)return send(res,503,{error:"Bridge key is not configured."});
  const token=crypto.createHmac("sha256",BRIDGE_KEY).update(id).digest("hex");
  return send(res,200,{configured:true,browser_ws_url:"wss://jestcall-gemini-relay.onrender.com/?role=listener&call_id="+encodeURIComponent(id)+"&token="+token});
}

function linearToMuLaw(sample){
  const BIAS=0x84,CLIP=32635;let sign=0;
  if(sample<0){sign=0x80;sample=-sample}
  if(sample>CLIP)sample=CLIP;
  sample+=BIAS;let exponent=7;
  for(let mask=0x4000;exponent>0&&(sample&mask)===0;exponent--,mask>>=1){}
  const mantissa=(sample>>(exponent+3))&15;
  return (~(sign|(exponent<<4)|mantissa))&255;
}
function muLawToLinear(u){
  u=(~u)&255;const sign=u&128,exponent=(u>>4)&7,mantissa=u&15;
  let sample=((mantissa<<3)+0x84)<<exponent;sample-=0x84;
  return sign?-sample:sample;
}
function pcm16kToMuLaw8k(buf){
  const n=Math.floor(buf.length/2),out=Buffer.alloc(Math.floor(n/2));let j=0;
  for(let i=0;i+1<n;i+=2){const a=buf.readInt16LE(i*2),c=buf.readInt16LE((i+1)*2);out[j++]=linearToMuLaw((a+c)>>1)}
  return out.subarray(0,j);
}
function muLaw8kToPcm16k(buf){
  const out=Buffer.alloc(buf.length*4);let o=0;
  for(const u of buf){const s=muLawToLinear(u);out.writeInt16LE(s,o);o+=2;out.writeInt16LE(s,o);o+=2}
  return out;
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url||"/","http://local");
  if(req.method==="POST"){try{return await handlePost(req,res,url)}catch(e){return send(res,500,{error:"Server error."})}}
  if(req.method==="GET")return send(res,200,{ok:true,service:"zilos-audio-config",websocket:true,vonage_key_ready:keyReady(),bridge_key_ready:!!BRIDGE_KEY});
  return send(res,405,{error:"POST required."});
});
const wss=new WebSocketServer({server});
wss.on("connection",(client,req)=>{
  if(!BRIDGE_KEY||req.headers.authorization!=="Bearer "+BRIDGE_KEY){client.close(1008,"unauthorized");return}
  let upstream=null,ready=false,seq=1,chunk=1;
  const startedAt=Date.now(),pending=[];
  function closeBoth(){
    try{if(upstream&&upstream.readyState===WebSocket.OPEN)upstream.close()}catch{}
    try{if(client.readyState===WebSocket.OPEN)client.close()}catch{}
  }
  function sendUp(buf){
    if(!ready||!upstream||upstream.readyState!==WebSocket.OPEN){if(pending.length<100)pending.push(Buffer.from(buf));return}
    const ulaw=pcm16kToMuLaw8k(buf);
    upstream.send(JSON.stringify({event:"media",sequenceNumber:String(++seq),media:{track:"inbound",chunk:String(chunk++),timestamp:String(Date.now()-startedAt),payload:ulaw.toString("base64")}}));
  }
  function openUp(meta){
    if(upstream)return;
    meta=meta||{};
    const sid=String(meta.session_id||crypto.randomUUID()),relayId="vonage:"+sid;
    upstream=new WebSocket(UPSTREAM,{headers:{Authorization:"Bearer "+BRIDGE_KEY}});
    upstream.on("open",()=>{
      upstream.send(JSON.stringify({event:"connected",protocol:"Call",version:"0.2.0"}));
      upstream.send(JSON.stringify({event:"start",sequenceNumber:String(seq),start:{
        streamSid:relayId,accountSid:"vonage",callSid:relayId,tracks:["inbound"],
        customParameters:{recipient_name:String(meta.recipient_name||""),scenario:String(meta.scenario||""),detail:String(meta.detail||""),voice:String(meta.voice||"Puck"),accent:String(meta.accent||"American"),ai_model:String(meta.ai_model||"openai:gpt-5.6-luna"),prompt_id:String(meta.prompt_id||""),to_number:String(meta.to_number||""),provider:"vonage"},
        mediaFormat:{encoding:"audio/x-mulaw",sampleRate:8000,channels:1}
      }}));
      ready=true;while(pending.length)sendUp(pending.shift());
    });
    upstream.on("message",(data,isBinary)=>{
      if(isBinary)return;
      let m;try{m=JSON.parse(data.toString())}catch{return}
      if(m?.event==="media"&&m.media?.payload){
        if(client.readyState===WebSocket.OPEN)client.send(muLaw8kToPcm16k(Buffer.from(String(m.media.payload),"base64")),{binary:true});
      }else if(m?.event==="clear"){
        if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify({action:"clear"}));
      }else if(m?.event==="stop")closeBoth();
    });
    upstream.on("close",()=>{if(client.readyState===WebSocket.OPEN)client.close(1000,"upstream closed")});
    upstream.on("error",closeBoth);
  }
  client.on("message",(data,isBinary)=>{
    if(isBinary){sendUp(Buffer.from(data));return}
    let m;try{m=JSON.parse(data.toString())}catch{return}
    if(!upstream&&(m.event==="websocket:connected"||m["content-type"]))openUp(m);
  });
  client.on("close",()=>{
    if(upstream&&upstream.readyState===WebSocket.OPEN){
      try{upstream.send(JSON.stringify({event:"stop",sequenceNumber:String(++seq)}))}catch{}
      try{upstream.close()}catch{}
    }
  });
  client.on("error",closeBoth);
});
module.exports=server;