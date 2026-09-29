// Runs only inside the user's own Sandbox. Raw CLI output and credentials never leave it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import { appCards } from './apps.mjs';
const exec=promisify(execFile);
const env={...process.env};
if(!env.LIZARD_HOME && await access("/workspace/.lizard/config.json").then(()=>true,()=>false))env.LIZARD_HOME="/workspace";
async function cli(args) {
  const {stdout}=await exec('lizard',[...args,'--json'],{cwd:'/workspace',timeout:8000,maxBuffer:4*1024*1024,env});
  return JSON.parse(stdout);
}
async function collect() {
  let who;
  try {who=await cli(['whoami']);} catch(e){return {state:e.code===2?'connect':'unavailable',items:[],partial:true};}
  if(typeof who.id!=='string')return {state:'unavailable',items:[],partial:true};
  let projects;
  try {projects=await cli(['project','list']);}catch{return {state:'unavailable',items:[],partial:true};}
  if(!Array.isArray(projects))return {state:'unavailable',items:[],partial:true};
  let metadata=[];
  try {const text=await readFile('/workspace/.telegram-codex/apps.json','utf8');if(text.length<=65536){const parsed=JSON.parse(text);if(Array.isArray(parsed))metadata=parsed.slice(0,200);}}catch{}
  const list=projects.slice(0,20),items=[];let index=0,partial=projects.length>list.length;
  await Promise.all(Array.from({length:Math.min(4,list.length)},async()=>{
    while(index<list.length){const p=list[index++];if(typeof p.id!=='string')continue;
      try {const result=await cli(['ps','--project',p.id]);items.push(...appCards(p,result.apps,who.id,metadata));}catch{partial=true;}
    }
  }));
  return {state:'connected',items,partial,updatedAt:new Date().toISOString()};
}
try {console.log(JSON.stringify(await collect()));}catch{console.log(JSON.stringify({state:'unavailable',items:[],partial:true}));}
