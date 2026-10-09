const crypto=require("crypto");const {list,put}=require("@vercel/blob");const {authHeader,space,okAccess,normalizePhone,sw}=require("./_signalwire");
const BRIDGE_KEY=String(process.env.BRIDGE_KEY||"");
const bw=require("../lib/bandwidth");
function pathFor(phone){return "blocked/"+crypto.createHash("sha256").update("jestcall-block:"+phone).digest("hex")+".json"}
async function isBlocked(phone){const p=pathFor(phone),o=await list({prefix:p,limit:1});return Array.isArray(o.blobs)&&o.blobs.some(b=>b.pathname===p)}
function sigFor(vals){return crypto.createHmac("sha256",BRIDGE_KEY).update(vals.join("\n")).digest("hex")}
function swErr(data,status){const m=data&&((typeof data.message==="string"&&data.message)||(typeof data.error==="string"&&data.error)||(data.error&&data.error.message)||(typeof data.detail==="string"&&data.detail));return "SignalWire rejected the call ("+status+"): "+String(m||"Unknown error").slice(0,500)}
async function jsonFetch(url,opts={}){const r=await fetch(url,opts),t=await r.text();let d={};try{d=JSON.parse(t)}catch{d={message:t}}return{r,d}}
async function signalwireOwned(){
 const project=String(process.env.SIGNALWIRE_PROJECT_ID||"");
 const {r,d}=await jsonFetch("https://"+space()+"/api/laml/2010-04-01/Accounts/"+encodeURIComponent(project)+"/IncomingPhoneNumbers?PageSize=50",{headers:{authorization:authHeader()}});
 if(!r.ok)throw Object.assign(new Error("SignalWire number lookup failed ("+r.status+")."),{status:r.status});
 return (Array.isArray(d.incoming_phone_numbers)?d.incoming_phone_numbers:[]).map(n=>normalizePhone(n&&n.phone_number)).filter(Boolean);
}
async function signalwireVerifiedCallerId(phone){
  const url="https://"+space()+"/api/relay/rest/verified_caller_ids?filter_number="+encodeURIComponent(phone);
  const {r,d}=await jsonFetch(url,{headers:{authorization:authHeader()}});
  if(!r.ok)throw Object.assign(new Error("Could not check verified SignalWire caller IDs ("+r.status+")."),{status:502});
  return Array.isArray(d.data)&&d.data.some(n=>normalizePhone(n&&n.number)===phone&&
    (n.verified===true||String(n.status||"").toLowerCase()==="verified"));
}
async function telnyxOwned(){
 const key=process.env.TELNYX_API_KEY;if(!key)throw Object.assign(new Error("TELNYX_API_KEY is not configured."),{status:503});
 const {r,d}=await jsonFetch("https://api.telnyx.com/v2/phone_numbers?page[size]=100",{headers:{authorization:"Bearer "+key}});
 if(!r.ok){const m=d?.errors?.[0]?.detail||d?.errors?.[0]?.title||d?.message||"Telnyx number lookup failed.";throw Object.assign(new Error(String(m)),{status:r.status})}
 return Array.isArray(d.data)?d.data:[];
}

