// Executed as root inside a network-isolated disposable application image.
// Only the local controlled TLS SMTP server receives fixture mail.
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import {readFileSync,writeFileSync} from 'node:fs';
const modulePath='/app/dist/server/server/notifications.js';
const {smtpDelivery}=await import(modulePath);
let stall=false,accepted=0;const sockets=new Set<net.Socket>();
const context=tls.createSecureContext({key:readFileSync('/fixtures/key.pem'),cert:readFileSync('/fixtures/cert.pem')});
const server=net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
  if(stall)return;
  socket.write('220 fixture ESMTP\r\n');
  let buffer='',data=false;
  const attach=(stream:net.Socket)=>{
    stream.on('error',()=>{});
    stream.on('data',chunk=>{
      buffer+=String(chunk);
      while(buffer.includes('\r\n')){
        const end=buffer.indexOf('\r\n');const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
        if(data){if(line==='.') {data=false;accepted++;stream.write('250 accepted\r\n');}continue;}
        if(line.startsWith('EHLO'))stream.write(stream instanceof tls.TLSSocket?'250-fixture\r\n250 AUTH PLAIN\r\n':'250-fixture\r\n250 STARTTLS\r\n');
        else if(line==='STARTTLS'){
          stream.write('220 ready\r\n');stream.removeAllListeners('data');buffer='';
          attach(new tls.TLSSocket(stream,{isServer:true,secureContext:context}));return;
        } else if(line.startsWith('AUTH'))stream.write('235 authenticated\r\n');
        else if(line.startsWith('MAIL')||line.startsWith('RCPT'))stream.write('250 ok\r\n');
        else if(line==='DATA'){data=true;stream.write('354 send\r\n');}
        else if(line==='QUIT'){stream.end('221 bye\r\n');}
        else stream.write('250 ok\r\n');
      }
    });
  };attach(socket);
});
await new Promise<void>(r=>server.listen(587,'127.0.0.1',r));
writeFileSync('/tmp/smtp.json',JSON.stringify({host:'localhost',port:587,username:'fixture',password:'fixture-only',from:'fixture@example.test',to:['recipient@example.test']}),{mode:0o600});
process.env.HOSTBOARD_SMTP_CONFIG='/tmp/smtp.json';
try {
  const delivery=smtpDelivery()!;
  await delivery.send({id:1,messageKey:'test-1',subject:'Controlled test',body:'Fixture only'});
  assert.equal(accepted,1);
  stall=true;const controller=new AbortController();
  const began=performance.now();
  const pending=delivery.send({id:2,subject:'Must cancel',body:'Fixture only'},controller.signal);
  const timer=setTimeout(()=>controller.abort(),100);
  await assert.rejects(pending);clearTimeout(timer);
  assert(performance.now()-began<1000,"cancellation must finish before SMTP socket timeout");
  await new Promise(r=>setTimeout(r,100));assert.equal(accepted,1);
  assert.equal(sockets.size,0,'cancellation releases the stalled SMTP socket');
  console.log('PASS: isolated verified STARTTLS/authenticated send and abort releases stalled socket; no real email');
} finally {for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));}
