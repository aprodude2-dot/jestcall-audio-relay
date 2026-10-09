const crypto=require("crypto");
const {list,put,get}=require("@vercel/blob");
const {authHeader,space,okAccess}=require("./_signalwire");
const PREFIX="zilos-schedule/",TOPIC="zilos-scheduled-calls",MAX_DELAY=7*24*60*60;
const COOKIE="zilos_sched_auth",SESSION_AGE=60*60*24*30;
function sendJson(res,status,obj){res.statusCode=status;res.setHeader("content-type","application/json");res.setHeader("cache-control","no-store");res.end(JSON.stringify(obj))}
async function readJson(req){if(req.body&&typeof req.body==="object")return req.body;let raw="";for await(const c of req){raw+=c.toString();if(raw.length>1024*1024)throw Object.assign(new Error("Request too large."),{status:413})}if(!raw)return {};try{return JSON.parse(raw)}catch{throw Object.assign(new Error("Invalid JSON."),{status:400})}}
async function jsonFetch(url,opts={}){const r=await fetch(url,opts),t=await r.text();let d={};try{d=JSON.parse(t)}catch{d={message:t}}return{r,d}}
async function signalwireNumbers(){const project=String(process.env.SIGNALWIRE_PROJECT_ID||"");const {r,d}=await jsonFetch("https://"+space()+"/api/laml/2010-04-01/Accounts/"+encodeURIComponent(project)+"/IncomingPhoneNumbers?PageSize=50",{headers:{authorization:authHeader()}});if(!r.ok)throw Object.assign(new Error("SignalWire number lookup failed ("+r.status+")."),{status:r.status});return (Array.isArray(d.incoming_phone_numbers)?d.incoming_phone_numbers:[]).filter(n=>n&&n.phone_number&&(!n.capabilities||n.capabilities.voice!==false)).map(n=>({phone_number:String(n.phone_number),friendly_name:String(n.friendly_name||n.phone_number),sid:String(n.sid||"")}))}
function key(){return process.env.SCHEDULER_SECRET||process.env.CALL_ACCESS_CODE||""}
function sign(v){return crypto.createHmac("sha256",key()).update("zilos-schedule-cookie:"+v).digest("hex")}
function setSession(res){if(!key())return;const exp=Date.now()+SESSION_AGE*1000;const raw=String(exp),value=raw+"."+sign(raw);res.setHeader("set-cookie",COOKIE+"="+value+"; Path=/api/numbers; Max-Age="+SESSION_AGE+"; HttpOnly; Secure; SameSite=Strict")}
function readCookie(req){if(!key())return false;const cookies=String(req.headers?.cookie||"").split(";").map(s=>s.trim());const item=cookies.find(s=>s.startsWith(COOKIE+"="));if(!item)return false;const v=item.slice(COOKIE.length+1),i=v.indexOf(".");if(i<0)return false;const exp=v.slice(0,i),sig=v.slice(i+1);if(!/^\d{13}$/.test(exp)||Number(exp)<Date.now()||!/^[0-9a-f]{64}$/.test(sig))return false;const a=Buffer.from(sig),b=Buffer.from(sign(exp));return a.length===b.length&&crypto.timingSafeEqual(a,b)}
function authorized(req,b){return !!okAccess(b)||readCookie(req)}
function requireAuth(req,b){if(!authorized(req,b))throw Object.assign(new Error("Owner authentication required."),{status:401});}
function phone(v){const raw=String(v||"").trim(),d=raw.replace(/\D/g,"");if(raw.startsWith("+")&&d.length>=10&&d.length<=15)return "+"+d;if(d.length===10)return "+1"+d;if(d.length===11&&d[0]==="1")return "+"+d;return ""}
function pathFor(ms,id){return PREFIX+String(ms).padStart(13,"0")+"-"+id+".json"}
function publicJob(j){return{id:j.id,scheduled_for:j.scheduled_for,status:j.status,provider:j.payload?.provider||"",to_number:j.payload?.to_number||"",recipient_name:j.payload?.recipient_name||"",scenario:j.payload?.scenario||"",created_at:j.created_at,completed_at:j.completed_at||null,error:j.error||null,call_id:j.call_id||null}}
async function readJob(path){const g=await get(path,{access:"private",useCache:false});if(!g||!g.stream)return null;const chunks=[];for await(const c of g.stream)chunks.push(Buffer.from(c));const s=Buffer.concat(chunks).toString("utf8");try{return JSON.parse(s)}catch(e){throw new Error("Stored schedule record could not be decoded.")}}
async function writeJob(path,j){await put(path,JSON.stringify(j),{access:"private",allowOverwrite:true,contentType:"application/json"})}
async function allBlobs(){let cursor,all=[];do{const o=await list({prefix:PREFIX,limit:1000,cursor});all.push(...(o.blobs||[]));cursor=o.cursor||undefined}while(cursor&&all.length<5000);return all}
async function createSchedule(b){
 if(!okAccess(b))throw Object.assign(new Error("Owner authorization is required from call setup."),{status:401});
 if(b.authorized!==true)throw Object.assign(new Error("Authorization confirmation is required."),{status:400});
 const ms=Date.parse(String(b.scheduled_for||"")),now=Date.now();if(!Number.isFinite(ms))throw Object.assign(new Error("Choose a valid date and time."),{status:400});
 const delay=Math.ceil((ms-now)/1000);if(delay<15)throw Object.assign(new Error("Scheduled time must be at least 15 seconds in the future."),{status:400});if(delay>MAX_DELAY)throw Object.assign(new Error("Scheduled calls can be up to 7 days ahead."),{status:400});
 const provider=String(b.provider||"vonage").toLowerCase();if(!["vonage","signalwire"].includes(provider))throw Object.assign(new Error("Unsupported provider."),{status:400});
 const to=phone(b.to_number),from=phone(b.from_number),requestedDisplay=String(b.display_caller_id||"").trim(),display=requestedDisplay?phone(requestedDisplay):"";if(!to||!from)throw Object.assign(new Error("A valid destination and outbound number are required."),{status:400});if(requestedDisplay&&!display)throw Object.assign(new Error("Enter a valid display caller ID."),{status:400});
 const id=crypto.randomUUID(),path=pathFor(ms,id);
 const j={id,path,created_at:new Date().toISOString(),scheduled_for:new Date(ms).toISOString(),scheduled_ms:ms,status:"scheduled",payload:{provider,to_number:to,from_number:from,display_caller_id:display,recipient_name:String(b.recipient_name||"friend").slice(0,80),scenario:String(b.scenario||"Custom Prompt"),detail:String(b.detail||""),voice:String(b.voice||"Puck"),accent:String(b.accent||"American"),authorized:true}};
 await writeJob(path,j);
 try{const {send}=await import("@vercel/queue");const q=await send(TOPIC,{id,path},{delaySeconds:delay,retentionSeconds:MAX_DELAY,idempotencyKey:"schedule-"+id});j.message_id=String(q?.messageId||"");await writeJob(path,j)}
 catch(e){j.status="failed";j.completed_at=new Date().toISOString();j.error="Queue scheduling failed.";await writeJob(path,j);console.error("schedule_queue_error",String(e.message||e));throw Object.assign(new Error("Could not schedule the call."),{status:500})}
 return publicJob(j)
}
async function listSchedules(){const blobs=await allBlobs(),jobs=[];for(const x of blobs){const j=await readJob(x.pathname);if(j)jobs.push(publicJob(j))}jobs.sort((a,b)=>Date.parse(a.scheduled_for)-Date.parse(b.scheduled_for));return jobs.slice(-200)}
async function cancelSchedule(b){const id=String(b.id||"");if(!/^[0-9a-f-]{36}$/i.test(id))throw Object.assign(new Error("Valid schedule ID required."),{status:400});const blobs=await allBlobs(),x=blobs.find(v=>String(v.pathname).endsWith("-"+id+".json"));if(!x)throw Object.assign(new Error("Scheduled call not found."),{status:404});const j=await readJob(x.pathname);if(!j)throw Object.assign(new Error("Scheduled call not found."),{status:404});if(j.status==="scheduled"){j.status="cancelled";j.completed_at=new Date().toISOString();await writeJob(x.pathname,j)}return publicJob(j)}
module.exports=async(req,res)=>{
 try{
  if(req.method==="GET")return sendJson(res,200,{ok:true,service:"zilos-numbers-scheduler",scheduler:"vercel-queue",schedule_view:"cookie-session"});
  if(req.method!=="POST")return sendJson(res,405,{error:"Method not allowed."});
  const b=await readJson(req),action=String(b.action||"");
  if(action==="schedule-auth"){if(!okAccess(b))return sendJson(res,401,{error:"Invalid owner access code."});setSession(res);return sendJson(res,200,{success:true,authorized:true})}
  if(action==="schedule-create"){const job=await createSchedule(b);setSession(res);return sendJson(res,200,{success:true,schedule:job})}
  if(action==="schedule-list"){requireAuth(req,b);if(okAccess(b))setSession(res);return sendJson(res,200,{success:true,schedules:await listSchedules()})}
  if(action==="schedule-cancel"){requireAuth(req,b);if(okAccess(b))setSession(res);return sendJson(res,200,{success:true,schedule:await cancelSchedule(b)})}
  if(!okAccess(b))return sendJson(res,401,{error:"Invalid owner access code."});
  return sendJson(res,200,{success:true,provider:"signalwire",numbers:await signalwireNumbers()})
 }catch(e){console.error("scheduler_handler",String(e.message||e).slice(0,300));return sendJson(res,e.status||500,{error:String(e.message||e)})}
};