const crypto=require("crypto");
const {get,put}=require("@vercel/blob");
const {okAccess,authHeader,space}=require("./_signalwire");
const BRIDGE_KEY=String(process.env.BRIDGE_KEY||"");
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const vmPath=id=>"voicemail/"+id+".json";
function send(res,status,obj){res.status(status).json(obj)}
async function readStored(id){
  const r=await get(vmPath(id),{access:"private",useCache:false});if(!r?.stream)return null;
  const parts=[];for await(const c of r.stream)parts.push(Buffer.from(c));
  try{return JSON.parse(Buffer.concat(parts).toString("utf8"))}catch{return null}
}
async function writeStored(id,job){await put(vmPath(id),JSON.stringify(job),{access:"private",allowOverwrite:true,contentType:"application/json"})}
function signature(id){const key=String(process.env.SCHEDULER_SECRET||process.env.CALL_ACCESS_CODE||"");if(!key)throw Error("Webhook secret not configured");return crypto.createHmac("sha256",key).update("voicemail-event:"+id).digest("hex")}
function verified(id,sig){if(!uuid.test(id)||!sig||!/^[a-f0-9]{64}$/i.test(sig))return false;const a=Buffer.from(sig,"hex"),b=Buffer.from(signature(id),"hex");return a.length===b.length&&crypto.timingSafeEqual(a,b)}
function privateKey(){let s=String(process.env.VONAGE_PRIVATE_KEY||process.env.VONAGE_PRIVATE_KEY_B64||"").trim();if(!s)return "";if((s.startsWith('"')&&s.endsWith('"'))||(s.startsWith("'")&&s.endsWith("'"))){try{s=JSON.parse(s)}catch{s=s.slice(1,-1)}}s=s.replace(/\\n/g,"\n");if(!s.includes("BEGIN PRIVATE KEY")&&!s.includes("BEGIN RSA PRIVATE KEY")){const b=Buffer.from(s.replace(/\s/g,""),"base64").toString("utf8");if(b.includes("BEGIN PRIVATE KEY")||b.includes("BEGIN RSA PRIVATE KEY"))s=b}return s}
function jwt(){const id=String(process.env.VONAGE_APPLICATION_ID||"").trim(),key=privateKey();if(!uuid.test(id)||!key.includes("PRIVATE KEY"))throw Error("Vonage credentials are not configured.");const now=Math.floor(Date.now()/1000),data={application_id:id,iat:now,exp:now+120,jti:crypto.randomUUID()};const b64=v=>Buffer.from(JSON.stringify(v)).toString("base64url");const body=b64({alg:"RS256",typ:"JWT"})+"."+b64(data);return body+"."+crypto.sign("RSA-SHA256",Buffer.from(body),key).toString("base64url")}
function cleanMessage(raw){const v=String(raw||"").replace(/[\x00-\x08\x0e-\x1f]/g,"").trim();if(!v||v.length>500)throw Object.assign(Error("Enter a voicemail message up to 500 characters."),{status:400});return /(?:\b(?:ai assistant|automated (?:voice|message|assistant)|artificial intelligence)\b)/i.test(v)?v:"This is an AI assistant. "+v}
async function signalwireCommand(cmd){
  const r=await fetch("https://"+space()+"/api/calling/calls",{method:"POST",headers:{authorization:authHeader(),"content-type":"application/json"},body:JSON.stringify(cmd)});
  let d={};const t=await r.text();try{d=JSON.parse(t)}catch{d={message:t}};
  if(!r.ok)throw Object.assign(new Error(String(d.error||d.message||"SignalWire command failed").slice(0,200)),{status:r.status});return d
}
async function deliver(id,provider,text){
  if(provider==="signalwire"){
    const swml={version:"1.0.0",sections:{main:[{play:{url:"say:"+text}},{hangup:{}}]}};
    await signalwireCommand({command:"calling.transfer",id,params:{dest:swml}});
    return
  }
  if(provider==="vonage"){
    const r=await fetch("https://api.nexmo.com/v1/calls/"+encodeURIComponent(id),{
      method:"PUT",headers:{"content-type":"application/json",authorization:"Bearer "+jwt()},
      body:JSON.stringify({action:"transfer",destination:{type:"ncco",ncco:[{action:"talk",text,language:"en-US",loop:1}]}})
    });
    if(!r.ok){let x={};try{x=await r.json()}catch{}throw Object.assign(new Error(String(x.detail||x.message||"Vonage transfer failed").slice(0,200)),{status:r.status})}
    return
  }
  throw Object.assign(Error("Unsupported call provider."),{status:400})
}
async function onVoicemailWebhook(req,res,url){
  const id=url.searchParams.get("voicemail_callback")||"",sig=url.searchParams.get("sig")||"";
  if(!verified(id,sig))return send(res,401,{error:"Invalid webhook signature"});
  const b=req.body||{},p=b.params||{};
  if(String(p.call_id||"")!==id)return send(res,400,{error:"Call identifier mismatch"});
  const job=await readStored(id);if(!job)return send(res,404,{error:"No detection session"});
  if(job.provider!=="signalwire")return send(res,400,{error:"Unsupported provider"});
  const ev=String(p.detect?.params?.event||"").toUpperCase(),type=String(b.event_type||"");
  if(type==="calling.call.detect"){
    if(ev==="HUMAN"&&!["submitted","depositing"].includes(job.status)){job.status="human";await writeStored(id,job)}
    else if(ev==="MACHINE"&&job.status==="detecting"){job.status="machine";await writeStored(id,job)}
    else if(ev==="READY"&&!["submitted","depositing","human"].includes(job.status)&&job.status==="machine"){
      job.status="depositing";await writeStored(id,job);
      try{await deliver(id,"signalwire",job.text);job.status="submitted";job.submitted_at=new Date().toISOString()}catch(e){job.status="failed";job.error=String(e.message||e).slice(0,180)}
      await writeStored(id,job)
    }else if(ev==="UNKNOWN"&&job.status==="detecting"){job.status="unknown";await writeStored(id,job)}
    else if(ev==="FINISHED"&&job.status==="detecting"){job.status="unknown";await writeStored(id,job)}
  }
  return send(res,200,{ok:true})
}
module.exports=async function(req,res){
  res.setHeader("cache-control","no-store");
  try{
    const url=new URL(req.url||"/api/guide","https://zilostools.vercel.app");
    if(url.searchParams.has("voicemail_callback")){if(req.method!=="POST")return send(res,405,{error:"POST required"});return await onVoicemailWebhook(req,res,url)}
    if(req.method!=="POST")return send(res,405,{error:"POST required."});
    const b=req.body||{};
    if(!okAccess(b))return send(res,401,{error:"Incorrect owner access code."});
    const action=String(b.action||""),id=String(b.call_id||"");
    if(action==="vonage-hello"){
      if(!uuid.test(id))return send(res,400,{error:"Invalid Vonage call ID."});
      const say=b.text==="Hello? Can you hear me?"?"Hello? Can you hear me?":"Hello?";
      const r=await fetch("https://api.nexmo.com/v1/calls/"+encodeURIComponent(id)+"/talk",{method:"PUT",headers:{"content-type":"application/json",authorization:"Bearer "+jwt()},body:JSON.stringify({text:say,language:"en-US",loop:1})});
      const t=await r.text();let d={};try{d=JSON.parse(t)}catch{}
      return r.ok?send(res,200,{success:true,mode:"answer-greeting"}):send(res,r.status,{error:String(d.detail||d.message||"Vonage could not play greeting.").slice(0,220)})
    }
    if(["voicemail-detect","voicemail-status","voicemail-leave"].includes(action)){
      if(!uuid.test(id))return send(res,400,{error:"Valid call ID required."});
      const provider=String(b.provider||"").toLowerCase();
      if(!["signalwire","vonage"].includes(provider))return send(res,400,{error:"Unsupported provider."});
      if(action==="voicemail-status"){
        const j=await readStored(id);if(!j)return send(res,404,{error:"No voicemail detection record."});
        return send(res,200,{success:true,status:j.status||"unknown",error:j.error||null,provider:j.provider})
      }
      if(action==="voicemail-detect"){
        if(provider!=="signalwire")return send(res,400,{error:"SignalWire provider detection only. Vonage uses live beep detection."});
        const existing=await readStored(id);if(existing)return send(res,200,{success:true,status:existing.status});
        const text=cleanMessage(b.text),job={id,provider,status:"detecting",text,created_at:new Date().toISOString()};
        await writeStored(id,job);
        const signed=signature(id),status_url="https://zilostools.vercel.app/api/guide?voicemail_callback="+encodeURIComponent(id)+"&sig="+signed;
        try{await signalwireCommand({command:"calling.detect",id,params:{control_id:"vm-"+crypto.randomUUID(),detect:{type:"machine",params:{detect_message_end:true,initial_timeout:4.5,machine_voice_threshold:1.25,end_silence_timeout:1.0}},timeout:45,status_url}})}
        catch(e){job.status="failed";job.error=String(e.message||e).slice(0,180);await writeStored(id,job);throw e}
        return send(res,200,{success:true,status:"detecting"})
      }
      if(action==="voicemail-leave"){
        const text=cleanMessage(b.text);await deliver(id,provider,text);
        const job=await readStored(id);
        if(job){job.status="submitted";job.submitted_at=new Date().toISOString();await writeStored(id,job)}
        return send(res,200,{success:true,status:"submitted"})
      }
    }
    const msg=String(b.message||"").trim().slice(0,220);
    if(!id||!msg)return send(res,400,{error:"Missing call or guidance."});
    if(!BRIDGE_KEY)return send(res,503,{error:"Bridge key is not configured."});
    const r=await fetch("https://jestcall-gemini-relay.onrender.com/guide",{method:"POST",headers:{"content-type":"application/json","x-bridge-key":BRIDGE_KEY},body:JSON.stringify({call_id:id,message:msg})});
    const t=await r.text();let d={};try{d=JSON.parse(t)}catch{}
    return r.ok?send(res,200,{success:true}):send(res,r.status,{error:d.error||"Guidance rejected."})
  }catch(e){console.error("voicemail_guide",String(e.message||e).slice(0,220));return send(res,e.status||500,{error:String(e.message||e).slice(0,220)})}
};