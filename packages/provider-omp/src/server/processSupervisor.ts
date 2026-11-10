// The live group leader signals its own group; the host never reuses a dead leader's numeric PGID.
export const processSupervisorSource = String.raw`
import {spawn} from 'node:child_process';
import fs from 'node:fs';
const config=JSON.parse(process.env.T3_OMP_SUPERVISOR);
delete process.env.T3_OMP_SUPERVISOR;
if(config.electron===undefined)delete process.env.ELECTRON_RUN_AS_NODE;else process.env.ELECTRON_RUN_AS_NODE=config.electron;
if(config.nodeOptions===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=config.nodeOptions;
const status=fs.createWriteStream('',{fd:3,autoClose:false});
if(process.pid<=1 || process.ppid!==config.parentPid){status.write(JSON.stringify({type:'exit',code:null,signal:null,error:'supervisor runtime must exec directly',stdoutBytes:0})+'\n',()=>process.exit(0));await new Promise(()=>{});}
status.on('error',()=>stop());
const pin=setInterval(()=>{},1073741824);
let stopping=false;
function stop(){
 if(stopping)return;stopping=true;
 setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL');}catch{}},1000);
 try{process.kill(-process.pid,'SIGTERM');}catch{}
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('SIGHUP',stop);
process.on('exit',()=>{process.exitCode=0;});
const input=fs.createReadStream('',{fd:4,autoClose:false});
input.on('data',stop);input.on('end',stop);input.on('error',stop);
let child;
let exitValue;
let stdoutBytes=0;
let stdoutEnded=false;
let finished=false;
let drain;
let outputFailure;
let eofWait;
let exitSent=false;
let writing=false;
const statuses=[];
function emit(value){
 statuses.push({...value,stdoutBytes});
 function flush(){if(writing || !statuses.length)return;writing=true;const next=statuses.shift();process.stdout.write('',()=>status.write(JSON.stringify(next)+'\n',()=>{writing=false;flush();}));}
 flush();
}
function finish(){
 if(finished || (!exitValue && !outputFailure))return;
 finished=true;clearTimeout(drain);clearTimeout(eofWait);
 child?.stdout?.pause();child?.stdout?.unpipe(process.stdout);
 if(exitValue){exitSent=true;emit(exitValue);}else emit({type:outputFailure,code:null,signal:null});
}
function exited(value){
 if(exitValue)return;exitValue=value;
 if(finished){if(!exitSent){exitSent=true;emit(exitValue);}return;}
 if(stdoutEnded)finish();else drain=setTimeout(finish,500);
}
try{
 child=spawn(config.command,config.args,{cwd:config.cwd,env:process.env,shell:config.shell,detached:false,stdio:['pipe','pipe','pipe']});
 child.stdin.on('error',()=>{});
 process.stdin.on('error',()=>{});
 process.stdin.pipe(child.stdin);
 child.stdout.on('data',bytes=>{stdoutBytes+=bytes.length;});
 function outputClosed(type){if(outputFailure)return;stdoutEnded=true;outputFailure=type;if(exitValue)finish();else eofWait=setTimeout(finish,250);}
 child.stdout.on('end',()=>outputClosed('stdout_end'));
 child.stdout.on('error',()=>outputClosed('stdout_error'));
 child.stdout.on('close',()=>outputClosed('stdout_end'));
 child.stdout.pipe(process.stdout,{end:false});
 child.stderr.pipe(process.stderr,{end:false});
 child.once('error',error=>exited({type:'exit',code:null,signal:null,error:typeof error.code==='string'?error.code:'spawn failed'}));
 child.once('exit',(code,signal)=>exited({type:'exit',code,signal}));
}catch(error){exited({type:'exit',code:null,signal:null,error:'spawn failed'});}
process.on('uncaughtException',()=>{exited({type:'exit',code:null,signal:null,error:'supervisor failure'});});
process.on('unhandledRejection',()=>{exited({type:'exit',code:null,signal:null,error:'supervisor failure'});});
`;
