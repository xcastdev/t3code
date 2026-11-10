export const fakeOmpCliSource = `
import net from "node:net";
import fs from "node:fs";
import readline from "node:readline";
const configPath=process.env.T3_OMP_RUNTIME_CONFIG;
const config=JSON.parse(fs.readFileSync(configPath,"utf8"));
const credential=JSON.parse(fs.readFileSync(config.credentialPath,"utf8"));
const channel=net.createConnection(credential.path);
let inputBuffer="";
channel.on("data",chunk=>{inputBuffer+=chunk;for(;;){const i=inputBuffer.indexOf("\\n");if(i<0)break;const f=JSON.parse(inputBuffer.slice(0,i));inputBuffer=inputBuffer.slice(i+1);if(f.type==="cancel")process.exit(0);}});
channel.on("error",()=>process.exit(2));
const output=frame=>process.stdout.write(JSON.stringify(frame)+"\\n");
output({type:"extension_ui_request",id:"startup",method:"select",options:["yes"]});
const rl=readline.createInterface({input:process.stdin,terminal:false});
rl.on("line",line=>{
 const c=JSON.parse(line);
 if(c.type==="extension_ui_response"){
   if(c.id!=="startup")process.exit(4);
   channel.write(JSON.stringify({secret:credential.secret})+"\\n");
   channel.write(JSON.stringify({v:1,type:"ready",providerSession:config.providerSession,epoch:"fake-epoch",id:"ready",payload:{recipe:config.policyManifest.recipe,guards:config.policyManifest.guards,mode:config.mode}})+"\\n");
   output({type:"ready",protocolVersion:1,supportedProtocolVersions:[1,2],maxFrameBytes:1048576,maxReassembledFrameBytes:67108864});return;
 }
 const data=c.type==="negotiate_protocol"?{protocolVersion:2}:c.type==="set_event_filter"?{events:null,messageUpdates:"delta"}:{pid:process.pid,configPath,credentialPath:config.credentialPath,args:process.argv.slice(2),providerKey:process.env.TEST_PROVIDER_KEY,cleared:process.env.T3CODE_TOKEN===undefined};
 output({type:"response",id:c.id,command:c.type,success:true,data});
});
rl.on("close",()=>process.exit(0));
`;