async function bandwidthAnswer(req,res,u){
 if(req.method!=="POST")return res.status(405).json({error:"POST required."});
 const promptId=String(u.searchParams.get("prompt_id")||""),to=String(u.searchParams.get("to")||""),from=String(u.searchParams.get("from")||"");
 const exp=String(u.searchParams.get("expires")||""),sig=String(u.searchParams.get("sig")||"");
 if(!/^[0-9a-f-]{36}$/i.test(promptId)||!/^\d{13}$/.test(exp)||Date.now()>Number(exp)||Number(exp)>Date.now()+600000||!bw.cmp(sig,bw.answerSignature(promptId,to,from,exp)))return res.status(401).json({error:"Invalid Bandwidth callback."});
 const b=req.body||{},callId=String(b.callId||"");
 if(b.eventType!=="answer"||String(b.accountId)!==bw.account()||String(b.applicationId)!==bw.app()||normalizePhone(b.to)!==to||normalizePhone(b.from)!==from||!/^c-[0-9a-f-]{36}$/i.test(callId))return res.status(403).json({error:"Unexpected Bandwidth callback."});
 const expiry=String(Date.now()+90000),streamSig=bw.streamSignature(callId,promptId,expiry);
 const qs=new URLSearchParams({call_id:callId,prompt_id:promptId,expires:expiry,sig:streamSig});
 const dest="wss://jestcall-gemini-relay.onrender.com/bandwidth?"+qs;
 const xml='<?xml version="1.0" encoding="UTF-8"?><Response><StartStream name="zilos_deepgram" mode="bidirectional" tracks="inbound" destination="'+bw.xesc(dest)+'"><StreamParam name="prompt_id" value="'+bw.xesc(promptId)+'"/></StartStream><StopStream name="zilos_deepgram" wait="true"/></Response>';
 res.status(200).setHeader("content-type","application/xml; charset=utf-8");return res.send(xml);
}
module.exports=async function(req,res){
  // Reuse this function for the prompt-store endpoint to stay within Vercel Hobby limits.
  const qs=new URL(req.url||"/","http://local").searchParams;
  if(String(req.query?.__prompt_store||qs.get("__prompt_store")||"")==="1")return require("../lib/prompt-store-handler")(req,res);
  if(qs.get("__bandwidth_answer")==="1")return bandwidthAnswer(req,res,qs);
 res.setHeader("Cache-Control","no-store");if(req.method!=="POST")return res.status(405).json({error:"POST required."});
 const b=req.body||{};if(!okAccess(b))return res.status(401).json({error:"Incorrect owner access code."});if(b.authorized!==true)return res.status(400).json({error:"Authorization confirmation is required."});
 const provider=String(b.provider||"signalwire").toLowerCase(),to=normalizePhone(b.to_number),from=normalizePhone(b.from_number),requestedDisplay=String(b.display_caller_id||"").trim(),mode=String(b.caller_id_mode||"normal").toLowerCase(),display=mode==="masked"?from:requestedDisplay?normalizePhone(requestedDisplay):from;
 if(!to||!from)return res.status(400).json({error:"Enter valid destination and outbound phone numbers."});
  if(!["normal","masked","private"].includes(mode)&&!(mode==="private"&&provider!=="bandwidth"))return res.status(400).json({error:"Invalid caller ID privacy mode."});
  if(mode!=="normal"&&requestedDisplay)return res.status(400).json({error:"Masked caller ID uses the selected provider number. Remove the custom display caller ID."});
  if(!display)return res.status(400).json({error:"Enter a valid display caller ID."});
 try{
   if(await isBlocked(to))return res.status(403).json({error:"This destination is on the Zilos Tools do-not-call list."});

   if(provider==="bandwidth"){
     if(from!==bw.number())return res.status(400).json({error:"Choose the configured Bandwidth phone number."});
     if(display!==from)return res.status(400).json({error:"Unverified external caller ID is not supported."});
     if(!bw.configured())return res.status(503).json({error:"Bandwidth is not ready. Save a newly rotated BANDWIDTH_CLIENT_SECRET in Vercel and enable bidirectional streaming."});
     const prompt_id=crypto.randomUUID(),name=String(b.recipient_name||"Unknown").slice(0,80);
     try{await put("call-prompts/"+prompt_id+".json",JSON.stringify({id:prompt_id,created_at:new Date().toISOString(),scenario:String(b.scenario||"Friendly mix-up").slice(0,12000),detail:String(b.detail||"").slice(0,6500),recipient_name:name,ai_model:String(b.ai_model||"openai:gpt-5.6-luna").slice(0,80),voice:String(b.voice||"Puck").slice(0,40),accent:String(b.accent||"American").slice(0,40)}),{access:"private",contentType:"application/json",allowOverwrite:true})}
     catch(e){console.error("bandwidth_prompt_store_error",e.message);return res.status(500).json({error:"Could not store the full call prompt."})}
     const expires=String(Date.now()+300000),sig=bw.answerSignature(prompt_id,to,from,expires);
     const answerUrl="https://zilostools.vercel.app/api/call?"+new URLSearchParams({__bandwidth_answer:"1",prompt_id,to,from,expires,sig});
     const request={to,from,applicationId:bw.app(),answerUrl,answerMethod:"POST",callTimeout:45,privacy:mode==="private"};
     if(mode==="private")request.callerDisplayName="Private";
     const d=await bw.api("/calls","POST",request);
     const id=String(d.callId||"");if(!/^c-[0-9a-f-]{36}$/i.test(id))return res.status(502).json({error:"Bandwidth returned no valid call ID."});
     console.log("bandwidth_dial_queued",id,"private",mode==="private");
     return res.status(200).json({success:true,provider:"bandwidth",call_id:id,status:"Queued"});
   }

   if(provider==="telnyx"){
      if(display!==from)return res.status(400).json({error:"Custom Telnyx caller IDs are not configured."});
     const rows=await telnyxOwned(),row=rows.find(n=>normalizePhone(n&&n.phone_number)===from);
     if(!row)return res.status(400).json({error:"That Telnyx outbound number was not found in this account."});
     const connectionId=String(row.connection_id||"");if(!connectionId)return res.status(409).json({error:"That Telnyx number is not assigned to a Voice API connection. Assign it to a Call Control app in Telnyx first."});
     const key=process.env.TELNYX_API_KEY,{r,d}=await jsonFetch("https://api.telnyx.com/v2/calls",{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify({connection_id:connectionId,to,from})});
     if(!r.ok){const m=d?.errors?.[0]?.detail||d?.errors?.[0]?.title||d?.message||"Unknown error";return res.status(r.status).json({error:"Telnyx rejected the call ("+r.status+"): "+String(m).slice(0,500)})}
     const id=String(d?.data?.call_control_id||d?.data?.call_leg_id||"");if(!id)return res.status(502).json({error:"Telnyx accepted the request but did not return a call control ID."});
     console.log("telnyx_dial_result",r.status,JSON.stringify({id,from,to,connection_id:connectionId}));return res.status(200).json({success:true,provider:"telnyx",call_id:id,status:"Queued",media_ready:false});
   }
   if(!BRIDGE_KEY)return res.status(503).json({error:"Relay bridge key is not configured."});
   const owned=await signalwireOwned();if(!owned.includes(from))return res.status(400).json({error:"That SignalWire outbound number was not found in this account."});
    if(display!==from&&!owned.includes(display)&&!(await signalwireVerifiedCallerId(display)))return res.status(400).json({error:"Display caller ID must be a project number or a SignalWire verified caller ID. Verify that number in SignalWire before using it."});
   const name=String(b.recipient_name||"friend").slice(0,80);
   const scenarioFull=String(b.scenario||"Friendly mix-up").slice(0,12000);
   const detailFull=String(b.detail||"").slice(0,6500);
   const voice=String(b.voice||"Puck").slice(0,40),accent=String(b.accent||"American").slice(0,40),ai_model=String(b.ai_model||"openai:gpt-5.6-luna").slice(0,80);
   // Store full prompt server-side; only pass a short id through the provider URL.
   const prompt_id=crypto.randomUUID();
   try{
     await put("call-prompts/"+prompt_id+".json",JSON.stringify({id:prompt_id,created_at:new Date().toISOString(),scenario:scenarioFull,detail:detailFull,recipient_name:name,ai_model,voice,accent}),{access:"private",contentType:"application/json",allowOverwrite:true});
   }catch(e){console.error("prompt_store_failed",e.message);return res.status(500).json({error:"Could not store call prompt."});}
   const scenario=scenarioFull.slice(0,80); // short label only for URL/signature
   const detail="";
   const sig=sigFor([to,name,scenario,detail,voice,accent,ai_model,prompt_id]),host=String(req.headers["x-forwarded-host"]||req.headers.host||"zilostools.vercel.app").split(",")[0].trim();
   const qs=new URLSearchParams({to,name,scenario,detail,voice,accent,ai_model,prompt_id,sig}),url="https://"+host+"/api/swml?"+qs.toString();
   console.log("signalwire_dial_start",from,"display",display);
   const {r,data}=await sw({command:"dial",params:{from:display,to,url}});
   console.log("signalwire_dial_result",r.status,JSON.stringify(data).slice(0,2000));
   if(!r.ok)return res.status(r.status).json({error:swErr(data,r.status)});
   return res.status(200).json({success:true,provider:"signalwire",call_id:String(data.id||""),status:data.status||"Queued"});
 }catch(e){console.error("call_error",provider,e.status||"",e.message);return res.status(e.status||500).json({error:e.message||"Call failed."})}
};