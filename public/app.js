/* ============================================================================
   West Paces Sale Book
   ----------------------------------------------------------------------------
   Ported from the single-file artifact build. Every screen, the render loop, the
   colour and verdict system, search, compare, shortlists and the sheets are the
   originals — they went through several rounds with the client and are settled.

   What changed is the storage layer underneath them, and only that. The old build
   read and wrote a localStorage blob on one device; this one reads and writes
   through Store (IndexedDB + an outbox + Supabase), so Conor's marks reach Nick.
   The read functions and the mutators keep their original names and signatures,
   which is why the ~800 lines below them did not have to move.

   Two rules that shipped bugs before and still hold:
     · prompt() and confirm() are never used. All naming and confirmation is
       in-app UI, and destructive actions are two-tap.
     · Colour never carries meaning alone — every marked row also says the word.
   ========================================================================== */

/* ---------- catalog (static, fetched once, precached by the service worker) ---------- */
var D = null, N = 0, BYHIP = {}, BARNS = [];
var SEXNAME = {C:'Colt', F:'Filly', G:'Gelding', R:'Ridgling'};

function initData(json){
  D = json;
  N = D.H.length;
  BYHIP = {};
  for (var i=0;i<N;i++) BYHIP[D.H[i][0]] = i;
  var m = {};
  for (var j=0;j<N;j++){ var b = D.H[j][5]; (m[b] = m[b] || []).push(j); }
  BARNS = Object.keys(m).sort(function(a,b){return (parseInt(a,10)||999)-(parseInt(b,10)||999);})
    .map(function(b){ return {barn:b, idx:m[b]}; });
}

function H(i){
  var r = D.H[i];
  return { i:i, hip:r[0], sex:r[1], sire:D.sires[r[2]], sireIdx:r[2], dam:r[3],
           consignor:D.cons[r[4]], barn:r[5], color:r[6]==null?null:D.colors[r[6]],
           foaled:r[7]?D.months[r[7][0]]+' '+r[7][1]+', 2025':null,
           d1:r[8], d2:r[9], state:r[10]==null?null:D.states[r[10]],
           name:r[11], eng:r[12], printed:(r[13]==null?null:D.printed[r[13]]),
           ses:(r[14]==null?null:D.sessions[r[14]]) };
}

/* ---------- identity ----------
   Notes and verdicts key off user_id now, not a display name typed on a device.
   A name is a label for a row; it is not who wrote it. */
function me(){ return Store.me(); }
function displayName(id){ return Store.displayName(id); }
function firstName(id){ return displayName(id).split(' ')[0]; }
function initials(n){
  return String(n||'?').split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
}
function initialsOf(id){ return initials(displayName(id)); }

/* ---------- reads (all through Store; the UI below never touches storage) ---------- */
function verdicts(hip){ return Store.verdictsFor(hip); }
function myVerdict(hip){ return Store.myVerdict(hip); }
function teamVerdicts(hip){ return Store.teamVerdicts(hip); }
function notesFor(hip){ return Store.notesFor(hip); }
function allLists(){ return Store.allLists(); }
function canEditNote(n){ return n.user_id === me(); }

function hipsWithVerdict(v, book){
  var mine = Store.myVerdictMap(), out = [];
  for (var i=0;i<N;i++){
    var hp = D.H[i][0];
    if (mine[hp] !== v) continue;
    if (book){ var se = D.H[i][14]; if (se==null || D.sessions[se][1] !== book) continue; }
    out.push(hp);
  }
  return out;
}
function booksWithIn(){
  var m = {};
  hipsWithVerdict('in').forEach(function(hp){
    var se = D.H[BYHIP[hp]][14]; if (se!=null) m[D.sessions[se][1]] = (m[D.sessions[se][1]]||0)+1;
  });
  return Object.keys(m).sort().map(function(b){ return {book:b, n:m[b]}; });
}
function autoList(id){
  if (id === 'auto:in')    return {id:id, name:'Marked In',    owner_id:me(), hips:hipsWithVerdict('in'),    ts:0, auto:true};
  if (id === 'auto:maybe') return {id:id, name:'Marked Maybe', owner_id:me(), hips:hipsWithVerdict('maybe'), ts:0, auto:true};
  if (id.indexOf('auto:book:') === 0){
    var bk = id.slice(10);
    return {id:id, name:'Book '+bk+' — marked In', owner_id:me(), hips:hipsWithVerdict('in', bk), ts:0, auto:true};
  }
  return null;
}
function listById(id){
  if (id && id.indexOf('auto:') === 0) return autoList(id);
  return allLists().filter(function(l){return l.id===id;})[0];
}

/* ---------- writes ----------
   Same names and signatures the UI has always called. Each one now writes to
   IndexedDB and queues for the server; none of them wait on the network. */
function setVerdict(hip, v){ Store.setVerdict(hip, v); }
function addNote(hip, text){ Store.addNote(hip, text); }
function editNote(id, text){ Store.editNote(id, text); }
function deleteNote(id){ Store.deleteNote(id); }
function newList(name){ return { id: Store.newList(name) }; }
function renameList(id, name){ Store.renameList(id, name); }
function deleteList(id){ Store.deleteList(id); }
function addManyToList(id, hips){ hips.forEach(function(h){ Store.addToList(id, h); }); }
function toggleInList(id, hip){ Store.toggleInList(id, hip); }
/* ---------- export (no runtime capabilities: public-shareable) ---------- */
var EXPORT = { name:'', csv:'' };
function openExport(name, csv){ EXPORT = {name:name, csv:csv}; V.sheet = 'export'; render(); }
function copyExport(){
  var ta = document.getElementById('exporttext');
  if (ta){ ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length); }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(EXPORT.csv).then(
      function(){ toast('Copied. Paste it into an email to Perry.'); },
      function(){ toast('Press and hold the text, then Copy.'); });
  } else {
    try { document.execCommand('copy'); toast('Copied. Paste it into an email to Perry.'); }
    catch(e){ toast('Press and hold the text, then Copy.'); }
  }
}

/* ---------- which build is actually running ----------
   Read from the worker controlling this device, not from a constant in this file.
   The two disagree exactly when it matters: a phone showing a fresh page while an old
   worker still serves it the old cached shell. Entirely on-device, so it works offline. */
var BUILD = { version: null, waiting: false, asked: false };

function probeBuild(){
  if (BUILD.asked) return;
  BUILD.asked = true;
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.getRegistration().then(function(reg){
    if (reg && reg.waiting){ BUILD.waiting = true; scheduleRender(); }
  }).catch(function(){});

  var sw = navigator.serviceWorker.controller;
  if (!sw) return;                       // no controller: offline is not armed yet
  var ch = new MessageChannel();
  var done = false;
  var timer = setTimeout(function(){ done = true; }, 1500);   // never let the sheet hang
  ch.port1.onmessage = function(ev){
    if (done) return;
    clearTimeout(timer);
    done = true;
    BUILD.version = ev.data && ev.data.version;
    scheduleRender();
  };
  try { sw.postMessage({ type: 'version' }, [ch.port2]); } catch (e){ clearTimeout(timer); }
}

function buildLine(){
  if (!('serviceWorker' in navigator))
    return '<span style="color:var(--out)">This browser cannot work offline.</span>';
  if (BUILD.waiting)
    return '<span style="color:var(--mb)">Update ready — close the app and reopen it.</span>';
  if (BUILD.version)
    return esc(BUILD.version) + ' · offline ready';
  // No worker is controlling this device, so nothing is cached: it will not open at a barn.
  return '<span style="color:var(--mb)">Not installed yet — open once with signal.</span>';
}

/* ---------- session ---------- */
var SESSION = null;                 // the signed-in Supabase session, or null
var AUTH = { email:'', pw:'', error:null, busy:false };   // pw is in memory only, never stored

/* ---------- view state ---------- */
var V = { screen:'walk', barn:null, hip:null, open:null, q:'', mode:'num', list:null, pick:null, sheet:null, filter:'all', select:null, confirmDel:null, nameFor:null, from:null, compare:null, selCtx:null, editNote:null, confirmNote:null, showPage:false, confirmOut:null };
function go(s, patch){ V.screen = s; if (patch) for (var k in patch) V[k] = patch[k]; window.scrollTo(0,0); render(); }

