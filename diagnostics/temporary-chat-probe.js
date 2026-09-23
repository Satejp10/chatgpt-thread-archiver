/* TEMPORARY DIAGNOSTIC — does the exporter's API serve a ChatGPT temporary chat / Claude incognito chat?
   Prints route shape, query parameter NAMES, HTTP status, counts and boolean flags only.
   Never prints ids, message text, tokens, cookies or URLs. Delete once answered. */
(async()=>{const a=[],L=s=>a.push(s),ID=/^[A-Za-z0-9_-]{16,120}$/,u=new URL(location.href),C=u.hostname==='claude.ai';
const red=p=>p.split('/').map(s=>ID.test(s)||s.length>24?`<id:${s.length}>`:s).join('/');
L('=== TEMP CHAT PROBE ===');L('site: '+(C?'Claude':'ChatGPT'));L('page path: '+red(u.pathname));
L('query names: '+([...u.searchParams.keys()].join(', ')||'(none)'));
try{const RE=C?/\/api\/organizations\/[^/]+\/chat_conversations\/([A-Za-z0-9_-]{16,120})(?=[/?]|$)/:/\/backend-api\/conversation\/([A-Za-z0-9_-]{16,120})(?=[/?]|$)/;
const seen=[];for(const e of performance.getEntriesByType('resource')){let p;try{p=new URL(e.name,location.origin)}catch{continue}
if(p.origin!==location.origin)continue;const m=p.pathname.match(RE);if(m&&!seen.includes(m[1]))seen.push(m[1])}
const urlId=u.pathname.split('/').filter(Boolean).reverse().find(s=>ID.test(s))??null;
L('conversation id in page URL: '+(urlId?'yes':'no'));L('conversation ids in page requests: '+seen.length);
if(urlId&&seen.length)L('URL id matches a request id: '+(seen.includes(urlId)?'yes':'no'));
const id=urlId??seen.at(-1);if(!id)throw new Error('no conversation id found — send one message, wait for the reply, run again');
L('id used: '+(urlId?'from URL':'from page requests'));let r;
if(C){const og=document.cookie.split('; ').find(c=>c.startsWith('lastActiveOrg='));if(!og)throw new Error('no lastActiveOrg cookie');
r=await fetch(`/api/organizations/${encodeURIComponent(decodeURIComponent(og.slice(14)))}/chat_conversations/${encodeURIComponent(id)}?tree=true&rendering_mode=messages&render_all_tools=true`,{credentials:'same-origin',headers:{Accept:'application/json'},cache:'no-store'})}
else{const s=await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store'});const t=s.ok?(await s.json())?.accessToken:null;
L('session token available: '+(t?'yes':'no'));if(!t)throw new Error('session HTTP '+s.status);
r=await fetch(`/backend-api/conversation/${encodeURIComponent(id)}`,{credentials:'same-origin',headers:{Accept:'application/json',Authorization:'Bearer '+t},cache:'no-store'})}
L('conversation API status: '+r.status+(r.ok?' (ok)':' (FAILED)'));if(!r.ok)throw new Error('the exporter API did not return this chat');
const c=await r.json();L('messages returned: '+(C?(Array.isArray(c?.chat_messages)?c.chat_messages.length:'none'):(c?.mapping&&typeof c.mapping=='object'?Object.keys(c.mapping).length+' nodes':'none')));
const f=Object.keys(c??{}).filter(k=>/temp|incognito|ephemeral|history|private/i.test(k)&&typeof c[k]=='boolean').sort();
L('privacy flags: '+(f.map(k=>`${k}=${c[k]}`).join(', ')||'(none)'));
}catch(e){L('PROBE STOPPED: '+e.message)}
const out=a.join('\n');console.log(out);try{await navigator.clipboard?.writeText(out);console.log('(copied)')}catch{console.log('(clipboard blocked — select the text above)')}})();
