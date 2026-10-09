const {okAccess,sw}=require("./_signalwire");
const bw=require("../lib/bandwidth");
async function jsonFetch(url,opts={}){const r=await fetch(url,opts),t=await r.text();let d={};try{d=JSON.parse(t)}catch{d={message:t}}return{r,d}}
module.exports=async function(req,res){
 res.setHeader("Cache-Control","no-store");if(req.method!=="POST")return res.status(405).json({error:"POST required."});
 const b=req.body||{};if(!okAccess(b))return res.status(401).json({error:"Incorrect owner access code."});
 const id=String(b.call_id||"").trim(),provider=String(b.provider||"signalwire").toLowerCase();if(!id)return res.status(400).json({error:"Missing call ID."});
 try{
   if(provider==="bandwidth"){
      if(!/^c-[0-9a-f-]{36}$/i.test(id))return res.status(400).json({error:"Invalid Bandwidth call ID."});
      await bw.api("/calls/"+encodeURIComponent(id),"POST",{state:"completed"});
      return res.status(200).json({success:true});
    }
    if(provider==="telnyx"){
     const key=process.env.TELNYX_API_KEY;if(!key)return res.status(503).json({error:"TELNYX_API_KEY is not configured."});
     const {r,d}=await jsonFetch("https://api.telnyx.com/v2/calls/"+encodeURIComponent(id)+"/actions/hangup",{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:"{}"});
     if(!r.ok){const m=d?.errors?.[0]?.detail||d?.errors?.[0]?.title||d?.message||"Telnyx hangup failed.";return res.status(r.status).json({error:String(m)})}
     return res.status(200).json({success:true});
   }
   const {r,data}=await sw({command:"calling.end",id,params:{reason:"hangup"}});
   if(!r.ok){const m=data?.message||data?.error?.message||data?.error||"SignalWire hangup failed.";return res.status(r.status).json({error:String(m)})}
   return res.status(200).json({success:true});
 }catch(e){return res.status(502).json({error:e.message||"Could not end call."})}
};