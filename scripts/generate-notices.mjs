import fs from 'node:fs';
const lock=JSON.parse(fs.readFileSync('package-lock.json'));
let text='Hostboard third-party notices\n\nGenerated from the locked npm dependency tree. License texts and upstream\ncopyright notices are reproduced below; original licenses remain in force.\nOptional platform packages not installed here are listed in package-lock.json.\n\n';
for(const [p,entry] of Object.entries(lock.packages)) {
 if(!p||!fs.existsSync(p+'/package.json'))continue;
 const pkg=JSON.parse(fs.readFileSync(p+'/package.json'));
 text+=`\n===== ${pkg.name} ${pkg.version} (${pkg.license}) =====\n`;
 text+=`Source: ${typeof pkg.repository==='string'?pkg.repository:pkg.repository?.url ?? entry.resolved}\n`;
 const files=fs.readdirSync(p).filter(f=>/^(licen[sc]e|copying|notice)(\.|$)/i.test(f)&&fs.statSync(p+'/'+f).isFile());
 for(const f of files)text+='\n'+fs.readFileSync(p+'/'+f,'utf8')+'\n';
 if(!files.length)text+=`Upstream package: ${entry.resolved}\n`;
}
fs.writeFileSync('THIRD_PARTY_NOTICES.txt',text);
