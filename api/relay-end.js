const crypto=require("crypto");
const {list}=require("@vercel/blob");
const {sw}=require("./_signalwire");
const BRIDGE_KEY=String(process.env.BRIDGE_KEY||"");
function b64url(v){const b=Buffer.isBuffer(v)?v:Buffer.from(typeof v==="string"?v:JSON.stringify(v));return b.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}
function privateKey(){let k=String(process.env.VONAGE_PRIVATE_KEY||"");if(k.includes("\\n")&&!k.includes("\n"))k=k.replace(/\\n/g,"\n");return k}
function vonageJwt(){
 const app=String(process.env.VONAGE_APPLICATION_ID||""),key=privateKey();if(!app||!key)throw new Error("Vonage credentials missing.");
 const now=Math.floor(Date.now()/1000),h=b64url({alg:"RS256",typ:"JWT"}),p=b64url({application_id:app,iat:now,nbf:now,exp:now+300,jti:crypto.randomUUID()}),input=h+"."+p;
 const s=crypto.createSign("RSA-SHA256");s.update(input);s.end();return input+"."+b64url(s.sign(key))
}
async function hangupVonage(id){
 const r=await fetch("https://api.nexmo.com/v1/calls/"+encodeURIComponent(id),{method:"PUT",headers:{authorization:"Bearer "+vonageJwt(),"content-type":"application/json"},body:JSON.stringify({action:"hangup"})});
 if(!r.ok){const t=await r.text();throw Object.assign(new Error(t||"Vonage hangup rejected."),{status:r.status})}
}
module.exports=async function(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="POST")return res.status(405).json({error:"POST required."});
 if(!BRIDGE_KEY||String(req.headers["x-bridge-key"]||"")!==BRIDGE_KEY)return res.status(401).json({error:"Unauthorized."});
 const id=String((req.body||{}).call_id||"");
 if(!id)return res.status(400).json({error:"Missing call ID."});
 try{
   if(id.startsWith("vonage:")){
     const session=id.slice(7);
     if(!/^[0-9a-f-]{36}$/i.test(session))return res.status(400).json({error:"Invalid Vonage relay ID."});
     const o=await list({prefix:"vonage-calls/"+session+"/",limit:1});
     const p=Array.isArray(o.blobs)&&o.blobs[0]&&String(o.blobs[0].pathname||"");
     const uuid=p?p.split("/").pop().replace(/\.json$/,""):"";
     if(!uuid)return res.status(404).json({error:"Vonage call mapping not found."});
     await hangupVonage(uuid);
     return res.status(200).json({success:true});
   }
   const {r,data}=await sw({command:"calling.end",id,params:{reason:"hangup"}});
   if(r.ok)return res.status(200).json({success:true});
   return res.status(r.status).json({error:(data&&((data.message)||(data.error&&data.error.message)||data.error))||"Hangup rejected."});
 }catch(e){return res.status(e.status||502).json({error:"Could not end call."})}
};