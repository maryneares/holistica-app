// Run only in the build checkout. Old GitHub uploads may retain .js files;
// Netlify gives those precedence over the corrected .mts entrypoints.
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const functions=path.join(root,'netlify/functions');
for(const name of ['stripe-webhook','claim-pending-subscription','send-account-email','send-lifecycle-emails','send-upsell-emails','crm-send-scheduled-campaigns','expire-transformation']){
  if(!fs.existsSync(path.join(functions,name+'.mts')))throw new Error('Missing corrected function: '+name);
  const old=path.join(functions,name+'.js');
  if(fs.existsSync(old))fs.unlinkSync(old);
}
// Publish static assets only, never function source, SQL or tests.
const out=path.join(root,'public');fs.mkdirSync(out,{recursive:true});
for(const entry of fs.readdirSync(root,{withFileTypes:true})){
  if(entry.isFile() && (/\.(html|png|jpe?g|svg|ico|webp|apk|css)$/i.test(entry.name)||['sw.js','manifest.json','_headers','_redirects'].includes(entry.name)))
    fs.copyFileSync(path.join(root,entry.name),path.join(out,entry.name));
}
const wellKnown=path.join(root,'.well-known');
if(fs.existsSync(wellKnown))fs.cpSync(wellKnown,path.join(out,'.well-known'),{recursive:true});
if(!fs.existsSync(path.join(out,'index.html')))throw new Error('Missing application index');
