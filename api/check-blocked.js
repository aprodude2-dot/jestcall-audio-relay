const crypto=require("crypto");
const {list}=require("@vercel/blob");
const {okAccess,normalizePhone}=require("./_signalwire");
function pathFor(phone){return "blocked/"+crypto.createHash("sha256").update("jestcall-block:"+phone).digest("hex")+".json"}
module.exports=async function(req,res){
  res.setHeader("Cache-Control","no-store");
  if(req.method!=="POST")return res.status(405).json({error:"POST required."});
  const b=req.body||{};
  if(!okAccess(b))return res.status(401).json({error:"Incorrect owner access code."});
  const phone=normalizePhone(b.phone);
  if(!phone)return res.status(400).json({error:"Enter a valid U.S. phone number."});
  try{
    const path=pathFor(phone);
    const out=await list({prefix:path,limit:1});
    const blocked=Array.isArray(out.blobs)&&out.blobs.some(x=>x.pathname===path);
    return res.status(200).json({success:true,blocked});
  }catch(e){
    return res.status(500).json({error:"Could not check the do-not-call list."});
  }
};