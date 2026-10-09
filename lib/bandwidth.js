"use strict";
const crypto=require("crypto");
const {normalizePhone}=require("../api/_signalwire");
const account=()=>String(process.env.BANDWIDTH_ACCOUNT_ID||"");
const app=()=>String(process.env.BANDWIDTH_APPLICATION_ID||"");
const number=()=>normalizePhone(process.env.BANDWIDTH_PHONE_NUMBER);
const key=()=>String(process.env.BRIDGE_KEY||"");
const cmp=(a,b)=>{const x=Buffer.from(String(a||"")),y=Buffer.from(String(b||""));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
function sign(kind,...parts){if(!key())throw Error("Bridge key missing");return crypto.createHmac("sha256",key()).update(["zilos-bandwidth-v1",kind,...parts].join("\n")).digest("hex")}
function configured(){return !!(account()&&app()&&number()&&process.env.BANDWIDTH_CLIENT_ID&&process.env.BANDWIDTH_CLIENT_SECRET&&key())}
let cached=null,expires=0;
async function token(){
 if(!process.env.BANDWIDTH_CLIENT_ID||!process.env.BANDWIDTH_CLIENT_SECRET)throw Object.assign(new Error("Save a newly rotated BANDWIDTH_CLIENT_SECRET in Vercel."),{status:503});
 if(cached&&Date.now()<expires)return cached;
 const a=Buffer.from(String(process.env.BANDWIDTH_CLIENT_ID)+":"+String(process.env.BANDWIDTH_CLIENT_SECRET)).toString("base64");
 const r=await fetch("https://api.bandwidth.com/api/v1/oauth2/token",{method:"POST",headers:{authorization:"Basic "+a,"content-type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials"});
 let j={};try{j=await r.json()}catch{}
 if(!r.ok||!j.access_token)throw Object.assign(new Error("Bandwidth OAuth authentication failed (HTTP "+r.status+"). Verify Client Secret and Voice permissions."),{status:503});
 cached=String(j.access_token);expires=Date.now()+Math.max(30,Number(j.expires_in||300)-60)*1000;return cached
}
async function api(path,method,body){
 const t=await token(),r=await fetch("https://voice.bandwidth.com/api/v2/accounts/"+encodeURIComponent(account())+path,{method,headers:{authorization:"Bearer "+t,"content-type":"application/json"},body:body?JSON.stringify(body):undefined});
 const s=await r.text();let d={};try{d=s?JSON.parse(s):{}}catch{d={message:s}}
 if(!r.ok)throw Object.assign(new Error("Bandwidth rejected request (HTTP "+r.status+"): "+String(d.message||d.description||d.error||"Check your Voice API access.").slice(0,250)),{status:r.status});
 return d
}
const answerSignature=(id,to,from,exp)=>sign("answer",id,to,from,String(exp));
const streamSignature=(id,promptId,exp,to)=>sign("stream",id,promptId,String(exp),to);
const xesc=v=>String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
module.exports={account,app,number,cmp,configured,api,answerSignature,streamSignature,xesc};