/* ---------- helpers ---------- */
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function bold(s){ return esc(s).replace(/\b([A-Z][A-Z' \.]{3,})\b(?=,| )/g, '<b>$1</b>'); }
function title(h){ return h.name ? h.name : (h.sire + ' × ' + h.dam); }
function descr(h){
  var bits = [];
  if (h.color) bits.push(h.color + ' ' + (SEXNAME[h.sex]||''));
  else if (SEXNAME[h.sex]) bits.push(SEXNAME[h.sex]);
  return bits.join(' ');
}
var toastT = null;
function toast(msg){
  var el = document.getElementById('toast');
  if (!el){ el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.style.display = 'block';
  clearTimeout(toastT); toastT = setTimeout(function(){ el.style.display = 'none'; }, 3200);
}
function icon(n){
  var p = {
    back:'<path d="M15 18l-6-6 6-6"/>', fwd:'<path d="M9 18l6-6-6-6"/>',
    x:'<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
    check:'<path d="M20 6L9 17l-5-5"/>',
    q:'<path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    search:'<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    barn:'<path d="M3 10l9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9 21v-8h6v8"/>',
    list:'<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    cloud:'<path d="M4 15a4 4 0 0 1 3-6.9A5 5 0 0 1 17 8a3.5 3.5 0 0 1 .5 7H7"/><path d="M12 12v7"/><path d="M9 16l3-3 3 3"/>',
    plus:'<path d="M12 5v14"/><path d="M5 12h14"/>',
    del:'<path d="M20 5H9l-6 7 6 7h11a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z"/><path d="M17 9l-5 6"/><path d="M12 9l5 6"/>',
    doc:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    share:'<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 3v13"/><path d="M8 7l4-4 4 4"/>',
    cols:'<rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/>',
    up:'<path d="M18 15l-6-6-6 6"/>'
  }[n] || '';
  return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+p+'</svg>';
}

/* ---------- row renderers ---------- */
function noteTime(n){
  var d = new Date(n.edited || n.ts);
  return d.toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'})
    + (n.edited ? ' · edited' : '');
}
function noteHTML(n){
  if (V.editNote === n.id){
    var del = V.confirmNote === n.id;
    return '<div style="margin-top:12px;padding:12px;border:1.5px solid var(--ink);border-radius:9px;background:var(--card)">'
      + '<textarea id="ne'+esc(n.id)+'" style="width:100%;min-height:66px;border:none;outline:none;background:none;'
      +   'font:inherit;font-size:13.5px;line-height:1.45;resize:vertical">'+esc(n.text)+'</textarea>'
      + '<div style="display:flex;gap:8px;margin-top:10px">'
      +   '<button class="btn" style="flex:1;height:42px" data-notesave="'+esc(n.id)+'">Save</button>'
      +   '<button class="btn ghost" style="flex:1;height:42px" data-notecancel="1">Cancel</button>'
      +   '<button class="btn ghost" style="height:42px;color:'+(del?'#fff':'var(--out)')+';'
      +     'border-color:var(--out);'+(del?'background:var(--out);':'')+'" data-notedel="'+esc(n.id)+'">'
      +     (del ? 'Tap again' : 'Delete') + '</button>'
      + '</div></div>';
  }
  var mine = canEditNote(n);
  return '<div class="note">'
    + '<div class="av">'+esc(initialsOf(n.user_id))+'</div>'
    + '<div style="flex:1;min-width:0">'
    +   '<div style="font-size:13px;line-height:1.45">'+esc(n.text)+'</div>'
    +   '<div style="font-size:11px;color:var(--mut2);margin-top:2px">'+esc(firstName(n.user_id))+' · '+noteTime(n)+'</div>'
    + '</div>'
    + (mine ? '<button style="align-self:flex-start;padding:4px 8px;font-size:12px;font-weight:600;color:var(--ink2)" '
              + 'data-noteedit="'+esc(n.id)+'">Edit</button>' : '')
    + '</div>';
}

function pedigreeHTML(h, inline){
  var pad = inline ? '14px 0 2px' : '0';
  return '<div style="padding:'+pad+'">'
    + '<div class="ped" style="margin-top:0">'
    +   '<div><div style="font-size:9.5px;letter-spacing:.09em;color:var(--mut2);font-weight:600">SIRE</div>'
    +     '<div style="font-size:14px;font-weight:600">'+esc(h.sire)+'</div></div>'
    +   '<div><div style="font-size:9.5px;letter-spacing:.09em;color:var(--mut2);font-weight:600">DAM</div>'
    +     '<div style="font-size:14px;font-weight:600">'+esc(h.dam)+'</div></div>'
    + '</div>'
    + (D.sire_text[h.sireIdx] ? '<div class="blk"><div class="pgh" style="color:var(--ink)">SIRE RECORD</div>'
        + '<div class="pgt">'+bold(D.sire_text[h.sireIdx])+'</div></div>' : '')
    + (h.d1 ? '<div class="blk"><div class="pgh">1ST DAM</div><div class="pgt">'+bold(h.d1)+'</div></div>' : '')
    + (h.d2 ? '<div class="blk"><div class="pgh">2ND DAM</div><div class="pgt">'+bold(h.d2)+'</div></div>' : '')
    + ((h.eng || h.state) ? '<div class="blk sub" style="font-size:12px">'
        + (h.eng ? 'Engagements listed. ' : '') + (h.state ? 'Foaled in '+esc(h.state)+'.' : '') + '</div>' : '')
    + '</div>';
}

function rowHTML(idx, opts){
  var h = H(idx), v = myVerdict(h.hip), tv = teamVerdicts(h.hip);
  var cls = 'row' + (v ? ' ' + v : '');
  var sub = [];
  if (v) sub.push('<span class="vtag '+v+'">'+v.toUpperCase()+'</span>');
  tv.forEach(function(t){
    sub.push('<span class="vtag '+t.v+'">'+t.v.toUpperCase()+'</span> '+esc(initialsOf(t.user_id)));
  });
  var d = descr(h); if (d) sub.push(esc(d));
  sub.push(esc(h.consignor.replace(/, Agent.*$/,'').slice(0,30)));
  var right;
  if (opts && opts.check)
    right = '<div class="chk'+(opts.checked?' on':'')+'">'+(opts.checked?'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>':'')+'</div>';
  else if (opts && opts.remove != null)
    right = '<span class="score" style="border-style:solid;border-color:var(--line)" data-remove="'+opts.remove+'">'
          + '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#8b857b" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg></span>';
  else right = '<div class="score"><span>—</span></div>';
  return '<button class="'+cls+'" data-row="'+idx+'">'
    + '<div class="edge"></div>'
    + '<div class="hipn">'+h.hip+'</div>'
    + '<div class="meat"><div class="nm">'+esc(title(h))+'</div><div class="sub">'+sub.join(' · ')+'</div></div>'
    + right + '</button>';
}

function expandedHTML(idx){
  var h = H(idx), v = myVerdict(h.hip), ns = notesFor(h.hip);
  var vb = ['out','maybe','in'].map(function(k){
    var lbl = k.charAt(0).toUpperCase()+k.slice(1);
    var ic = k==='out'?icon('x'):(k==='maybe'?icon('q'):icon('check'));
    return '<button class="vb '+k+(v===k?' sel':'')+'" data-v="'+k+'" data-hip="'+h.hip+'">'+ic+'<span>'+lbl+'</span></button>';
  }).join('');
  var notes = ns.map(noteHTML).join('');
  return '<div class="exp">'
    + '<div style="display:flex;align-items:flex-start;gap:12px">'
    +   '<div class="mono" style="font-size:30px;font-weight:600;letter-spacing:-.03em;line-height:1">'+h.hip+'</div>'
    +   '<div style="flex:1;min-width:0"><div style="font-size:18px;font-weight:600;letter-spacing:-.015em">'+esc(title(h))+'</div>'
    +   '<div class="sub" style="margin-top:2px">'+esc([descr(h), h.foaled, h.consignor].filter(Boolean).join(' · '))+'</div></div>'
    +   '<div class="score" style="background:var(--soft)"><span>—</span></div>'
    + '</div>'
    + '<div class="vbtns">'+vb+'</div>'
    + '<div class="noterow"><input class="noteinput" id="ni'+h.hip+'" placeholder="Add a note…" autocomplete="off"><button class="btn" data-note="'+h.hip+'">Save</button></div>'
    + (notes ? '<div style="margin-top:6px">'+notes+'</div>' : '')
    + '<div style="display:flex;gap:8px;margin-top:12px">'
    +   '<button class="btn ghost" style="flex:1'+(V.showPage?';background:var(--ink);color:#fff;border-color:var(--ink)':'')
    +     '" data-page="'+idx+'">'+icon(V.showPage?'up':'doc')+(V.showPage?'Hide page':'Catalog page')+'</button>'
    +   '<button class="btn ghost" style="flex:1" data-add="'+h.hip+'">'+icon('plus')+'Shortlist</button>'
    + '</div>'
    + (V.showPage
        ? '<div id="pagepanel" style="border-top:1px solid var(--line);margin-top:14px">'
          + '<div class="sub" style="font-size:12px;padding-top:12px">'
          +   esc([descr(h), h.foaled, 'Barn '+h.barn].filter(Boolean).join(' · '))
          +   (h.printed ? ' <span style="color:var(--mb)">(prints Barn '+esc(h.printed)+')</span>' : '')
          +   (h.ses ? ' · Book '+esc(h.ses[1])+', '+esc(h.ses[2]) : '')
          + '</div>'
          + pedigreeHTML(h, true) + '</div>'
        : '')
    + '</div>';
}

/* ---------- screens ---------- */
function scrLoading(){
  return '<div class="bar"><h1>West Paces</h1></div>'
    + '<div class="empty">' + (CATALOG_ERROR
        ? 'Could not load the catalog.<br><br>' + esc(CATALOG_ERROR)
          + '<br><br>Once the app has opened with signal, it keeps working without.'
        : 'Loading the catalog…') + '</div>';
}

function scrWalk(){
  var mine = Store.myVerdictMap(), seen=0, inn=0, mb=0;
  for (var hip in mine){ seen++; if (mine[hip]==='in') inn++; else if (mine[hip]==='maybe') mb++; }
  var cards = BARNS.map(function(b){
    var done = b.idx.filter(function(i){ return !!myVerdict(D.H[i][0]); }).length;
    var pct = Math.round(100*done/b.idx.length);
    return '<button class="card'+(done&&done<b.idx.length?' now':'')+'" data-barn="'+esc(b.barn)+'" style="display:block">'
      + '<div style="display:flex;align-items:center;gap:12px;width:100%">'
      + '<div class="meat"><div class="nm" style="font-size:16px">Barn '+esc(b.barn)+'</div>'
      + '<div class="sub">'+b.idx.length+' hips</div></div>'
      + '<div style="text-align:right"><div class="mono" style="font-size:14px;font-weight:600">'+done+' / '+b.idx.length+'</div></div></div>'
      + (done ? '<div class="prog"><i style="width:'+pct+'%"></i></div>' : '')
      + '</button>';
  }).join('');
  return '<div class="bar"><h1>Keeneland September</h1>'
    + '<button class="av" data-account="1" title="Account">'+esc(initialsOf(me()))+'</button></div>'
    + '<div style="background:var(--card);border-bottom:1px solid var(--line);padding:16px 16px 18px;display:flex;gap:22px">'
    + '<div class="stat"><b>'+seen+'</b><span>SEEN</span></div>'
    + '<div class="stat"><b style="color:var(--in)">'+inn+'</b><span>IN</span></div>'
    + '<div class="stat"><b style="color:var(--mb)">'+mb+'</b><span>MAYBE</span></div>'
    + '<div class="stat"><b style="color:#b0aaa0">'+(N-seen)+'</b><span>LEFT</span></div></div>'
    + syncBar()
    + '<div class="sec">BARNS · '+BARNS.length+'</div>' + cards;
}

function scrBarn(){
  var b = BARNS.filter(function(x){return x.barn===V.barn;})[0];
  if (!b) return scrWalk();
  var idx = b.idx.slice();
  if (V.filter !== 'all') idx = idx.filter(function(i){
    var v = myVerdict(D.H[i][0]);
    return V.filter === 'unseen' ? !v : v === V.filter; });
  var done = b.idx.filter(function(i){ return !!myVerdict(D.H[i][0]); }).length;
  var counts = {in:0, maybe:0, out:0, unseen:0};
  b.idx.forEach(function(i){ var v = myVerdict(D.H[i][0]); counts[v||'unseen']++; });
  var chips = [['all','All '+b.idx.length],['unseen','Unseen '+counts.unseen],['in','In '+counts.in],['maybe','Maybe '+counts.maybe],['out','Out '+counts.out]]
    .map(function(c){ return '<button class="pill'+(V.filter===c[0]?' on':'')+'" data-filter="'+c[0]+'">'+c[1]+'</button>'; }).join('');
  var rows = idx.map(function(i){
    return V.open === i ? expandedHTML(i) : rowHTML(i);
  }).join('');
  if (V.select){
    return selectBar()
      + idx.map(function(i){ return rowHTML(i, {check:true, checked: !!V.select[D.H[i][0]]}); }).join('')
      + selectActions();
  }
  return '<div class="bar"><button class="ico" data-go="walk">'+icon('back')+'</button><h1>Barn '+esc(b.barn)+'</h1>'
    + '<div class="mono" style="font-size:13px;font-weight:600;color:var(--ink2)">'+done+' / '+b.idx.length+'</div>'
    + '<button style="font-size:13px;font-weight:600;color:var(--ink)" data-selstart="1">Select</button></div>'
    + '<div class="scroll-x">'+chips+'</div>'
    + (rows || '<div class="empty">Nothing here yet.</div>');
}

function scrHip(){
  var idx = V.hip, h = H(idx), ns = notesFor(h.hip), v = myVerdict(h.hip);
  var vb = ['out','maybe','in'].map(function(k){
    var lbl = k.charAt(0).toUpperCase()+k.slice(1);
    var ic = k==='out'?icon('x'):(k==='maybe'?icon('q'):icon('check'));
    return '<button class="vb '+k+(v===k?' sel':'')+'" data-v="'+k+'" data-hip="'+h.hip+'">'+ic+'<span>'+lbl+'</span></button>';
  }).join('');
  var notes = ns.map(noteHTML).join('') || '<div class="sub" style="margin-top:10px">No notes yet.</div>';
  return '<div class="bar"><button class="ico" data-back="1">'+icon('back')+'</button>'
    + '<h1 class="mono">Hip '+h.hip+'</h1>'
    + '<button class="pill" data-add="'+h.hip+'">'+icon('plus')+'Shortlist</button></div>'
    + '<div class="pg">'
    +  '<div class="pgh">'+esc([descr(h), h.foaled ? 'FOALED '+h.foaled.toUpperCase() : ''].filter(Boolean).join(' · '))+'</div>'
    +  '<div style="font-size:24px;font-weight:600;letter-spacing:-.02em;line-height:1.15">'+esc(title(h))+'</div>'
    +  (h.name ? '<div class="sub" style="font-size:13px;margin-top:3px">'+esc(h.sire+' × '+h.dam)+'</div>' : '')
    +  '<div class="sub" style="font-size:13px;margin-top:4px">Consigned by '+esc(h.consignor)+' · Barn '+esc(h.barn)
    +   (h.printed ? ' <span style="color:var(--mb)">(catalog prints Barn '+esc(h.printed)+')</span>' : '')+'</div>'
    +  (h.ses ? '<div class="sub" style="font-size:13px;margin-top:2px">Book '+esc(h.ses[1])+' · Session '+h.ses[0]+' · sells '+esc(h.ses[2])+'</div>' : '')
    +  pedigreeHTML(h, false)
    + '</div>'
    + '<div style="background:var(--card);border-top:1px solid var(--line);padding:16px 20px 20px;margin-top:12px">'
    +  '<div class="vbtns" style="margin-top:0">'+vb+'</div>'
    +  '<div class="noterow"><input class="noteinput" id="ni'+h.hip+'" placeholder="Add a note…" autocomplete="off"><button class="btn" data-note="'+h.hip+'">Save</button></div>'
    +  '<div class="pgh" style="margin-top:18px">NOTES</div>'+notes
    + '</div>';
}

function searchResults(q){
  q = q.trim().toLowerCase();
  if (!q) return {exact:null, rows:[], total:0};
  var exact = null, pre = [], txt = [];
  if (/^\d+$/.test(q)){
    var n2 = parseInt(q,10);
    if (BYHIP[n2] != null) exact = BYHIP[n2];
    for (var i=0;i<N && pre.length<40;i++){
      var hp = String(D.H[i][0]);
      if (hp !== q && hp.indexOf(q) === 0) pre.push(i);
    }
    return {exact:exact, rows:pre, total:pre.length, kind:'num'};
  }
  var deepCount = 0;
  for (var j=0;j<N;j++){
    var r = D.H[j];
    var hay = (D.sires[r[2]] + ' ' + r[3] + ' ' + (r[11]||'')).toLowerCase();
    if (hay.indexOf(q) >= 0){ pre.push(j); continue; }
    var deep = ((r[8]||'') + ' ' + (r[9]||'') + ' ' + (D.sire_text[r[2]]||'') + ' ' + D.cons[r[4]]).toLowerCase();
    if (deep.indexOf(q) >= 0){ deepCount++; if (txt.length < 400) txt.push(j); }
  }
  var rows = pre.concat(txt);
  return {exact:null, rows:rows.slice(0,60), total:pre.length + deepCount, kind:'txt',
          named:pre.length, deep:deepCount, shown:Math.min(rows.length,60)};
}

function scrSearch(){
  var res = searchResults(V.q);
  var body = '';
  if (!V.q.trim()){
    body = '<div class="empty">Type a hip number, or a sire, dam, consignor or any horse named on a page.<br><br>Searching text looks through every sire record and dam family in the catalog.</div>';
  } else {
    if (res.exact != null) body += '<div class="sec" style="color:var(--ink)">EXACT MATCH</div>' + rowHTML(res.exact);
    if (res.kind === 'num' && res.rows.length) body += '<div class="sec">ALSO STARTING '+esc(V.q)+'</div>';
    if (res.kind === 'txt') body += '<div class="sec">'+res.total+' MATCH'+(res.total===1?'':'ES')
      + (res.deep ? ' · '+res.named+' BY NAME, '+res.deep+' DEEPER IN THE PAGE' : '')
      + (res.total > res.shown ? ' · SHOWING FIRST '+res.shown : '') + '</div>';
    body += res.rows.map(function(i){ return rowHTML(i); }).join('');
    if (!res.rows.length && res.exact == null) body += '<div class="empty">Nothing found for “'+esc(V.q)+'”.</div>';
  }
  var pad = V.mode === 'num'
    ? '<div class="kbd">'+[1,2,3,4,5,6,7,8,9].map(function(d){return '<button class="key" data-k="'+d+'">'+d+'</button>';}).join('')
      + '<button class="key alt" data-k="del">'+icon('del')+'</button><button class="key" data-k="0">0</button>'
      + '<button class="key dark" data-k="abc">ABC</button></div>'
    : '';
  return '<div class="bar"><button class="ico" data-back="1">'+icon('back')+'</button>'
    + '<div class="qbox" style="flex:1;display:flex;align-items:center;gap:9px;height:46px;padding:0 13px;border:1.5px solid var(--ink);border-radius:8px">'
    + icon('search')
    + (V.mode === 'num'
        ? '<span class="mono" style="font-size:18px;font-weight:600;flex:1">'+esc(V.q)
          + (V.q ? '' : '<span style="font-family:inherit;font-size:13.5px;font-weight:400;color:var(--mut)">Hip number — type or tap</span>')
          + '</span><span style="width:2px;height:20px;background:var(--ink)"></span>'
        : '<input id="qin" style="flex:1;width:0;min-width:0;border:none;outline:none;background:none;font-size:15px" value="'+esc(V.q)+'" placeholder="Sire, dam, consignor…" autocomplete="off">')
    + '</div>'
    + (V.mode === 'num' ? '' : '<button class="pill" data-k="123">123</button>')
    + '</div>' + body + pad;
}

function scrLists(){
  var ls = allLists();
  function card(id, name, n, sub, dark){
    return '<button class="card" data-list="'+esc(id)+'"><div class="badge'+(n&&dark?' dark':'')+'">'+n+'</div>'
      + '<div class="meat"><div class="nm" style="font-size:16px">'+esc(name)+'</div>'
      + '<div class="sub">'+esc(sub)+'</div></div>'+icon('fwd')+'</button>';
  }
  var inN = hipsWithVerdict('in').length, mbN = hipsWithVerdict('maybe').length;
  var books = booksWithIn();
  return '<div class="bar"><h1>Shortlists</h1><button class="pill" data-newlist="1">'+icon('plus')+'New</button></div>'
    + syncBar()
    + '<div class="sec">FROM YOUR VERDICTS</div>'
    + card('auto:in', 'Marked In', inN, 'Updates as you mark horses', true)
    + card('auto:maybe', 'Marked Maybe', mbN, 'Updates as you mark horses', false)
    + (books.length ? '<div class="sec">MARKED IN, BY BOOK</div>'
        + books.map(function(b){
            return card('auto:book:'+b.book, 'Book '+b.book, b.n, 'Sells '+bookDays(b.book), true);
          }).join('') : '')
    + '<div class="sec">YOUR SHORTLISTS</div>'
    + (ls.length ? ls.map(function(l){
        return card(l.id, l.name, l.hips.length, (l.owner_id===me()?'Yours':'From '+firstName(l.owner_id))
          + ' · ' + new Date(l.ts).toLocaleDateString([], {month:'short', day:'numeric'}), true);
      }).join('')
      : '<div class="empty" style="padding:24px">None yet. Make one for a list someone else will read —<br>a bid list, or the horses for a second look.</div>');
}
function bookDays(bk){
  var d = D.sessions.filter(function(s){ return s[1] === bk; }).map(function(s){ return s[2]; });
  return d.length > 1 ? d[0] + '–' + d[d.length-1].replace(/^\w+ /,'') : d[0];
}

function scrList(){
  var l = listById(V.list);
  if (!l) return scrLists();
  var rows = l.hips.map(function(hp){ return BYHIP[hp]; }).filter(function(x){return x!=null;});
  if (V.select){
    return selectBar()
      + rows.map(function(i){ return rowHTML(i, {check:true, checked: !!V.select[D.H[i][0]]}); }).join('')
      + selectActions();
  }
  var head = '<div class="bar"><button class="ico" data-go="lists">'+icon('back')+'</button><h1>'+esc(l.name)+'</h1>'
    + (rows.length ? '<button style="font-size:13px;font-weight:600;color:var(--ink)" data-selstart="1">Select</button>' : '')
    + (l.auto ? '' : '<button style="font-size:13px;font-weight:600;color:var(--ink)" data-rename="'+esc(l.id)+'">Rename</button>')
    + '</div>'
    + '<div style="background:var(--card);border-bottom:1px solid var(--line);padding:12px 16px;display:flex;gap:8px">'
    + (l.auto ? '<button class="btn ghost" style="flex:1" data-copylist="'+esc(l.id)+'">'+icon('plus')+'Save as shortlist</button>'
              : '<button class="btn" style="flex:1" data-share="1">'+icon('share')+'Copy link</button>')
    + '<button class="btn ghost" style="flex:1" data-csv="'+esc(l.id)+'">'+icon('doc')+'Export</button></div>';
  if (!rows.length)
    return head + '<div class="empty">'+(l.auto
      ? 'Nothing marked yet.<br>Mark horses In and they appear here.'
      : 'Empty list.<br>Open a horse and tap Shortlist, or use Select in a barn.')+'</div>';
  return head
    + rows.map(function(i){ return rowHTML(i, l.auto ? null : {remove:D.H[i][0]}); }).join('')
    + (l.auto ? '' :
       '<button class="srow" style="border-top:1px solid var(--line);font-weight:600;font-size:14px;color:'
       + (V.confirmDel === l.id ? 'var(--out)' : 'var(--mut)') + '" data-dellist="'+esc(l.id)+'">'
       + (V.confirmDel === l.id ? 'Tap again to delete' : 'Delete this shortlist') + '</button>');
}

function scrCompare(){
  var idx = (V.compare || []).filter(function(i){ return i != null; });
  if (idx.length < 2) return scrWalk();
  var hs = idx.map(H);
  var cols = 'grid-template-columns:repeat('+hs.length+',minmax('+(hs.length>2?'160px':'0')+',1fr))';
  var wide = 'grid-template-columns:repeat('+hs.length+',minmax(240px,1fr))';

  // what is genuinely shared between them — worth flagging, not decorating
  var sameSire = hs.every(function(h){ return h.sire === hs[0].sire; });
  var sameCons = hs.every(function(h){ return h.consignor === hs[0].consignor; });
  var dates = hs.map(function(h){ return h.foaled ? Date.parse(h.foaled) : null; });
  var valid = dates.filter(function(d){ return d; });
  var earliest = valid.length === hs.length ? Math.min.apply(null, valid) : null;

  function band(label, fn, cls, gridStyle){
    return '<div class="cmplab">'+label+'</div>'
      + '<div class="cmpwrap"><div class="cmpgrid" style="'+(gridStyle||cols)+'">'
      + hs.map(function(h,k){ return '<div class="cmpcell">'+fn(h,k)+'</div>'; }).join('')
      + '</div></div>';
  }

  var header = '<div class="cmpwrap"><div class="cmpgrid" style="'+cols+'">'
    + hs.map(function(h){
        var v = myVerdict(h.hip);
        return '<div class="cmpcell hd">'
          + '<div style="display:flex;align-items:center;gap:8px">'
          +   '<span class="mono" style="font-size:22px;font-weight:600;letter-spacing:-.02em">'+h.hip+'</span>'
          +   '<span class="score" style="width:34px;height:34px;border-radius:7px"><span style="font-size:13px">—</span></span>'
          + '</div>'
          + '<div class="cmpv" style="margin-top:2px">'+esc(h.sire)+'</div>'
          + '<div class="cmpv dim">× '+esc(h.dam)+'</div>'
          + '<div style="display:flex;gap:4px;margin-top:7px">'
          +   ['out','maybe','in'].map(function(kk){
                var lbl = kk === 'out' ? 'Out' : (kk === 'maybe' ? '?' : 'In');
                return '<button class="vbmini '+kk+(v===kk?' sel':'')+'" data-v="'+kk+'" data-hip="'+h.hip+'">'
                  + '<span style="font-size:12px;font-weight:700;color:'+(v===kk?'#fff':'var(--'+kk+')')+'">'+lbl+'</span></button>';
              }).join('')
          + '</div></div>';
      }).join('')
    + '</div></div>';

  return '<div class="bar"><button class="ico" data-back="1">'+icon('back')+'</button>'
    + '<h1>Compare '+hs.length+'</h1>'
    + '<button style="font-size:13px;font-weight:600;color:var(--ink)" data-cmpadd="1">Shortlist</button></div>'
    + header
    + (sameSire ? '<div class="cmplab"><span class="cmpsame">SAME SIRE — '+esc(hs[0].sire).toUpperCase()+'</span></div>' : '')
    + band('THE HORSE', function(h){
        return '<div class="cmpv">'+esc(descr(h) || '—')+'</div>'
          + '<div class="cmpv dim">'+esc(h.foaled || '—')
          + (earliest && h.foaled && Date.parse(h.foaled) === earliest && hs.length > 1 ? ' <span class="cmpsame">EARLIEST</span>' : '')
          + '</div>'
          + (h.name ? '<div class="cmpv dim">Named '+esc(h.name)+'</div>' : '');
      })
    + band('WHERE', function(h){
        return '<div class="cmpv">Barn '+esc(h.barn)+'</div>'
          + (h.printed ? '<div class="cmpv dim">prints '+esc(h.printed)+'</div>' : '')
          + '<div class="cmpv dim">'+esc(h.consignor.replace(/, Agent.*$/, ''))+'</div>';
      })
    + band('SELLS', function(h){
        return h.ses
          ? '<div class="cmpv">Book '+esc(h.ses[1])+'</div><div class="cmpv dim">'+esc(h.ses[2])+'</div>'
          : '<div class="cmpv dim">—</div>';
      })
    + band('SIRE RECORD', function(h){
        return '<div class="cmpprose">'+bold(D.sire_text[h.sireIdx] || '—')+'</div>';
      }, null, wide)
    + band('1ST DAM', function(h){
        return '<div class="cmpprose">'+bold(h.d1 || '—')+'</div>';
      }, null, wide)
    + band('2ND DAM', function(h){
        return '<div class="cmpprose">'+bold(h.d2 || '—')+'</div>';
      }, null, wide)
    + band('NOTES', function(h){
        var ns = notesFor(h.hip);
        return ns.length
          ? ns.map(function(n){ return '<div class="cmpprose"><b>'+esc(firstName(n.user_id))+'</b> '+esc(n.text)+'</div>'; }).join('')
          : '<div class="cmpprose" style="color:var(--mut2)">No notes</div>';
      }, null, wide)
    + '<div style="height:24px"></div>';
}

function ago(ts){
  var s = Math.round((Date.now() - ts)/1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return Math.round(s/60) + ' min ago';
  if (s < 86400) return Math.round(s/3600) + ' hr ago';
  return new Date(ts).toLocaleDateString([], {month:'short', day:'numeric'});
}
function syncBar(){
  var st = Store.status(), cls = 'dot', msg, act = '';
  if (!st.online){
    cls += ' off';
    msg = st.pending
      ? st.pending + ' change' + (st.pending===1?'':'s') + ' held — no signal'
      : 'No signal. Everything you mark is saved.';
  } else if (st.pending){
    cls += ' pend';
    msg = st.syncing ? 'Sending ' + st.pending + '…'
        : st.pending + ' change' + (st.pending===1?'':'s') + ' to send'
          + (st.stuck ? ' · retrying' : '');
    act = '<button style="font-weight:700;color:var(--ink)" data-syncnow="1">Send now</button>';
  } else {
    cls += ' ok';
    msg = st.lastSync ? 'Synced ' + ago(st.lastSync) : 'Syncing…';
  }
  return '<div class="sync"><div class="'+cls+'"></div>'
    + '<span style="flex:1">'+esc(msg)+'</span>' + act + '</div>';
}

function tabs(){
  var t = [['walk','barn','Barns'],['search','search','Search'],['lists','list','Lists']];
  return '<div class="tabs">' + t.map(function(x){
    var on = (V.screen===x[0]) || (x[0]==='walk'&&V.screen==='barn') || (x[0]==='lists'&&V.screen==='list');
    return '<button class="tab'+(on?' on':'')+'" data-go="'+x[0]+'">'+icon(x[1])+'<span>'+x[2]+'</span></button>';
  }).join('') + '</div>';
}

function sheetHTML(){
  if (V.editNote){
    var te = document.getElementById('ne' + V.editNote);
    if (te){ te.focus(); te.setSelectionRange(te.value.length, te.value.length); }
  }
  if (V.sheet === 'name'){
    var f = V.nameFor || {};
    var cur = f.mode === 'rename' ? ((listById(f.id)||{}).name || '') : '';
    var sugg = ['Book 1 — bid list','Second looks','For Larry'];
    return '<div class="sheet" data-close="1"><div class="sheetin" data-stop="1"><div class="grab"></div>'
      + '<div style="padding:0 20px 12px"><div style="font-size:17px;font-weight:600;letter-spacing:-.015em">'
      + (f.mode === 'rename' ? 'Rename shortlist' : 'New shortlist') + '</div>'
      + (f.hips && f.hips.length ? '<div class="sub" style="margin-top:4px">'+f.hips.length+' horse'+(f.hips.length===1?'':'s')+' will be added</div>' : '')
      + '</div>'
      + '<div style="padding:0 20px"><input id="nameinput" class="noteinput" style="width:100%;height:52px;border-style:solid;font-size:16px" '
      + 'placeholder="Name this shortlist" autocomplete="off" value="'+esc(cur)+'"></div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:7px;padding:12px 20px 0">'
      + sugg.map(function(x){ return '<button class="pill" data-sugg="'+esc(x)+'">'+esc(x)+'</button>'; }).join('')
      + '</div>'
      + '<div style="display:flex;gap:9px;padding:16px 20px 0">'
      + '<button class="btn ghost" style="flex:1" data-close="1">Cancel</button>'
      + '<button class="btn" style="flex:1;opacity:'+(cur?'1':'.4')+'" id="namego" data-namego="1">'
      + (f.mode === 'rename' ? 'Rename' : 'Create') + '</button></div>'
      + '</div></div>';
  }
  if (V.sheet === 'export'){
    return '<div class="sheet" data-close="1"><div class="sheetin" data-stop="1"><div class="grab"></div>'
      + '<div style="padding:0 20px 10px"><div style="font-size:17px;font-weight:600;letter-spacing:-.015em">'+esc(EXPORT.name)+'</div>'
      + '<div class="sub" style="margin-top:4px">Copy this and paste it into an email. It is a spreadsheet — it will open in Excel or Numbers.</div></div>'
      + '<div style="padding:0 20px"><textarea id="exporttext" readonly style="width:100%;height:190px;border:1px solid var(--edge);border-radius:8px;padding:11px;font-family:\'IBM Plex Mono\',monospace;font-size:11.5px;line-height:1.5;background:var(--soft);resize:none">'+esc(EXPORT.csv)+'</textarea></div>'
      + '<div style="display:flex;gap:9px;padding:14px 20px 0">'
      + '<button class="btn" style="flex:1" data-copy="1">Copy</button>'
      + '<button class="btn ghost" style="flex:1" data-close="1">Done</button></div>'
      + '</div></div>';
  }
  if (V.sheet === 'account'){
    var st = Store.status();
    var out = V.confirmOut === 1;
    return '<div class="sheet" data-close="1"><div class="sheetin" data-stop="1"><div class="grab"></div>'
      + '<div style="padding:0 20px 4px;display:flex;align-items:center;gap:12px">'
      +   '<div class="av" style="width:40px;height:40px;font-size:13px">'+esc(initialsOf(me()))+'</div>'
      +   '<div class="meat"><div class="nm" style="font-size:16px">'+esc(displayName(me()))+'</div>'
      +   '<div class="sub">'+esc((SESSION && SESSION.user && SESSION.user.email) || '')+'</div></div>'
      + '</div>'
      + '<div style="padding:14px 20px 0"><div class="pgh">SYNC</div>'
      +   '<div class="sub" style="font-size:13px;line-height:1.6">'
      +     (st.online ? 'Connected.' : 'No signal right now.') + '<br>'
      +     (st.pending ? st.pending + ' change' + (st.pending===1?'':'s') + ' waiting to send.'
                       : 'Nothing waiting to send.') + '<br>'
      +     (st.lastSync ? 'Last synced ' + ago(st.lastSync) + '.' : 'Not synced yet on this device.')
      +     (st.error ? '<br><span style="color:var(--out)">' + esc(st.error) + '</span>' : '')
      +   '</div>'
      + '</div>'
      + '<div style="padding:14px 20px 0"><div class="pgh">BUILD</div>'
      +   '<div class="sub" style="font-size:13px;line-height:1.6">'
      +     buildLine() + '<br>'
      +     esc(SALEBOOK_CONFIG.catalog.replace(/^data\//, ''))
      +   '</div>'
      + '</div>'
      + '<div style="display:flex;gap:9px;padding:16px 20px 0">'
      +   '<button class="btn ghost" style="flex:1" data-syncnow="1">'+icon('cloud')+'Sync now</button>'
      +   '<button class="btn ghost" style="flex:1" data-exportall="1">'+icon('doc')+'Export marks</button>'
      + '</div>'
      // Signing out drops the cached session; if anything is still queued that work
      // would be stranded on this device, so say so before letting it happen.
      + '<div style="padding:14px 20px 0">'
      +   '<button class="btn ghost" style="width:100%;color:'+(out?'#fff':'var(--out)')+';border-color:var(--out);'
      +     (out?'background:var(--out);':'')+'" data-signout="1">'
      +     (out ? (st.pending ? 'Tap again — ' + st.pending + ' unsent' : 'Tap again to sign out') : 'Sign out') + '</button>'
      + '</div>'
      + '</div></div>';
  }
  if (V.sheet !== 'add') return '';
  var ls = allLists(), hip = V.pick;
  return '<div class="sheet" data-close="1"><div class="sheetin" data-stop="1"><div class="grab"></div>'
    + '<div style="padding:0 20px 12px"><div style="font-size:17px;font-weight:600;letter-spacing:-.015em">'
    + (Array.isArray(hip) ? 'Add '+hip.length+' horses to…' : 'Add hip '+hip+' to…')+'</div></div>'
    + ls.map(function(l){
        var has = Array.isArray(hip)
          ? hip.every(function(x){ return l.hips.indexOf(x) >= 0; })
          : l.hips.indexOf(hip) >= 0;
        return '<button class="srow" data-toggle="'+esc(l.id)+'"><div class="badge'+(has?' dark':'')+'">'+l.hips.length+'</div>'
          + '<div class="meat"><div class="nm" style="font-size:15px">'+esc(l.name)+'</div>'
          + '<div class="sub">'+(has?'Already on this list — tap to remove':'Tap to add')+'</div></div>'
          + (has ? icon('check') : icon('plus')) + '</button>';
      }).join('')
    + '<button class="srow" data-newlist="'+hip+'"><div class="badge" style="border:1.5px dashed var(--edge);background:none">'+icon('plus')+'</div>'
    + '<div class="meat"><div class="nm" style="font-size:15px">New shortlist…</div></div></button>'
    + '</div></div>';
}

/* ---------- render ---------- */
// The sign-in screen is re-entrant: the catalog finishing its download, or the
// network flapping, must not blank out an email someone is halfway through typing.
var authSig = null;
function renderAuth(app){
  captureAuthFields();
  var sig = JSON.stringify([AUTH.email, AUTH.error, AUTH.busy]);
  if (authSig === sig && document.getElementById('authform')) return;
  authSig = sig;
  app.innerHTML = Auth.screen(AUTH);
  var np = document.getElementById('authpw');
  if (np && AUTH.pw) np.value = AUTH.pw;
}
function captureAuthFields(){
  var e = document.getElementById('authemail'), p = document.getElementById('authpw');
  if (e && e.value) AUTH.email = e.value;
  if (p && p.value) AUTH.pw = p.value;
}

function render(){
  var app = document.getElementById('app');
  if (!SESSION){ renderAuth(app); return; }
  authSig = null;
  if (!D){ app.innerHTML = scrLoading(); return; }
  var body = { walk:scrWalk, barn:scrBarn, hip:scrHip, search:scrSearch, lists:scrLists, list:scrList, compare:scrCompare }[V.screen] || scrWalk;
  app.innerHTML = body() + ((V.select || V.screen === 'compare') ? '' : tabs()) + sheetHTML();
  if (V.editNote){
    var te = document.getElementById('ne' + V.editNote);
    if (te){ te.focus(); te.setSelectionRange(te.value.length, te.value.length); }
  }
  if (V.sheet === 'name'){
    var nf = document.getElementById('nameinput');
    if (nf){ nf.focus(); nf.setSelectionRange(nf.value.length, nf.value.length); }
  }
  if (V.screen === 'search' && V.mode === 'txt'){
    var qi = document.getElementById('qin');
    if (qi){ qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
  }
}

/* ---------- events ---------- */
var BACK = [];
function openHip(idx){ V.editNote = null; V.confirmNote = null; BACK.push({s:V.screen, b:V.barn, l:V.list, q:V.q, m:V.mode, f:V.filter, from:V.from}); go('hip', {hip:idx}); }

function currentIdx(){
  if (V.screen === 'barn'){
    var b = BARNS.filter(function(x){return x.barn===V.barn;})[0];
    if (!b) return [];
    if (V.filter === 'all') return b.idx;
    return b.idx.filter(function(i){
      var v = myVerdict(D.H[i][0]);
      return V.filter === 'unseen' ? !v : v === V.filter; });
  }
  if (V.screen === 'list'){
    var l = listById(V.list); if (!l) return [];
    return l.hips.map(function(hp){ return BYHIP[hp]; }).filter(function(x){return x!=null;});
  }
  return [];
}
function selectBar(){
  var n = Object.keys(V.select).length, all = n === currentIdx().length && n > 0;
  return '<div class="bar" style="background:var(--ink);color:#fff;border-color:var(--ink)">'
    + '<button style="font-size:13px;font-weight:600;color:var(--edge)" data-selcancel="1">Cancel</button>'
    + '<h1 style="text-align:center">'+(n?n+' selected':'Select horses')+'</h1>'
    + '<button style="font-size:13px;font-weight:600;color:#fff" data-selall="1">'+(all?'None':'All')+'</button></div>';
}
function selectActions(){
  var n = Object.keys(V.select).length;
  if (!n) return '';
  var cmp = n >= 2 && n <= 4
    ? '<button class="btn ghost" style="flex:1" data-compare="1">'+icon('cols')+'Compare '+n+'</button>'
    : (n > 4 ? '<div class="btn ghost" style="flex:1;opacity:.5">Compare up to 4</div>' : '');
  return '<div class="actionbar">' + cmp
    + '<button class="btn" style="flex:1" data-addsel="1">'+icon('plus')+'Add to shortlist</button></div>';
}
function openSearch(){
  // remember the screen we came from, and start every search clean
  if (V.screen !== 'search') V.from = {s:V.screen, b:V.barn, l:V.list, f:V.filter};
  V.q = ''; V.mode = 'num'; V.open = null; V.select = null;
  go('search');
}
function leaveSearch(){
  var f = V.from || {s:'walk'};
  V.from = null; V.q = ''; V.mode = 'num';
  V.barn = f.b || null; V.list = f.l || null; V.filter = f.f || 'all';
  go(f.s || 'walk');
}
function goBack(){
  if (V.screen === 'search') return leaveSearch();
  var p = BACK.pop();
  if (!p) return go('walk');
  V.barn = p.b; V.list = p.l; V.q = p.q; V.mode = p.m; V.filter = p.f || 'all'; V.from = p.from || null;
  go(p.s);
}

document.addEventListener('click', function(ev){
  var t = ev.target.closest ? ev.target.closest('[data-go],[data-barn],[data-row],[data-v],[data-note],[data-page],[data-add],[data-filter],[data-k],[data-list],[data-newlist],[data-toggle],[data-close],[data-stop],[data-copy],[data-back],[data-share],[data-csv],[data-exportall],[data-selstart],[data-selcancel],[data-selall],[data-addsel],[data-remove],[data-rename],[data-dellist],[data-copylist],[data-sugg],[data-namego],[data-compare],[data-cmpadd],[data-noteedit],[data-notesave],[data-notedel],[data-notecancel],[data-authgo],[data-account],[data-signout],[data-syncnow]') : null;
  if (!t) return;
  var d = t.dataset;

  if (d.stop != null && d.close == null) { ev.stopPropagation(); }
  if (d.authgo != null){ doSignIn(); return; }
  if (d.account != null){ V.sheet = 'account'; V.confirmOut = null; probeBuild(); render(); return; }
  if (d.syncnow != null){ Store.sync(); toast(navigator.onLine ? 'Syncing…' : 'No signal — it will send itself.'); return; }
  if (d.signout != null){
    // Two-tap, like every other destructive action here, and louder when work is queued.
    if (V.confirmOut !== 1){
      V.confirmOut = 1; render();
      setTimeout(function(){ if (V.confirmOut === 1){ V.confirmOut = null; render(); } }, 4000);
      return;
    }
    doSignOut(); return;
  }
  if (d.back != null){ goBack(); return; }
  if (d.go){
    if (d.go === 'search'){ openSearch(); return; }
    V.open = null; V.select = null; V.from = null; go(d.go); return;
  }
  if (d.barn){ V.open = null; V.showPage = false; V.select = null; V.filter = 'all'; go('barn', {barn:d.barn}); return; }
  if (d.filter){ V.filter = d.filter; V.open = null; V.showPage = false; render(); return; }

  if (d.remove != null){
    ev.stopPropagation();
    Store.removeFromList(V.list, +d.remove);
    render();
    return;
  }
  if (d.selstart != null){ V.select = {}; V.open = null; render(); return; }
  if (d.selcancel != null){ V.select = null; render(); return; }
  if (d.selall != null){
    var ci = currentIdx();
    var all = Object.keys(V.select).length === ci.length;
    V.select = {};
    if (!all) ci.forEach(function(i){ V.select[D.H[i][0]] = 1; });
    render(); return;
  }
  if (d.compare != null){
    var picks = Object.keys(V.select).map(Number).sort(function(a,b){return a-b;})
                  .map(function(hp){ return BYHIP[hp]; }).filter(function(x){return x!=null;});
    if (picks.length < 2) return;
    BACK.push({s:V.screen, b:V.barn, l:V.list, q:V.q, m:V.mode, f:V.filter, from:V.from});
    V.select = null;
    go('compare', {compare:picks.slice(0,4)});
    return;
  }
  if (d.cmpadd != null){
    V.pick = (V.compare||[]).map(function(i){ return D.H[i][0]; });
    V.sheet = 'add'; render(); return;
  }
  if (d.addsel != null){
    V.pick = Object.keys(V.select).map(Number);
    V.sheet = 'add'; render(); return;
  }
  if (d.rename){ V.nameFor = {mode:'rename', id:d.rename}; V.sheet = 'name'; render(); return; }
  if (d.dellist){
    if (V.confirmDel === d.dellist){ V.confirmDel = null; deleteList(d.dellist); go('lists'); }
    else { V.confirmDel = d.dellist; render(); setTimeout(function(){
      if (V.confirmDel === d.dellist){ V.confirmDel = null; render(); } }, 3000); }
    return;
  }
  if (d.copylist){
    var src = listById(d.copylist);
    V.nameFor = {mode:'new', hips: src ? src.hips.slice() : []};
    V.sheet = 'name'; render(); return;
  }
  if (d.sugg){
    var ni = document.getElementById('nameinput');
    if (ni){ ni.value = d.sugg; var g = document.getElementById('namego'); if (g) g.style.opacity = '1'; }
    return;
  }
  if (d.namego != null){
    var el2 = document.getElementById('nameinput');
    var nm2 = el2 ? el2.value.trim() : '';
    if (!nm2){ if (el2) el2.focus(); return; }
    var f2 = V.nameFor || {};
    if (f2.mode === 'rename'){ renameList(f2.id, nm2); V.sheet = null; V.nameFor = null; render(); return; }
    var nl = newList(nm2);
    if (f2.hips && f2.hips.length) addManyToList(nl.id, f2.hips);
    V.sheet = null; V.nameFor = null; V.select = null;
    go('list', {list:nl.id}); return;
  }
  if (d.row != null){
    var i = +d.row;
    if (V.select){
      var hp = D.H[i][0];
      if (V.select[hp]) delete V.select[hp]; else V.select[hp] = 1;
      render(); return;
    }
    if (V.screen === 'barn'){
      V.showPage = (V.open === i) ? false : false;
      V.open = (V.open === i ? null : i);
      render();
    }
    else openHip(i);
    return;
  }
  if (d.v){ setVerdict(+d.hip, d.v); render(); return; }
  if (d.note != null){
    var el = document.getElementById('ni'+d.note);
    if (el && el.value.trim()){ addNote(+d.note, el.value); render(); }
    return;
  }
  if (d.page != null){
    V.showPage = !V.showPage;
    render();
    if (V.showPage){
      var pp = document.getElementById('pagepanel');
      if (pp && pp.scrollIntoView) pp.scrollIntoView({block:'nearest'});
    }
    return;
  }
  if (d.add != null){ V.pick = +d.add; V.sheet = 'add'; render(); return; }
  if (d.close != null){ V.sheet = null; render(); return; }
  if (d.toggle){
    if (Array.isArray(V.pick)){
      var lst = listById(d.toggle);
      var all = lst && V.pick.every(function(x){ return lst.hips.indexOf(x) >= 0; });
      if (all) V.pick.forEach(function(x){ Store.removeFromList(d.toggle, x); });
      else addManyToList(d.toggle, V.pick);
      V.sheet = null; V.select = null;
      toast('Shortlist updated.'); go('list', {list:d.toggle}); return;
    }
    toggleInList(d.toggle, V.pick); render(); return;
  }
  if (d.newlist != null){
    var hipsFor = [];
    if (d.newlist !== '1' && V.pick != null) hipsFor = Array.isArray(V.pick) ? V.pick.slice() : [V.pick];
    V.nameFor = {mode:'new', hips:hipsFor}; V.sheet = 'name'; render(); return;
  }
  if (d.list){ go('list', {list:d.list}); return; }
  if (d.copy != null){ copyExport(); return; }
  if (d.noteedit){ V.editNote = d.noteedit; V.confirmNote = null; render(); return; }
  if (d.notecancel != null){ V.editNote = null; V.confirmNote = null; render(); return; }
  if (d.notesave){
    var ta = document.getElementById('ne' + d.notesave);
    var tx = ta ? ta.value.trim() : '';
    if (!tx){ V.confirmNote = d.notesave; render(); return; }   // empty save = you meant delete
    editNote(d.notesave, tx); V.editNote = null; V.confirmNote = null; render(); return;
  }
  if (d.notedel){
    if (V.confirmNote === d.notedel){
      deleteNote(d.notedel); V.editNote = null; V.confirmNote = null; render();
    } else {
      V.confirmNote = d.notedel; render();
      setTimeout(function(){ if (V.confirmNote === d.notedel){ V.confirmNote = null; render(); } }, 3000);
    }
    return;
  }
  if (d.share != null){
    var sl = listById(V.list);
    if (!sl || sl.auto) return;
    var url = location.origin + location.pathname + '#list/' + sl.id;
    var payload = {title: sl.name, text: sl.name + ' — ' + sl.hips.length + ' horses', url: url};
    if (navigator.share) navigator.share(payload).catch(function(){});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(
      function(){ toast('Link to “' + sl.name + '” copied.'); },
      function(){ toast(url); });
    else toast(url);
    return;
  }
  if (d.csv){ exportCSV(d.csv); return; }
  if (d.exportall != null){ exportAll(); return; }

  if (d.k){
    if (d.k === 'del') V.q = V.q.slice(0,-1);
    else if (d.k === 'abc'){ V.mode = 'txt'; }
    else if (d.k === '123'){ V.mode = 'num'; V.q = V.q.replace(/\D/g,''); }
    else V.q += d.k;
    render(); return;
  }
});

// A real <form> so phones offer to save the password; the submit is ours, not the browser's.
document.addEventListener('submit', function(ev){
  if (ev.target && ev.target.id === 'authform'){ ev.preventDefault(); doSignIn(); }
});

document.addEventListener('input', function(ev){
  if (ev.target && (ev.target.id === 'authemail' || ev.target.id === 'authpw')){ captureAuthFields(); return; }
  if (ev.target && ev.target.id === 'qin'){ V.q = ev.target.value; render(); return; }
  if (ev.target && ev.target.id === 'nameinput'){
    var g = document.getElementById('namego');
    if (g) g.style.opacity = ev.target.value.trim() ? '1' : '.4';
  }
});
document.addEventListener('keydown', function(ev){
  // Escape always leaves search, even from inside the text field
  if (ev.key === 'Escape' && V.screen === 'search' && !V.sheet){ ev.preventDefault(); leaveSearch(); return; }
  if (V.screen === 'search' && !V.sheet && V.mode === 'num'){
    var tg = ev.target, inField = tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA');
    if (!inField && !ev.metaKey && !ev.ctrlKey && !ev.altKey){
      if (/^[0-9]$/.test(ev.key)){ ev.preventDefault(); V.q += ev.key; render(); return; }
      if (ev.key === 'Backspace'){ ev.preventDefault(); V.q = V.q.slice(0, -1); render(); return; }
      if (/^[a-zA-Z]$/.test(ev.key)){ ev.preventDefault(); V.mode = 'txt'; V.q = ev.key; render(); return; }
    }
  }
  if (ev.key !== 'Enter') return;
  var el = ev.target;
  if (el && (el.id === 'authemail' || el.id === 'authpw')){ ev.preventDefault(); doSignIn(); return; }
  if (el && el.id === 'nameinput'){
    ev.preventDefault();
    var gb = document.getElementById('namego'); if (gb) gb.click();
    return;
  }
  if (el && el.id && el.id.indexOf('ni') === 0 && el.id !== 'nameinput'){
    var hip = +el.id.slice(2);
    if (el.value.trim()){ addNote(hip, el.value); render(); }
  }
});

function exportCSV(id){
  var l = listById(id); if (!l) return;
  var head = 'hip,name,sex,sire,dam,consignor,barn,foaled,verdict,notes\n';
  var body = l.hips.map(function(hp){
    var i = BYHIP[hp]; if (i == null) return '';
    var h = H(i);
    var ns = notesFor(hp).map(function(n){ return firstName(n.user_id)+': '+n.text; }).join(' | ');
    return [h.hip, h.name||'', h.sex, h.sire, h.dam, h.consignor, h.barn, h.foaled||'', myVerdict(hp)||'', ns]
      .map(function(x){ return '"' + String(x).replace(/"/g,'""') + '"'; }).join(',');
  }).filter(Boolean).join('\n');
  if (!body){ toast('That list is empty.'); return; }
  openExport(l.name, head + body);
}

function exportAll(){
  var seen = {}, rowsOut = [], st = Store._state();
  Object.keys(Store.myVerdictMap()).forEach(function(h){ seen[h] = 1; });
  Object.keys(st.notes).forEach(function(k){
    var nt = st.notes[k]; if (nt.user_id === me() && !nt.deleted_at) seen[nt.hip] = 1; });
  allLists().forEach(function(l){ l.hips.forEach(function(h){ seen[h] = 1; }); });
  var listOf = {};
  allLists().forEach(function(l){ l.hips.forEach(function(h){ (listOf[h] = listOf[h] || []).push(l.name); }); });
  Object.keys(seen).sort(function(a,b){return a-b;}).forEach(function(hp){
    var i = BYHIP[hp]; if (i == null) return;
    var h = H(i);
    rowsOut.push([h.hip, h.name||'', h.sex, h.sire, h.dam, h.barn, h.consignor,
      myVerdict(+hp)||'', (listOf[hp]||[]).join('; '),
      notesFor(+hp).filter(function(n){return n.user_id===me();}).map(function(n){return n.text;}).join(' | ')]);
  });
  if (!rowsOut.length){ toast('Nothing to export yet.'); return; }
  var csv = 'hip,name,sex,sire,dam,barn,consignor,verdict,shortlists,notes\n'
    + rowsOut.map(function(r){ return r.map(function(x){ return '"' + String(x).replace(/"/g,'""') + '"'; }).join(','); }).join('\n');
  openExport(firstName(me()) + "'s marks — " + rowsOut.length + (rowsOut.length===1?' horse':' horses'), csv);
}

/* ============================================================================
   sign in / sign out
   ========================================================================== */

var signInAt = 0;
function doSignIn(){
  if (AUTH.busy) return;
  if (Date.now() - signInAt < 400) return;   // one tap, one attempt
  signInAt = Date.now();
  // Read from AUTH, which the input handler keeps current — not straight from the DOM,
  // which a re-render (the catalog landing, the network flapping) may have just rebuilt.
  captureAuthFields();
  var email = AUTH.email, pass = AUTH.pw;
  if (!email.trim() || !pass){ AUTH.error = 'Enter your email and password.'; render(); return; }
  AUTH.busy = true; AUTH.error = null; render();
  Auth.signIn(email, pass).then(function(res){
    AUTH.busy = false;
    if (res.error){ AUTH.error = Auth.friendlyError(res.error); render(); return; }
    AUTH.error = null; AUTH.pw = '';
    start(res.data.session);
  }).catch(function(err){
    AUTH.busy = false; AUTH.error = Auth.friendlyError(err); render();
  });
}

function doSignOut(){
  var st = Store.status();
  Auth.signOut().then(function(){
    return Store.reset();
  }).then(function(){
    SESSION = null; V.sheet = null; V.confirmOut = null;
    AUTH = { email:'', pw:'', error: st.pending
      ? st.pending + ' change' + (st.pending===1?'':'s') + ' had not sent yet and were cleared from this device.'
      : null, busy:false };
    render();
  });
}

/* ============================================================================
   boot
   ----------------------------------------------------------------------------
   Order matters: the catalog is a static file the service worker has precached,
   and the session comes out of local storage, so a cold open at a barn with no
   signal reaches a usable screen without a single successful request.
   ========================================================================== */

var CATALOG_ERROR = null;

function loadCatalog(){
  if (D) return Promise.resolve();
  return fetch(SALEBOOK_CONFIG.catalog).then(function(r){
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function(json){
    initData(json);
    CATALOG_ERROR = null;
  }).catch(function(err){
    CATALOG_ERROR = String(err && err.message || err);
  });
}

// Deep links: a shortlist someone sent you, or a hip number.
function applyHash(){
  var h = (location.hash || '').replace(/^#\/?/, '');
  if (!h || !D) return false;
  var m = h.match(/^list\/(.+)$/);
  if (m){ V.list = m[1]; go('list'); return true; }
  m = h.match(/^hip\/(\d+)$/);
  if (m && BYHIP[+m[1]] != null){ go('hip', {hip: BYHIP[+m[1]]}); return true; }
  return false;
}

var renderQueued = false;
function scheduleRender(){
  // Sync callbacks can land in bursts; coalesce them into one paint.
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(function(){ renderQueued = false; render(); });
}

function start(session){
  SESSION = session;
  return loadCatalog().then(function(){
    return Store.init(Auth.client(), session.user.id, scheduleRender);
  }).then(function(){
    if (!applyHash()) render();
  });
}

function boot(){
  render();                                   // sign-in screen, instantly
  loadCatalog().then(function(){
    return Auth.session();
  }).then(function(session){
    if (session) return start(session);
    render();
  });

  Auth.onAuthChange(function(event, session){
    if (event === 'SIGNED_OUT'){ SESSION = null; render(); return; }
    if (session && (!SESSION || SESSION.user.id !== session.user.id)) start(session);
    else SESSION = session;
  });

  window.addEventListener('hashchange', function(){ if (SESSION) applyHash(); });
  window.addEventListener('online',  scheduleRender);
  window.addEventListener('offline', scheduleRender);

  if ('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').then(function(reg){
      reg.addEventListener('updatefound', function(){
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', function(){
          // A fix on sale day has to be able to reach a phone that is already installed.
          if (sw.state === 'installed' && navigator.serviceWorker.controller){
            BUILD.waiting = true;
            toast('Update ready — reopen the app.');
          }
        });
      });
    }).catch(function(){});
  }
}

boot();
