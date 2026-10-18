import {readFileSync,existsSync} from 'node:fs';
const lock=JSON.parse(readFileSync('package-lock.json'));
// Reviewed SPDX expressions. MPL's file-level source requirements are compatible
// with AGPLv3; keep upstream files/notices, and publish exact source references.
const approved=new Set(['MIT','ISC','MIT-0','0BSD','BSD-2-Clause','BSD-3-Clause','Apache-2.0','MPL-2.0','CC-BY-4.0','MIT AND ISC']);
let checked=0;
for(const [directory,entry] of Object.entries(lock.packages)) {
  if(!directory)continue;
  // Lockfile covers optional binaries for other CPU/OS platforms too.
  const license=entry.license ?? (existsSync(`${directory}/package.json`) ? JSON.parse(readFileSync(`${directory}/package.json`)).license : undefined);
  if(!approved.has(license)) throw Error(`Review license for ${directory}: ${license ?? 'missing'}`);
  checked++;
}
console.log(`${checked} locked dependencies have reviewed AGPLv3-compatible license expressions.`);
