import net from 'node:net';
import https from 'node:https';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
export async function proxies(){
  const reads=socket=>async n=>{while(socket.readableLength<n){await new Promise((resolve,reject)=>{const onClose=()=>{socket.off('readable',onRead);reject(new Error('connection closed'));};const onRead=()=>{socket.off('close',onClose);resolve();};socket.once('readable',onRead);socket.once('close',onClose);});}return socket.read(n);};
  const connect=(host,port)=>new Promise((resolve,reject)=>{const socket=net.connect({host,port},()=>resolve(socket));socket.once('error',reject);});
  const tunnel=(socket,remote,label,head=Buffer.alloc(0))=>{
    let buffer=head;let forwarded=false;
    const send=chunk=>{buffer=Buffer.concat([buffer,chunk]);const at=buffer.indexOf('\r\n\r\n');if(at<0){if(buffer.length>16384)socket.destroy();return;}
      socket.off('data',send);const headers=buffer.subarray(0,at).toString();remote.write(headers+'\r\nX-OAS-Fixture-Egress: '+label+'\r\n\r\n');remote.write(buffer.subarray(at+4));forwarded=true;socket.pipe(remote);
    };
    remote.pipe(socket);socket.on('close',()=>remote.destroy());socket.on('data',send);if(buffer.length)send(Buffer.alloc(0));
  };
  const count={socks:0,https:0};
  const socks=net.createServer(async socket=>{
    socket.on('error',()=>{});
    try{
      const read=reads(socket);const header=await read(2);await read(header[1]);socket.write(Buffer.from([5,2]));
      const auth=await read(2),username=(await read(auth[1])).toString(),len=await read(1),password=(await read(len[0])).toString();
      socket.write(Buffer.from([1,username==='sample'&&password==='sample-password'?0:1]));
      if(username!=='sample'||password!=='sample-password')return socket.end();
      const command=await read(4);let host;
      if(command[3]===3){const size=await read(1);host=(await read(size[0])).toString();}
      else if(command[3]===1)host=[...(await read(4))].join('.');
      else throw Error('unsupported address');
      const port=(await read(2)).readUInt16BE();
      if(host!=='host.docker.internal')throw Error('fixture destination only');
      const remote=await connect('127.0.0.1',port);count.socks++;socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));tunnel(socket,remote,'socks');
    }catch{socket.end();}
  });
  const secure=https.createServer({key:readFileSync(resolve(process.env.OAS_PROXY_FIXTURE_DIR||'artifacts','proxy-key.pem')),cert:readFileSync(resolve(process.env.OAS_PROXY_FIXTURE_DIR||'artifacts','proxy-cert.pem'))});
  secure.on('tlsClientError',error=>{console.error('Fixture TLS handshake:',error.message)});
  secure.on('connect',async(req,socket,head)=>{
    socket.on('error',()=>{});
    try{
      if(req.headers['proxy-authorization']!=='Basic '+Buffer.from('sample:sample-password').toString('base64')){socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');return;}
      const[host,port]=req.url.split(':');if(host!=='host.docker.internal')throw Error('fixture destination only');
      const remote=await connect('127.0.0.1',Number(port));count.https++;socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');tunnel(socket,remote,'https',head);
    }catch{socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');}
  });
  await Promise.all([new Promise(r=>socks.listen(18781,'0.0.0.0',r)),new Promise(r=>secure.listen(18782,'0.0.0.0',r))]);
  return {count,close(){socks.close();secure.close();}};
}
