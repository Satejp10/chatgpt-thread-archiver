/* TEMPORARY DIAGNOSTIC — which Claude request names an incognito chat?
   Paste on a fresh claude.ai/new?incognito page BEFORE sending a message, then send one.
   The report prints 45 s after pasting. Route SHAPES only: every id-like segment is
   replaced by <id>, query values are dropped. No ids, text, tokens or cookies. */
(()=>{const ID=/^[0-9a-f-]{16,}$|^[A-Za-z0-9_-]{20,}$/i,seen=new Map(),t0=performance.now();
const shape=u=>{let p;try{p=new URL(u,location.origin)}catch{return null}if(p.origin!==location.origin||!p.pathname.startsWith('/api/'))return null;
return p.pathname.split('/').map(s=>ID.test(s)||s.length>40?'<id>':s).join('/')+(p.search?' ?'+[...p.searchParams.keys()].join(','):'')};
const add=e=>{const s=shape(e.name);if(s)seen.set(s,(seen.get(s)??0)+1)};
const ob=new PerformanceObserver(l=>l.getEntries().forEach(e=>{if(e.startTime>=t0)add(e)}));ob.observe({type:'resource',buffered:true});
console.log('Probe watching. Send one message now; the report prints in 45 s.');
setTimeout(async()=>{ob.disconnect();const page=location.pathname.split('/').map(s=>ID.test(s)?'<id>':s).join('/');
const out=['=== CLAUDE INCOGNITO ROUTE PROBE ===','page now: '+page+' ?'+[...new URLSearchParams(location.search).keys()].join(','),
'timing buffer entries: '+performance.getEntriesByType('resource').length,'api requests after paste:',...[...seen].sort().map(([k,n])=>`  ${n}x ${k}`)].join('\n');
console.log(out);try{await navigator.clipboard.writeText(out);console.log('(copied)')}catch{console.log('(clipboard blocked — select the text above)')}},45000)})();
