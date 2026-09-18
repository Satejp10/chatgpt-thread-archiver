/* TEMPORARY DIAGNOSTIC — compact console probe. Same privacy boundary as the other two:
   prints field names, value types and redacted route shapes only. Short enough that a
   browser console paste does not truncate it, which is what defeated the long version. */
(async()=>{const M=10,D=5,T=/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/,U=/url|href|src|link|path|endpoint/i,N=/name|title|caption|text|label|filename/i,I=/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$|^[0-9a-f]{16,}$/i;
const o=v=>!!v&&typeof v=='object'&&!Array.isArray(v);
const rs=s=>!s?s:s.length>24||/^[0-9a-f-]{16,}$/i.test(s)||(/\d/.test(s)&&/[a-z]/i.test(s)&&s.length>12)?`<id:${s.length}>`:/^\d+$/.test(s)?'<num>':/^[a-z0-9_.-]+$/i.test(s)?s:`<seg:${s.length}>`;
const R=u=>{let p;try{p=new URL(String(u),location.origin)}catch{return`<unparseable,len=${String(u).length}>`}
const q=[...p.searchParams.keys()].map(n=>T.test(n)?n:`<param:${n.length}>`);
return`${p.origin===location.origin?'(same-origin)':`(cross-origin host,len=${p.hostname.length})`} ${p.pathname.split('/').map(rs).join('/')}${q.length?` ?${q.join('&')}=<redacted>`:''}`};
const d=(k,v)=>{if(v===null)return'null';if(Array.isArray(v))return`array[${v.length}]`;if(o(v))return`object{${Object.keys(v).length}}`;const t=typeof v;if(t=='boolean'||t=='number')return`${t}:${v}`;if(t!='string')return t;const s=v.trim();
if(U.test(k)||/^https?:\/\//i.test(s)||s.startsWith('/api/'))return`URL -> ${R(s)}`;
if(/^[a-z]+\/[a-z0-9.+-]+$/i.test(s))return`mime:"${s}"`;if(N.test(k))return`string(len=${v.length})`;if(I.test(s))return`<id:${s.length}>`;
return T.test(s)&&!/\s/.test(s)?`string:"${s}"`:`string(len=${v.length})`};
const S=(x,l,a,n=0)=>{if(!o(x))return;if(n>D)return a.push(`${'  '.repeat(n)}${l}: <depth limit>`);a.push(`${'  '.repeat(n)}${l}:`);
for(const k of Object.keys(x).sort()){const v=x[k];if(o(v)){S(v,k,a,n+1);continue}
if(Array.isArray(v)&&v.some(o)){a.push(`${'  '.repeat(n+1)}${k} = array[${v.length}]`);v.slice(0,3).forEach((e,i)=>S(e,`${k}[${i}]`,a,n+2));continue}
a.push(`${'  '.repeat(n+1)}${k} = ${d(k,v)}`)}};
const C=(v,f,n=0)=>{if(n>D)return;if(typeof v=='string'){const s=v.trim();if(/^https?:\/\//i.test(s)||s.startsWith('/api/'))f.add(s);return}
if(Array.isArray(v))return v.forEach(e=>C(e,f,n+1));if(o(v))Object.values(v).forEach(e=>C(e,f,n+1))};
const a=[];try{const og=document.cookie.split('; ').find(c=>c.startsWith('lastActiveOrg='));if(!og)throw new Error('no lastActiveOrg cookie');
const id=location.pathname.split('/').filter(Boolean).reverse().find(p=>/^[A-Za-z0-9_-]{16,120}$/.test(p));if(!id)throw new Error('no conversation id in URL');
const r=await fetch(`/api/organizations/${encodeURIComponent(decodeURIComponent(og.slice(14)))}/chat_conversations/${encodeURIComponent(id)}?tree=true&rendering_mode=messages&render_all_tools=true`,{credentials:'same-origin',headers:{Accept:'application/json'},cache:'no-store'});
if(!r.ok)throw new Error('conversation HTTP '+r.status);const c=await r.json();const ms=Array.isArray(c?.chat_messages)?c.chat_messages:[];
const bt=new Map(),car=[],mk=new Set();
for(const m of ms){if(!o(m))continue;for(const k of Object.keys(m))mk.add(k);
for(const b of Array.isArray(m.content)?m.content:[]){const l=`${m.sender}/${typeof b=='string'?'string':b?.type??'object-untyped'}`;bt.set(l,(bt.get(l)??0)+1)}
for(const k of['files','attachments','files_v2','sync_sources']){const L=m[k];if(Array.isArray(L)&&L.length&&car.length<M)car.push({s:m.sender,k,L})}}
a.push('=== CONTENT BLOCK CENSUS ===');for(const[l,n]of[...bt].sort())a.push(`  ${l} = ${n}`);
a.push('','=== MESSAGE KEYS (union) ===',`  ${[...mk].sort().join(', ')||'(none)'}`,'',`=== ATTACHMENT CARRIERS: ${car.length} ===`);
const us=new Set();car.forEach(({s,k,L},i)=>{a.push('',`--- #${i+1}: ${s}.${k}, ${L.length} ---`);L.slice(0,3).forEach((e,j)=>{S(e,`${k}[${j}]`,a,1);C(e,us)})});
a.push('',`=== REACHABILITY: ${us.size} ===`);
for(const u of[...us].slice(0,M)){a.push(`  ${R(u)}`);try{const x=await fetch(u,{credentials:'same-origin',cache:'no-store'}),t=String(x.headers.get('content-type')??'').split(';')[0].trim().toLowerCase(),n=x.headers.get('content-length');
a.push(`    -> ${x.status} · ${t||'no content-type'} · ${n&&/^\d+$/.test(n)?Math.round(n/1024)+' KB':'unknown size'} · ${t.startsWith('image/')?'IS an image':'NOT an image'}`)}catch(e){a.push(`    -> request failed (${e?.name??'error'})`)}}
if(!us.size)a.push('  (none — no URL-shaped field; report the id-shaped keys above)');
}catch(e){a.push('PROBE FAILED: '+e.message)}
const out=a.join('\n');console.log(out);try{await navigator.clipboard?.writeText(out);console.log('(copied)')}catch{console.log('(clipboard blocked — select the text above)')}})();
