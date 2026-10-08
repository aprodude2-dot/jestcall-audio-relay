const crypto=require("crypto");
const BRIDGE_KEY=process.env.BRIDGE_KEY||"";
const RELAY="wss://jestcall-gemini-relay.onrender.com/signalwire";
function sigFor(vals){return crypto.createHmac("sha256",BRIDGE_KEY).update(vals.join("\n")).digest("hex")}
function safeEq(a,b){a=Buffer.from(String(a||""));b=Buffer.from(String(b||""));return a.length===b.length&&crypto.timingSafeEqual(a,b)}
module.exports=async function(req,res){
  res.setHeader("Cache-Control","no-store");
  if(!BRIDGE_KEY)return res.status(503).json({error:"Bridge key not configured."});
  const q=req.query||{};
  const to=String(q.to||"").slice(0,20),name=String(q.name||"friend").slice(0,80),
    scenario=String(q.scenario||"").slice(0,80),detail=String(q.detail||"").slice(0,80),
    voice=String(q.voice||"Puck").slice(0,40),accent=String(q.accent||"American").slice(0,40),
    ai_model=String(q.ai_model||"openai:gpt-5.6-luna").slice(0,80),
    prompt_id=String(q.prompt_id||"").slice(0,40),sig=String(q.sig||"");
  if(!safeEq(sig,sigFor([to,name,scenario,detail,voice,accent,ai_model,prompt_id])))return res.status(401).json({error:"Invalid SWML signature."});
  return res.status(200).json({version:"1.0.0",sections:{main:[
    {answer:{}},
    {connect:{to:"stream:"+RELAY,codec:"PCMU",realtime:true,name:"zilos-tools-gemini",authorization_bearer_token:BRIDGE_KEY,
      custom_parameters:{recipient_name:name,scenario,detail,voice,accent,ai_model,prompt_id,to_number:to}}}
  ]}});
};