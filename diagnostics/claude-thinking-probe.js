/* TEMPORARY DIAGNOSTIC — compact console probe for Claude thinking and tool blocks.
   Same privacy boundary as the attachment probes: field names, value types, string
   LENGTHS and redacted route shapes only. Reasoning text, tool inputs, tool outputs,
   file names, ids and URLs are never printed. Delete once the shape is known. */
(async()=>{const D=6,MAXPER=2,T=/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/,U=/url|href|src|link|endpoint/i,
N=/name|title|caption|label|filename|text|thinking|content|input|output|summary|query|command|description|prompt|message|body|result|arg/i,
I=/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$|^[0-9a-f]{16,}$/i;
const o=v=>!!v&&typeof v=='object'&&!Array.isArray(v);
const rs=s=>!s?s:s.length>24||/^[0-9a-f-]{16,}$/i.test(s)?`<id:${s.length}>`:/^\d+$/.test(s)?'<num>':/^[a-z0-9_.-]+$/i.test(s)?s:`<seg:${s.length}>`;
const R=u=>{let p;try{p=new URL(String(u),location.origin)}catch{return`<unparseable,len=${String(u).length}>`}
return`${p.origin===location.origin?'(same-origin)':`(cross-origin,len=${p.hostname.length})`} ${p.pathname.split('/').map(rs).join('/')}`};
// A tool NAME is structural (which tool ran) and safe; everything a tool was given or
// returned is the user's content and is reported by length only.
const SAFE_NAME_KEYS=new Set(['type','name','file_variant','file_kind','stop_reason','sender','status','state','role','tool_name','subtype','integration_name','display_name']);
const d=(k,v)=>{if(v===null)return'null';if(Array.isArray(v))return`array[${v.length}]`;if(o(v))return`object{${Object.keys(v).length}}`;
const t=typeof v;if(t=='boolean'||t=='number')return`${t}:${v}`;if(t!='string')return t;const s=v.trim();
if(U.test(k)||/^https?:\/\//i.test(s)||s.startsWith('/api/'))return`URL -> ${R(s)}`;
if(SAFE_NAME_KEYS.has(k)&&T.test(s))return`string:"${s}"`;
if(I.test(s)||/(^|_)(id|uuid)$/i.test(k))return`<id:${s.length}>`;
if(N.test(k))return`string(len=${v.length})`;
return T.test(s)&&!/\s/.test(s)?`string:"${s}"`:`string(len=${v.length})`};
const S=(x,l,a,n=0)=>{if(!o(x))return;if(n>D)return a.push(`${'  '.repeat(n)}${l}: <depth limit>`);a.push(`${'  '.repeat(n)}${l}:`);
for(const k of Object.keys(x).sort()){const v=x[k];if(o(v)){S(v,k,a,n+1);continue}
if(Array.isArray(v)&&v.some(o)){a.push(`${'  '.repeat(n+1)}${k} = array[${v.length}]`);v.slice(0,MAXPER).forEach((e,i)=>S(e,`${k}[${i}]`,a,n+2));continue}
if(Array.isArray(v)){a.push(`${'  '.repeat(n+1)}${k} = array[${v.length}] of ${v.length?typeof v[0]:'?'}`);continue}
a.push(`${'  '.repeat(n+1)}${k} = ${d(k,v)}`)}};
const a=[];try{const og=document.cookie.split('; ').find(c=>c.startsWith('lastActiveOrg='));if(!og)throw new Error('no lastActiveOrg cookie');
const id=location.pathname.split('/').filter(Boolean).reverse().find(p=>/^[A-Za-z0-9_-]{16,120}$/.test(p));if(!id)throw new Error('no conversation id in URL');
const r=await fetch(`/api/organizations/${encodeURIComponent(decodeURIComponent(og.slice(14)))}/chat_conversations/${encodeURIComponent(id)}?tree=true&rendering_mode=messages&render_all_tools=true`,{credentials:'same-origin',headers:{Accept:'application/json'},cache:'no-store'});
if(!r.ok)throw new Error('conversation HTTP '+r.status);const c=await r.json();const ms=Array.isArray(c?.chat_messages)?c.chat_messages:[];
const census=new Map(),seen=new Map(),order=[];
for(const m of ms){if(!o(m))continue;const sender=String(m.sender??'?');
for(const b of Array.isArray(m.content)?m.content:[]){
const ty=typeof b=='string'?'string':String(b?.type??'object-untyped');
const key=`${sender}/${ty}`;census.set(key,(census.get(key)??0)+1);
if(ty==='text'||typeof b=='string')continue;
const n=seen.get(ty)??0;if(n>=MAXPER)continue;seen.set(ty,n+1);order.push({sender,ty,b,n})}}
a.push('=== CONTENT BLOCK CENSUS (sender/type = count) ===');
for(const[k,n]of[...census].sort())a.push(`  ${k} = ${n}`);
a.push('','=== NON-TEXT BLOCK SHAPES ===');
if(!order.length)a.push('  (none — this conversation has no thinking or tool blocks; run it on one that does)');
for(const{sender,ty,b,n}of order){a.push('',`--- ${sender} / ${ty} #${n+1} ---`);S(b,ty,a,1)}
}catch(e){a.push('PROBE FAILED: '+e.message)}
const out=a.join('\n');console.log(out);try{await navigator.clipboard?.writeText(out);console.log('(copied)')}catch{console.log('(clipboard blocked — select the text above)')}})();
