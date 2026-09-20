// 通用 CDP 求值：node _eval_cdp.js <port> <expression文件或->  （表达式从 stdin 读）
const http = require('http'); const crypto = require('crypto');
function gj(u){return new Promise((res,rej)=>{http.get(u,(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})}).on('error',rej)})}
class W {
  constructor(u){this.url=u}
  connect(){return new Promise((res,rej)=>{
    const key=Buffer.from(crypto.randomBytes(16)).toString('base64');const u=new URL(this.url);
    const q=http.request({host:u.hostname,port:u.port,path:u.pathname,headers:{Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Key':key,'Sec-WebSocket-Version':'13'}});
    q.on('upgrade',(r,s)=>{this.s=s;this.buf=Buffer.alloc(0);this.id=0;this.pend=new Map();this.ls=[];
      s.on('data',(c)=>this._d(c));s.on('error',()=>{});res(this)});q.on('error',rej);q.end()})}
  _d(c){this.buf=Buffer.concat([this.buf,c]);
    for(;;){if(this.buf.length<2)return;const b0=this.buf[0],b1=this.buf[1],op=b0&0x0f;let l=b1&0x7f,o=2;
      if(l===126){if(this.buf.length<4)return;l=this.buf.readUInt16BE(2);o=4}else if(l===127){if(this.buf.length<10)return;l=Number(this.buf.readBigUInt64BE(2));o=10}
      if(this.buf.length<o+l)return;const p=this.buf.subarray(o,o+l);this.buf=this.buf.subarray(o+l);
      if(op===0x8){this.closed=true;return}if(op===0x9){this._w(0xA,p);continue}if(op===0xA)continue;
      let m;try{m=JSON.parse(p.toString('utf8'))}catch(_){continue}
      if(m.id&&this.pend.has(m.id)){const{resolve,reject}=this.pend.get(m.id);this.pend.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result)}
      else this.ls.forEach(f=>{try{f(m)}catch(_){}})}}
  _w(op,p){const mask=crypto.randomBytes(4),len=p.length;let h;
    if(len<126)h=Buffer.from([0x80|op,0x80|len]);else{h=Buffer.alloc(4);h[0]=0x80|op;h[1]=0x80|126;h.writeUInt16BE(len,2)}
    const mk=Buffer.allocUnsafe(len);for(let i=0;i<len;i++)mk[i]=p[i]^mask[i&3];
    try{this.s.write(Buffer.concat([h,mask,mk]))}catch(_){}}
  send(o){const id=++this.id;return new Promise((resolve,reject)=>{this.pend.set(id,{resolve,reject});this._w(0x1,Buffer.from(JSON.stringify({...o,id})));setTimeout(()=>{if(this.pend.has(id)){this.pend.delete(id);reject(new Error('CDP_TIMEOUT'))}},60000)})}
}
(async()=>{
  const port=process.argv[2]||'9223';
  const expr=process.argv[3]==='-'?require('fs').readFileSync(0,'utf8'):process.argv[3];
  const ts=await gj('http://127.0.0.1:'+port+'/json');
  const pg=ts.find(t=>t.type==='page'&&/index\.html$/.test(t.url));
  if(!pg){console.error('MAIN_WINDOW_NOT_FOUND');process.exit(2)}
  const ws=new W(pg.webSocketDebuggerUrl);await ws.connect();
  await ws.send({method:'Runtime.enable'});
  ws.ls.push((m)=>{if(m.method==='Runtime.exceptionThrown'){const d=m.params.exceptionDetails;console.error('[EXC]',(d.exception||{}).description||d.text)}});
  const r=await ws.send({method:'Runtime.evaluate',params:{expression:expr,returnByValue:true,awaitPromise:true}});
  if(r.exceptionDetails)console.log('EXCEPTION:',(r.exceptionDetails.exception||{}).description||r.exceptionDetails.text);
  else console.log(JSON.stringify(r.result&&r.result.value));
  try{ws.s.end()}catch(_){}
  process.exit(0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(3)});
