const crypto=require("crypto");
const {del}=require("@vercel/blob");
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
    await del(pathFor(phone));
    return res.status(200).json({success:true,message:"Number removed from the Zilos Tools do-not-call list."});
  }catch(e){
    return res.status(500).json({error:"Could not remove the number from the do-not-call list."});
  }
};