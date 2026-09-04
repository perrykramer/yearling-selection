/* ============================================================================
   A small, faithful stand-in for the Supabase endpoints this app uses.

   Why it exists: it lets the offline and sync behaviour be tested end to end
   without touching the real project's data, and it runs in CI or on a plane.
   It implements only what store.js and auth.js actually call — password grant,
   token refresh, and PostgREST select/upsert with the `updated_at=gt.` filter
   that drives incremental pull.

   It is a test fixture, not a server. No security, no persistence.
   ========================================================================== */

var http = require('http');
var url  = require('url');

function start(port, opts){
  opts = opts || {};
  var users = opts.users || {};            // email -> {id, password, display_name}
  var tables = {                           // table -> { key -> row }
    profiles: {}, verdicts: {}, notes: {}, lists: {}, list_items: {}, horse_pages: {}
  };
  var log = [];

  Object.keys(users).forEach(function(email){
    var u = users[email];
    tables.profiles[u.id] = { id: u.id, display_name: u.display_name,
                              created_at: iso(), updated_at: iso() };
  });

  function iso(){ return new Date().toISOString(); }

  // Matches the primary keys in db/001_schema.sql.
  function pk(table, row){
    if (table === 'verdicts')   return row.hip + ':' + row.user_id;
    if (table === 'list_items') return row.list_id + ':' + row.hip;
    if (table === 'horse_pages') return String(row.hip);
    return row.id;
  }

  var clock = 0;
  function stamp(){
    // Strictly increasing so the `gt` cursor can never skip a row written in the
    // same millisecond — the real database has the same property via now().
    clock++;
    return new Date(Date.now() + clock).toISOString();
  }

  function send(res, code, body, extra){
    var h = Object.assign({
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Expose-Headers': '*'
    }, extra || {});
    res.writeHead(code, h);
    res.end(body == null ? '' : JSON.stringify(body));
  }

  function session(u){
    return {
      access_token: 'fake.' + u.id, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now()/1000) + 3600,
      refresh_token: 'refresh.' + u.id,
      user: { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
              email_confirmed_at: iso(), created_at: iso(), updated_at: iso(),
              app_metadata: { provider: 'email', providers: ['email'] },
              user_metadata: { display_name: u.display_name }, identities: [] }
    };
  }

  function userFromAuth(req){
    var a = req.headers.authorization || '';
    var id = a.replace(/^Bearer\s+fake\./, '');
    for (var e in users) if (users[e].id === id) return users[e];
    return null;
  }

  var server = http.createServer(function(req, res){
    var u = url.parse(req.url, true);
    var body = '';
    req.on('data', function(d){ body += d; });
    req.on('end', function(){
      if (req.method === 'OPTIONS') return send(res, 204, null);
      log.push({ method: req.method, path: u.pathname, query: u.query });

      if (opts.fail) return send(res, 503, { message: 'service unavailable' });

      /* ---------------------------------------------------------- auth */
      if (u.pathname === '/auth/v1/token'){
        var b = {};
        try { b = JSON.parse(body || '{}'); } catch(e){}
        if (u.query.grant_type === 'refresh_token'){
          var rid = String(b.refresh_token || '').replace(/^refresh\./, '');
          for (var e2 in users) if (users[e2].id === rid) return send(res, 200, session(users[e2]));
          return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
        }
        var acc = users[String(b.email || '').toLowerCase()];
        if (!acc || acc.password !== b.password)
          return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials',
                                  message: 'Invalid login credentials' });
        return send(res, 200, session(acc));
      }
      if (u.pathname === '/auth/v1/user'){
        var me = userFromAuth(req);
        if (!me) return send(res, 401, { message: 'invalid claim' });
        return send(res, 200, session(me).user);
      }
      if (u.pathname === '/auth/v1/logout') return send(res, 204, null);

      /* ---------------------------------------------------------- rest */
      var m = u.pathname.match(/^\/rest\/v1\/(\w+)$/);
      if (m){
        var table = m[1];
        if (!tables[table]) return send(res, 404, { message: 'no such table' });
        var caller = userFromAuth(req);
        if (!caller) return send(res, 401, { message: 'JWT required' });   // mirrors RLS: anon sees nothing

        if (req.method === 'GET'){
          var rows = Object.keys(tables[table]).map(function(k){ return tables[table][k]; });
          if (u.query.updated_at){
            var mm = String(u.query.updated_at).match(/^gt\.(.+)$/);
            if (mm) rows = rows.filter(function(r){ return r.updated_at > mm[1]; });
          }
          rows.sort(function(a,b){ return a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0; });
          if (u.query.limit) rows = rows.slice(0, parseInt(u.query.limit, 10));
          return send(res, 200, rows);
        }

        if (req.method === 'POST'){
          var payload = [];
          try { payload = JSON.parse(body || '[]'); } catch(err){ return send(res, 400, { message: 'bad json' }); }
          if (!Array.isArray(payload)) payload = [payload];
          var authorCol = table === 'verdicts' || table === 'notes' ? 'user_id'
                        : table === 'list_items' ? 'added_by'
                        : table === 'lists' ? 'owner_id' : null;
          var saved = [];
          for (var i=0;i<payload.length;i++){
            var row = payload[i];
            // The one thing RLS does not let you forge: authorship.
            if (authorCol && row[authorCol] && row[authorCol] !== caller.id)
              return send(res, 403, { code: '42501', message: 'new row violates row-level security policy' });
            var key = pk(table, row);
            var prev = tables[table][key] || {};
            var next = Object.assign({}, prev, row, { updated_at: stamp() });
            tables[table][key] = next;
            saved.push(next);
          }
          var prefer = req.headers.prefer || '';
          return send(res, 201, /return=representation/.test(prefer) ? saved : null);
        }
      }

      send(res, 404, { message: 'not found' });
    });
  });

  return new Promise(function(resolve){
    server.listen(port, '127.0.0.1', function(){
      resolve({
        server: server,
        tables: tables,
        log: log,
        rows: function(t){ return Object.keys(tables[t]).map(function(k){ return tables[t][k]; }); },
        setFail: function(v){ opts.fail = v; },
        close: function(){ return new Promise(function(r){ server.close(r); }); }
      });
    });
  });
}

module.exports = { start: start };
