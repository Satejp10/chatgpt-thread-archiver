/* TEMPORARY DIAGNOSTIC — does Claude record which model wrote each reply?
   Paste in the DevTools console on a claude.ai/chat/... page whose prompt was retried
   with different models. It reads the chat twice, the way the exporter asks and the way
   Claude's page asks, and prints field NAMES. A value is printed only when it is a short
   identifier and its field name mentions a model or the value starts with "claude".
   Content and tool inputs are never printed. No text, ids, file names, tokens or cookies. */
(async()=>{const SAFE=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/,MK=/model|engine|generator|variant/i,
SKIP=new Set(['content','text','attachments','files','files_v2','sync_sources']);
const o=v=>!!v&&typeof v=='object'&&!Array.isArray(v);
const kn=k=>/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k)?k:'<key>';
const val=(k,v)=>{const s=typeof v=='string'?v.trim():'';if(s&&SAFE.test(s)&&(MK.test(k)||/^claude/i.test(s)))return`"${s}"`;
return v===null?'null':Array.isArray(v)?`array[${v.length}]`:typeof v=='string'?`string(len=${v.length})`:typeof v};
// Every field outside the reply's content, three levels deep; an array of objects by its first element.
const walk=(x,p,out,n=0)=>{for(const k of Object.keys(x).sort()){if(SKIP.has(k))continue;const v=x[k],q=p?`${p}.${kn(k)}`:kn(k);
if(o(v)&&n<3){walk(v,q,out,n+1);continue}if(Array.isArray(v)&&o(v[0])&&n<3){walk(v[0],`${q}[0]`,out,n+1);continue}out.push(`${q} = ${val(k,v)}`)}};
// Inside content: the names of fields that mention a model, never their values. Tool inputs are skipped.
const inContent=(x,p,out,n=0)=>{if(!x||typeof x!='object'||n>5)return;for(const k of Object.keys(x)){if(k==='input'||k==='text')continue;
const q=Array.isArray(x)?`${p}[]`:`${p}.${kn(k)}`;if(!Array.isArray(x)&&MK.test(k))out.add(q);inContent(x[k],q,out,n+1)}};
const og=document.cookie.split('; ').find(c=>c.startsWith('lastActiveOrg='));
const id=location.pathname.split('/').filter(Boolean).reverse().find(s=>/^[A-Za-z0-9_-]{16,120}$/.test(s));
if(!og||!id)return console.log('Open a claude.ai/chat/... page while signed in, then paste again.');
const base=`/api/organizations/${encodeURIComponent(decodeURIComponent(og.slice(14)))}/chat_conversations/${encodeURIComponent(id)}`;
const out=['=== CLAUDE REPLY MODEL PROBE ==='];
for(const[label,query]of[['exporter','tree=true&rendering_mode=messages&render_all_tools=true'],['page','tree=True&rendering_mode=messages&render_all_tools=true&include_inline_comparison=true&consistency=strong']]){
let r;try{r=await fetch(`${base}?${query}`,{credentials:'same-origin',headers:{Accept:'application/json'},cache:'no-store'})}catch{out.push('',`${label} request: no response`);continue}
if(!r.ok){out.push('',`${label} request: HTTP ${r.status}`);continue}
const c=await r.json(),ms=Array.isArray(c?.chat_messages)?c.chat_messages:[],replies=ms.filter(m=>o(m)&&m.sender==='assistant');
const versions=new Map();for(const m of replies){const k=String(m.parent_message_uuid??'');versions.set(k,(versions.get(k)??0)+1)}
out.push('',`${label} request: HTTP ${r.status}, ${ms.length} messages, ${replies.length} replies, chat model = ${val('model',c?.model)}`);
const names=new Set();
replies.forEach((m,i)=>{const f=[];walk(m,'',f);f.forEach(l=>names.add(l.replace(/ = .*/,'')));const cs=new Set();inContent(m.content,'content',cs);
const shown=f.filter(l=>l.includes(' = "'));
out.push(`  reply ${i+1} (${versions.get(String(m.parent_message_uuid??''))} version(s) of this reply): ${shown.length?shown.join('; '):'no model value'}${cs.size?`; model-named fields in content: ${[...cs].join(', ')}`:''}`)});
out.push(`  field names on replies, outside content: ${[...names].sort().join(', ')||'none'}`,`  chat fields: ${Object.keys(c??{}).filter(k=>k!=='chat_messages').map(kn).sort().join(', ')}`)}
const text=out.join('\n');console.log(text);try{await navigator.clipboard.writeText(text);console.log('(copied)')}catch{console.log('(clipboard blocked — select the text above)')}})();
