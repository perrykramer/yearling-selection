/* ============================================================================
   store.js — local-first storage for the Sale Book.
   ----------------------------------------------------------------------------
   The rule this file exists to enforce: a mutation NEVER waits on the network.
   Every write lands in memory and IndexedDB and renders immediately; a copy goes
   into an outbox that drains when there is signal. A man at a barn with no bars
   marks twenty horses, closes the app, drives out, and they sync.

   Reads work the same way in reverse: hydrate from IndexedDB and render, then
   reconcile from Supabase in the background. The app is fully usable before any
   request completes.

   Conflict resolution is structural, not procedural — which is why there is no
   merge UI anywhere in this codebase:
     verdicts    keyed (hip, user_id)  → last write from that person wins
     notes       append-only, soft delete
     list_items  keyed (list_id, hip)  → concurrent adds merge naturally

   Everything here is normalised, database-shaped. The projections at the bottom
   hand the UI the shapes it already expects (a list with a .hips array, a note
   with .ts) so the render code did not have to change.
   ========================================================================== */

var Store = (function(){

  var DB_NAME = 'wp-salebook';
  var DB_VERSION = 1;
  var STORES = ['verdicts','notes','lists','list_items','profiles','outbox','meta'];
  var TABLES = ['profiles','verdicts','notes','lists','list_items'];

  /* ---------------------------------------------------------------- IndexedDB */

  var dbp = null;
  function db(){
    if (dbp) return dbp;
    dbp = new Promise(function(resolve, reject){
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function(){
        var d = req.result;
        STORES.forEach(function(s){ if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); });
      };
      req.onsuccess = function(){ resolve(req.result); };
      req.onerror = function(){ reject(req.error); };
    });
    return dbp;
  }
  function tx(names, mode, fn){
    return db().then(function(d){
      return new Promise(function(resolve, reject){
        var t = d.transaction(names, mode), out;
        t.oncomplete = function(){ resolve(out); };
        t.onerror = function(){ reject(t.error); };
        t.onabort = function(){ reject(t.error); };
        out = fn(names.map(function(n){ return t.objectStore(n); }), t);
      });
    });
  }
  function idbPut(store, key, val){ return tx([store],'readwrite', function(s){ s[0].put(val, key); }); }
  function idbDel(store, key){ return tx([store],'readwrite', function(s){ s[0].delete(key); }); }
  function idbAll(store){
    return tx([store],'readonly', function(s){
      var out = {};
      var req = s[0].openCursor();
      req.onsuccess = function(){
        var c = req.result;
        if (!c) return;
        out[c.key] = c.value;
        c.continue();
      };
      return out;
    });
  }

  /* ---------------------------------------------------------------- state */

  // Normalised mirror of the database. Keys match the primary keys in Postgres.
  var S = {
    verdicts:   {},   // "hip:user_id"    -> {hip, user_id, verdict, updated_at}
    notes:      {},   // id               -> {id, hip, user_id, body, created_at, edited_at, deleted_at}
    lists:      {},   // id               -> {id, name, owner_id, created_at, deleted_at, updated_at}
    list_items: {},   // "list_id:hip"    -> {list_id, hip, added_by, added_at, position, removed_at}
    profiles:   {},   // id               -> {id, display_name}
    outbox:     {},   // id               -> {id, table, row, ts, tries, error}
    cursors:    {},   // table            -> ISO timestamp of the newest row we have pulled
    lastSync:   0,
    syncing:    false,
    lastError:  null
  };

  var sb = null;            // supabase client
  var uid = null;           // signed-in user id
  var onChange = function(){};

  function vkey(hip, user){ return hip + ':' + user; }
  function ikey(list, hip){ return list + ':' + hip; }
  function nowISO(){ return new Date().toISOString(); }
  function uuid(){
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
      var r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /* ---------------------------------------------------------------- boot */

  function hydrate(){
    return Promise.all(STORES.filter(function(s){ return s !== 'meta'; }).map(function(s){
      return idbAll(s).then(function(rows){ S[s] = rows; });
    })).then(function(){
      return idbAll('meta');
    }).then(function(m){
      S.cursors  = m.cursors  || {};
      S.lastSync = m.lastSync || 0;
    });
  }

  function saveMeta(){
    return tx(['meta'],'readwrite', function(s){
      s[0].put(S.cursors, 'cursors');
      s[0].put(S.lastSync, 'lastSync');
    });
  }

  /* ---------------------------------------------------------------- outbox
     One row per mutation. Because every write is an idempotent upsert on a
     natural key, replaying the queue in order is always safe — a flush that
     dies halfway can simply run again. */

  // Outstanding IndexedDB writes, so callers can tell when a change is genuinely durable
  // rather than merely rendered.
  var writes = [];
  function track(p){
    writes.push(p);
    var done = function(){ var i = writes.indexOf(p); if (i >= 0) writes.splice(i, 1); };
    p.then(done, done);
    return p;
  }
  function settled(){ return Promise.all(writes.map(function(p){ return p.catch(function(){}); })); }

  var flushTimer = null, backoff = 0;
  function flushSoon(delay){
    if (flushTimer) return;
    flushTimer = setTimeout(function(){ flushTimer = null; flush(); }, delay || 0);
  }

  function pendingJobs(){
    return Object.keys(S.outbox).map(function(k){ return S.outbox[k]; })
      .sort(function(a,b){ return a.ts - b.ts; });
  }

  function flush(){
    if (!sb || !uid) return Promise.resolve();
    var jobs = pendingJobs();
    if (!jobs.length) return Promise.resolve();
    if (!navigator.onLine) return Promise.resolve();

    var chain = Promise.resolve();
    var failed = false;
    jobs.forEach(function(job){
      chain = chain.then(function(){
        if (failed) return;
        return sb.from(job.table).upsert(job.row).then(function(res){
          if (res.error) throw res.error;
          delete S.outbox[job.id];
          return track(idbDel('outbox', job.id));
        }).catch(function(err){
          failed = true;
          job.tries++;
          job.error = String(err && err.message || err);
          S.lastError = job.error;
          track(idbPut('outbox', job.id, job));
        });
      });
    });

    return chain.then(function(){
      if (failed){
        // Exponential backoff, capped at a minute — long enough not to hammer a
        // flaky barn connection, short enough that a returning signal is caught.
        backoff = Math.min(backoff ? backoff * 2 : 2000, 60000);
        flushSoon(backoff);
      } else {
        backoff = 0;
        S.lastError = null;
        S.lastSync = Date.now();
        saveMeta();
      }
      onChange();
    });
  }

  /* ---------------------------------------------------------------- pull
     Incremental: ask each table for rows newer than the cursor we hold. On a
     cold start the cursor is empty and we pull everything, which for four
     people over one sale is small. */

  function pullTable(table){
    var q = sb.from(table).select('*').order('updated_at', {ascending:true}).limit(5000);
    var cur = S.cursors[table];
    if (cur) q = q.gt('updated_at', cur);
    return q.then(function(res){
      if (res.error) throw res.error;
      var rows = res.data || [];
      if (!rows.length) return 0;
      return tx([table],'readwrite', function(s){
        rows.forEach(function(r){
          var k = table === 'verdicts'   ? vkey(r.hip, r.user_id)
                : table === 'list_items' ? ikey(r.list_id, r.hip)
                : r.id;
          S[table][k] = r;
          s[0].put(r, k);
          if (!S.cursors[table] || r.updated_at > S.cursors[table]) S.cursors[table] = r.updated_at;
        });
      }).then(function(){ return rows.length; });
    });
  }

  function pull(){
    if (!sb || !uid || S.syncing || !navigator.onLine) return Promise.resolve(0);
    S.syncing = true;
    onChange();
    var total = 0;
    return TABLES.reduce(function(p, t){
      return p.then(function(){ return pullTable(t); }).then(function(n){ total += n; });
    }, Promise.resolve()).then(function(){
      S.lastSync = Date.now();
      S.lastError = null;
      return saveMeta();
    }).catch(function(err){
      S.lastError = String(err && err.message || err);
    }).then(function(){
      S.syncing = false;
      onChange();
      return total;
    });
  }

  // Flush first so our own work is never overwritten by a stale pull, then read.
  function sync(){ return flush().then(pull); }

  /* ---------------------------------------------------------------- writes
     Each one: mutate memory, persist locally, queue for the server, tell the UI.
     None of them return a promise the UI waits on. That is the whole point. */

  function local(table, key, row){
    S[table][key] = row;
    var job = { id: uuid(), table: table, row: row, ts: Date.now(), tries: 0, error: null };
    S.outbox[job.id] = job;
    // The change and its queue entry are written in ONE transaction. Two separate
    // writes could leave a mark saved on the phone with nothing queued to send it —
    // visible to the person who made it, invisible to everyone else, and silent.
    track(tx([table, 'outbox'], 'readwrite', function(st){
      st[0].put(row, key);
      st[1].put(job, job.id);
    }));
    flushSoon();
  }

  function setVerdict(hip, v){
    var k = vkey(hip, uid);
    var cur = S.verdicts[k];
    // Tapping the live verdict again clears it. The row stays, with verdict null,
    // so the clearing syncs instead of the old value resurrecting from a cache.
    var next = (cur && cur.verdict === v) ? null : v;
    local('verdicts', k, { hip: hip, user_id: uid, verdict: next, updated_at: nowISO() });
  }

  function addNote(hip, text){
    text = String(text || '').trim();
    if (!text) return;
    var id = uuid();
    local('notes', id, { id: id, hip: hip, user_id: uid, body: text,
                         created_at: nowISO(), edited_at: null, deleted_at: null });
  }

  function editNote(id, text){
    var n = S.notes[id];
    if (!n || n.user_id !== uid) return;
    var row = Object.assign({}, n, { body: String(text).trim(), edited_at: nowISO() });
    local('notes', id, row);
  }

  function deleteNote(id){
    var n = S.notes[id];
    if (!n || n.user_id !== uid) return;
    local('notes', id, Object.assign({}, n, { deleted_at: nowISO() }));
  }

  function newList(name){
    var id = uuid();
    local('lists', id, { id: id, name: name, owner_id: uid,
                         created_at: nowISO(), deleted_at: null });
    return id;
  }

  function renameList(id, name){
    var l = S.lists[id];
    if (!l) return;
    local('lists', id, Object.assign({}, l, { name: name }));
  }

  function deleteList(id){
    var l = S.lists[id];
    if (!l) return;
    local('lists', id, Object.assign({}, l, { deleted_at: nowISO() }));
  }

  function addToList(listId, hip){
    var k = ikey(listId, hip);
    var cur = S.list_items[k];
    local('list_items', k, cur
      ? Object.assign({}, cur, { removed_at: null })
      : { list_id: listId, hip: hip, added_by: uid, added_at: nowISO(), position: 0, removed_at: null });
  }

  function removeFromList(listId, hip){
    var k = ikey(listId, hip);
    var cur = S.list_items[k];
    if (!cur || cur.removed_at) return;
    local('list_items', k, Object.assign({}, cur, { removed_at: nowISO() }));
  }

  function toggleInList(listId, hip){
    var it = S.list_items[ikey(listId, hip)];
    if (it && !it.removed_at) removeFromList(listId, hip); else addToList(listId, hip);
  }

  /* ---------------------------------------------------------------- reads
     Projections back into the shapes the existing render code expects. */

  // { user_id: 'in'|'maybe'|'out' } for one horse, cleared verdicts omitted.
  function verdictsFor(hip){
    var out = {};
    for (var k in S.verdicts){
      var r = S.verdicts[k];
      if (r.hip === hip && r.verdict) out[r.user_id] = r.verdict;
    }
    return out;
  }

  function myVerdict(hip){
    var r = S.verdicts[vkey(hip, uid)];
    return (r && r.verdict) || null;
  }

  // Every teammate's verdict, not just the first. Two experts split on one horse
  // is the most valuable row in the app; collapsing it would destroy the signal.
  function teamVerdicts(hip){
    var out = [];
    for (var k in S.verdicts){
      var r = S.verdicts[k];
      if (r.hip === hip && r.verdict && r.user_id !== uid)
        out.push({ user_id: r.user_id, v: r.verdict });
    }
    return out.sort(function(a,b){ return displayName(a.user_id).localeCompare(displayName(b.user_id)); });
  }

  // Every horse this person has a live verdict on, as {hip: verdict}.
  function myVerdictMap(){
    var out = {};
    for (var k in S.verdicts){
      var r = S.verdicts[k];
      if (r.user_id === uid && r.verdict) out[r.hip] = r.verdict;
    }
    return out;
  }

  function notesFor(hip){
    var out = [];
    for (var k in S.notes){
      var n = S.notes[k];
      if (n.hip === hip && !n.deleted_at)
        out.push({ id: n.id, hip: n.hip, user_id: n.user_id, text: n.body,
                   ts: Date.parse(n.created_at), edited: n.edited_at ? Date.parse(n.edited_at) : 0 });
    }
    return out.sort(function(a,b){ return a.ts - b.ts; });
  }

  // Lists, each carrying the .hips array the UI has always worked with — even
  // though the database stores one row per item so concurrent adds cannot clobber.
  function allLists(){
    var items = {};
    for (var k in S.list_items){
      var it = S.list_items[k];
      if (it.removed_at) continue;
      (items[it.list_id] = items[it.list_id] || []).push(it);
    }
    var out = [];
    for (var id in S.lists){
      var l = S.lists[id];
      if (l.deleted_at) continue;
      var mine = (items[id] || []).sort(function(a,b){
        return (a.position - b.position) || (Date.parse(a.added_at) - Date.parse(b.added_at));
      });
      out.push({ id: l.id, name: l.name, owner_id: l.owner_id,
                 hips: mine.map(function(x){ return x.hip; }),
                 ts: Date.parse(l.updated_at || l.created_at) });
    }
    return out.sort(function(a,b){ return b.ts - a.ts; });
  }

  function displayName(id){
    var p = S.profiles[id];
    return (p && p.display_name) || 'Someone';
  }
  function people(){
    return Object.keys(S.profiles).map(function(k){ return S.profiles[k]; });
  }

  /* ---------------------------------------------------------------- sync status
     Honest by construction: the numbers come from the queue itself, not a flag
     someone remembered to set. */

  function status(){
    var jobs = pendingJobs();
    return {
      pending:  jobs.length,
      online:   navigator.onLine,
      syncing:  S.syncing,
      lastSync: S.lastSync,
      error:    S.lastError,
      stuck:    jobs.filter(function(j){ return j.tries >= 3; }).length
    };
  }

  /* ---------------------------------------------------------------- lifecycle */

  var pollTimer = null;
  function startSync(){
    stopSync();
    // 25s while the app is in front of you: comfortably inside the "within a
    // minute" the team was promised, without the weight of a realtime socket.
    pollTimer = setInterval(function(){
      if (document.visibilityState === 'visible') sync();
    }, 25000);
    window.addEventListener('online',  onOnline);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('offline', onChange);
  }
  function stopSync(){
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
    window.removeEventListener('offline', onChange);
  }
  function onOnline(){ backoff = 0; onChange(); sync(); }
  function onVisible(){ if (document.visibilityState === 'visible') sync(); }

  var readyP = null;
  function ready(){ return readyP || Promise.resolve(); }

  function init(client, userId, notify){
    sb = client; uid = userId; onChange = notify || function(){};
    readyP = hydrate().then(function(){
      startSync();
      // Deliberately not awaited: the app renders from cache immediately and the
      // network catches up. Nothing on screen waits for a request.
      sync();
    });
    return readyP;
  }

  function reset(){
    stopSync();
    S = { verdicts:{}, notes:{}, lists:{}, list_items:{}, profiles:{}, outbox:{},
          cursors:{}, lastSync:0, syncing:false, lastError:null };
    return db().then(function(d){
      return Promise.all(STORES.map(function(s){
        return tx([s],'readwrite', function(st){ st[0].clear(); });
      }));
    });
  }

  return {
    init: init, ready: ready, settled: settled, reset: reset, sync: sync, flush: flush,
    pull: pull, status: status,
    me: function(){ return uid; },
    setVerdict: setVerdict, addNote: addNote, editNote: editNote, deleteNote: deleteNote,
    newList: newList, renameList: renameList, deleteList: deleteList,
    addToList: addToList, removeFromList: removeFromList, toggleInList: toggleInList,
    verdictsFor: verdictsFor, myVerdict: myVerdict, teamVerdicts: teamVerdicts,
    myVerdictMap: myVerdictMap, notesFor: notesFor, allLists: allLists,
    displayName: displayName, people: people,
    _state: function(){ return S; }
  };
})();
