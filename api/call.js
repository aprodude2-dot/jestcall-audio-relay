const crypto=require("crypto");const {list}=require("@vercel/blob");const {authHeader,space,okAccess,normalizePhone,sw}=require("./_signalwire");
const BRIDGE_KEY=String(process.env.BRIDGE_KEY||"");
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
async function telnyxOwned(){
 const key=process.env.TELNYX_API_KEY;if(!key)throw Object.assign(new Error("TELNYX_API_KEY is not configured."),{status:503});
 const {r,d}=await jsonFetch("https://api.telnyx.com/v2/phone_numbers?page[size]=100",{headers:{authorization:"Bearer "+key}});
 if(!r.ok){const m=d?.errors?.[0]?.detail||d?.errors?.[0]?.title||d?.message||"Telnyx number lookup failed.";throw Object.assign(new Error(String(m)),{status:r.status})}
 return Array.isArray(d.data)?d.data:[];
}
module.exports=async function(req,res){
 res.setHeader("Cache-Control","no-store");if(req.method!=="POST")return res.status(405).json({error:"POST required."});
 const b=req.body||{};if(!okAccess(b))return res.status(401).json({error:"Incorrect owner access code."});if(b.authorized!==true)return res.status(400).json({error:"Authorization confirmation is required."});
 const provider=String(b.provider||"signalwire").toLowerCase(),to=normalizePhone(b.to_number),from=normalizePhone(b.from_number);
 if(!to||!from)return res.status(400).json({error:"Enter valid destination and outbound phone numbers."});
 try{
   if(await isBlocked(to))return res.status(403).json({error:"This destination is on the Zilos Tools do-not-call list."});
   if(provider==="telnyx"){
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
   const name=String(b.recipient_name||"friend").slice(0,32),scenario=String(b.scenario||"Friendly mix-up").slice(0,80),detail=String(b.detail||"").slice(0,180),voice=String(b.voice||"Puck").slice(0,40),accent=String(b.accent||"American").slice(0,40);
   const sig=sigFor([to,name,scenario,detail,voice,accent]),host=String(req.headers["x-forwarded-host"]||req.headers.host||"zilostools.vercel.app").split(",")[0].trim();
   const qs=new URLSearchParams({to,name,scenario,detail,voice,accent,sig}),url="https://"+host+"/api/swml?"+qs.toString();
   console.log("signalwire_dial_start",from);
   const {r,data}=await sw({command:"dial",params:{from,to,url}});
   console.log("signalwire_dial_result",r.status,JSON.stringify(data).slice(0,2000));
   if(!r.ok)return res.status(r.status).json({error:swErr(data,r.status)});
   return res.status(200).json({success:true,provider:"signalwire",call_id:String(data.id||""),status:data.status||"Queued"});
 }catch(e){console.error("call_error",provider,e.status||"",e.message);return res.status(e.status||500).json({error:e.message||"Call failed."})}
};