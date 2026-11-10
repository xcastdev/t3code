export const descendantSource = `
import net from 'node:net';
const socket=net.createConnection(process.argv[2]);
process.on('SIGTERM',()=>socket.write(JSON.stringify({type:'term'})+'\\n'));
socket.on('error',()=>process.exit(0));
socket.on('data',()=>socket.end(()=>process.exit(0)));
process.on('message',message=>{if(message==='stdout-closed')socket.write(JSON.stringify({type:'stdout-closed'})+'\\n');});
process.on('disconnect',()=>socket.write(JSON.stringify({type:'leader-exited'})+'\\n'));
socket.on('connect',()=>{socket.write(JSON.stringify({type:'descendant',pid:process.pid})+'\\n');process.send('ready');});
`;
export const processFixtureSource = `
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
const [descendant,socketPath,variant]=process.argv.slice(2);
const put=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(variant.startsWith('stdout-'))process.on('SIGTERM',()=>process.exit(23));
const makeDescendant=(request)=>{
 const child=spawn(process.execPath,[descendant,socketPath],{stdio:['ignore',variant.startsWith('stdout-')?'ignore':'inherit','ignore','ipc']});
 child.once('message',()=>{
  put({type:'descendant',pid:child.pid});
  if(variant.startsWith('stdout-')){
   process.stdout.write('',()=>{fs.closeSync(1);child.send('stdout-closed');});
  }else if(variant==='final'){
   put({type:'response',id:request.id,command:request.type,success:true,data:{text:'日本語😀\\u2028\\u2029'.repeat(4096)}});
   process.stdout.write(JSON.stringify({type:'agent_end',messages:[{text:'final'}],messageCount:3})+'\\n',()=>process.exit(0));
  }else if(variant==='exit' || variant==='setup')process.stdout.write('',()=>process.exit(0));
 });
};
if(variant==='setup' || variant==='stdout-setup'){process.stdin.resume();makeDescendant();}
else {
 put({type:'ready',protocolVersion:1,supportedProtocolVersions:[1,2],maxFrameBytes:1048576,maxReassembledFrameBytes:67108864});
 readline.createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  if(request.type==='get_state')makeDescendant(request);
  else put({type:'response',id:request.id,command:request.type,success:true,data:request.type==='negotiate_protocol'?{protocolVersion:2}:{messageUpdates:'delta'}});
 });
}
`;
