import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
export async function fingerprint(root=process.cwd()){
 const files=[];
 async function scan(path){for(const item of await readdir(path,{withFileTypes:true})){if(['node_modules','dist','target','.git','__pycache__'].includes(item.name))continue;const location=resolve(path,item.name);if(item.isDirectory())await scan(location);else if(item.isFile())files.push(location);}}
 for(const name of ['apps','crates','web','deploy','tests','docs/plan1/contracts'])await scan(resolve(root,name));
 for(const name of ['Cargo.toml','Cargo.lock','docs/plan2/cache-matcher.openapi.yaml','AGENTS.md','README.md','.env.example','.gitignore','.dockerignore','web/package.json','web/package-lock.json','web/tsconfig.json','web/vite.config.ts'])files.push(resolve(root,name));
 for(const item of await readdir(resolve(root,'docs/plan1'))){if(item.endsWith('.md'))files.push(resolve(root,'docs/plan1',item));}
 const hash=createHash('sha256');for(const file of [...new Set(files)].sort()){hash.update(relative(root,file).replaceAll('\\','/'));hash.update('\0');hash.update(await readFile(file));hash.update('\0');}return hash.digest('hex');
}
