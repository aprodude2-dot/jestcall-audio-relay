const crypto=require("crypto");
const {put}=require("@vercel/blob");
const {normalizePhone}=require("./_signalwire");
function pathFor(phone){return "blocked/"+crypto.createHash("sha256").update("jestcall-block:"+phone).digest("hex")+".json"}
module.exports=async function(req,res){
  res.setHeader("Cache-Control","no-store");
  if(req.method!=="POST")return res.status(405).json({error:"POST required."});
  const phone=normalizePhone((req.body||{}).phone);
  if(!phone)return res.status(400).json({error:"Enter a valid U.S. phone number."});
  try{
    await put(pathFor(phone),JSON.stringify({blocked:true,blocked_at:new Date().toISOString()}),{access:"private",allowOverwrite:true,contentType:"application/json"});
    return res.status(200).json({success:true,message:"This number has been added to the Zilos Tools do-not-call list."});
  }catch(e){
    return res.status(500).json({error:"Could not save the block request."});
  }
};