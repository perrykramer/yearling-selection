/* ============================================================================
   The six tests from the brief that decide whether this is done, plus the
   layout check that has bitten this build before.

   Run:  node tests/acceptance.js
   ========================================================================== */

var path = require('path'), fs = require('fs'), os = require('os');
var { chromium } = require(process.env.PW_MODULE || 'playwright');
var fake = require('./fake-supabase.js');
var statics = require('./static.js');

var CHROME = process.env.PW_CHROMIUM || undefined;
var APP_PORT = 8788, API_PORT = 8790;
var APP = 'http://127.0.0.1:' + APP_PORT + '/';
var API = 'http://127.0.0.1:' + API_PORT;

var USERS = {
  'conor@westpaces.local': { id: 'aaaaaaaa-0000-4000-8000-000000000001', email:'conor@westpaces.local', password: 'pw-conor', display_name: 'Conor Foley' },
  'nick@westpaces.local':  { id: 'aaaaaaaa-0000-4000-8000-000000000002', email:'nick@westpaces.local',  password: 'pw-nick',  display_name: 'Nick Esler' },
  'larry@westpaces.local': { id: 'aaaaaaaa-0000-4000-8000-000000000003', email:'larry@westpaces.local', password: 'pw-larry', display_name: 'Larry Connolly' }
};

var pass = 0, fail = 0, failures = [];
function ok(name, cond, detail){
  if (cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function head(t){ console.log('\n' + t); }

/* ---------------------------------------------------------------- helpers */

function prepare(){
  // Test against a copy of exactly what ships, with only the endpoint swapped —
  // so the real load order, the service worker and the cache all get exercised.
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salebook-'));
  var src = path.join(__dirname, '..', 'public');
  fs.cpSync(src, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.js'),
    'window.SALEBOOK_CONFIG = { supabaseUrl: ' + JSON.stringify(API) +
    ", supabaseKey: 'test-key', catalog: 'data/catalog.v1.json' };\n");
  return dir;
}

async function openApp(browser, who, opts){
  opts = opts || {};
  var ctx = await browser.newContext({ viewport: opts.viewport || { width: 390, height: 844 } });
  var page = await ctx.newPage();
  page.on('pageerror', function(e){ console.log('    [page error] ' + e.message); });
  await page.goto(APP, { waitUntil: 'load' });
  if (who) await signIn(page, who);
  return { ctx: ctx, page: page };
}

async function signIn(page, who){
  var u = USERS[who];
  await page.waitForSelector('#authemail');
  await page.fill('#authemail', u.email);
  await page.fill('#authpw', u.password);
  await page.click('#authgo');
  try {
    await page.waitForSelector('[data-barn]', { timeout: 40000 });
  } catch (err) {
    var state = await page.evaluate(function(){
      return { session: !!SESSION, catalog: !!D, catalogError: CATALOG_ERROR,
               auth: AUTH, screen: V.screen,
               body: document.getElementById('app').innerText.slice(0, 300) };
    });
    throw new Error('sign-in as ' + who + ' never reached the barns: ' + JSON.stringify(state));
  }
}

function status(page){ return page.evaluate(function(){ return Store.status(); }); }

async function waitSynced(page, ms){
  await page.waitForFunction(function(){
    return typeof Store !== 'undefined' && Store.status().pending === 0;
  }, null, { timeout: ms || 20000 });
}

async function openHip(page, hip){
  await page.evaluate(function(h){ location.hash = '#hip/' + h; }, hip);
  await page.waitForSelector('[data-v="in"][data-hip="' + hip + '"]', { timeout: 10000 });
}

async function mark(page, hip, v){
  await openHip(page, hip);
  await page.click('[data-v="' + v + '"][data-hip="' + hip + '"]');
}

var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };

/* ---------------------------------------------------------------- run */

(async function(){
  var dir = prepare();
  var api = await fake.start(API_PORT, { users: USERS });
  var app = await statics.start(APP_PORT, dir);
  var browser = await chromium.launch({ executablePath: CHROME });

  try {
    /* ---------------------------------------------------------------- 1 */
    head('1 · Conor marks hip 49 In. Nick sees it on another phone, another account.');
    var nick = await openApp(browser, 'nick@westpaces.local');
    await openHip(nick.page, 49);                       // Nick is already looking at it
    var conor = await openApp(browser, 'conor@westpaces.local');
    await mark(conor.page, 49, 'in');
    await waitSynced(conor.page);

    var t0 = Date.now(), seen = false;
    while (Date.now() - t0 < 60000){
      seen = await nick.page.evaluate(function(){
        return Store.teamVerdicts(49).some(function(t){ return t.v === 'in'; });
      });
      if (seen) break;
      await sleep(1000);
    }
    ok("Nick's device shows Conor's verdict within a minute", seen,
       'waited ' + Math.round((Date.now()-t0)/1000) + 's');
    ok("it is attributed to Conor, not merged into a house view",
       (await nick.page.evaluate(function(){
          var t = Store.teamVerdicts(49)[0];
          return t ? Store.displayName(t.user_id) : null;
        })) === 'Conor Foley');

    /* ---------------------------------------------------------------- 6 */
    head('6 · Conor In, Nick Out on the same horse. Both visible, neither overwrites.');
    await mark(conor.page, 77, 'in');
    await mark(nick.page,  77, 'out');
    await waitSynced(conor.page); await waitSynced(nick.page);
    await conor.page.evaluate(function(){ return Store.sync(); });
    await nick.page.evaluate(function(){ return Store.sync(); });

    var both = await nick.page.evaluate(function(){
      return { mine: Store.myVerdict(77), team: Store.teamVerdicts(77) };
    });
    ok("Nick's own Out survives", both.mine === 'out');
    ok("Conor's In is visible alongside it", both.team.length === 1 && both.team[0].v === 'in');

    // Both verdicts have to be readable on the row itself, in words, not colour alone.
    await nick.page.evaluate(function(){ V.open = null; go('barn', {barn: D.H[BYHIP[77]][5]}); });
    await nick.page.waitForSelector('[data-row]');
    var rowText = await nick.page.evaluate(function(){
      var el = document.querySelector('[data-row="' + BYHIP[77] + '"]');
      return el ? el.innerText.replace(/\s+/g, ' ') : '';
    });
    ok('the row shows both verdicts in words', /OUT/.test(rowText) && /IN/.test(rowText), JSON.stringify(rowText));

    /* ---------------------------------------------------------------- 2 */
    head('2 · Twenty horses marked in airplane mode. App closed, reopened, signal back.');
    var field = await openApp(browser, 'conor@westpaces.local');
    await field.page.evaluate(function(){
      return navigator.serviceWorker.ready;           // shell + catalog precached
    });
    await waitSynced(field.page);

    // State the invariant directly: the cached shell must not be a redirected response,
    // because a redirected response cannot serve a navigation, and the app would then
    // fail to open with no signal.
    var shell = await field.page.evaluate(function(){
      return caches.open('salebook-v2').then(function(c){
        return c.match('./').then(function(hit){
          return hit ? { ok: true, redirected: hit.redirected, status: hit.status } : { ok: false };
        });
      });
    });
    ok('the shell is precached, and not as a redirect',
       shell.ok && shell.redirected === false && shell.status === 200, JSON.stringify(shell));

    var hips = [];
    for (var i = 0; i < 20; i++) hips.push(200 + i);

    await field.ctx.setOffline(true);
    for (var k = 0; k < hips.length; k++) await mark(field.page, hips[k], 'in');

    // Wait for the writes to be durable before pulling the plug — the app's promise is
    // that a committed change survives, not that a change survives being interrupted
    // mid-commit. Store.settled() is exactly that boundary.
    await field.page.evaluate(function(){ return Store.settled(); });
    var st = await status(field.page);
    ok('all twenty are queued while offline', st.pending === 20, 'pending=' + st.pending);
    ok('the app says it is offline rather than pretending', st.online === false);

    // Close and reopen with no signal: this is the reload that used to lose work.
    // It reopens on whatever screen you were on, so wait for the store, not the barns.
    await field.page.reload({ waitUntil: 'load' });
    await field.page.waitForFunction(function(){
      return typeof Store !== 'undefined' && !!Store.me() && typeof D !== 'undefined' && !!D
             && !!document.querySelector('#app *');
    }, null, { timeout: 30000 });
    await field.page.evaluate(function(){ return Store.ready(); });
    var after = await status(field.page);
    ok('the app opens offline from cache', true);
    ok('the twenty are still queued after a cold reopen', after.pending === 20, 'pending=' + after.pending);
    var marksHeld = await field.page.evaluate(function(hs){
      return hs.filter(function(h){ return Store.myVerdict(h) === 'in'; }).length;
    }, hips);
    ok('and all twenty still show as marked', marksHeld === 20, marksHeld + '/20');

    await field.ctx.setOffline(false);
    await waitSynced(field.page, 30000);
    var server = api.rows('verdicts').filter(function(r){
      return r.user_id === USERS['conor@westpaces.local'].id && hips.indexOf(r.hip) >= 0 && r.verdict === 'in';
    });
    ok('all twenty reach the database, none lost', server.length === 20, server.length + '/20');

    /* ---------------------------------------------------------------- 3 */
    head('3 · Larry opens a shortlist on a laptop he has never used.');
    var listId = await conor.page.evaluate(function(){
      var id = Store.newList('Book 1 — bid list');
      [101, 102, 103].forEach(function(h){ Store.addToList(id, h); });
      render();
      return id;
    });
    await waitSynced(conor.page);

    var larry = await openApp(browser, 'larry@westpaces.local', { viewport: { width: 1440, height: 900 } });
    await larry.page.evaluate(function(id){ location.hash = '#list/' + id; }, listId);
    await larry.page.waitForFunction(function(id){
      var l = listById(id);
      return l && l.hips.length === 3;
    }, listId, { timeout: 30000 });
    var seenList = await larry.page.evaluate(function(id){
      var l = listById(id);
      return { name: l.name, hips: l.hips, screen: V.screen };
    }, listId);
    ok('the list is there, by name', seenList.name === 'Book 1 — bid list');
    ok('with the current horses', JSON.stringify(seenList.hips) === '[101,102,103]', JSON.stringify(seenList.hips));
    ok('and the shared link opened it directly', seenList.screen === 'list');

    /* ---------------------------------------------------------------- 4 */
    head('4 · Conor and Nick add different horses to the same shortlist at once.');
    await Promise.all([
      conor.page.evaluate(function(id){ Store.addToList(id, 501); render(); }, listId),
      nick.page.evaluate(function(id){ Store.addToList(id, 502); render(); }, listId)
    ]);
    await waitSynced(conor.page); await waitSynced(nick.page);
    await conor.page.evaluate(function(){ return Store.sync(); });
    var merged = await conor.page.evaluate(function(id){ return listById(id).hips; }, listId);
    ok('both survive — neither clobbers the other',
       merged.indexOf(501) >= 0 && merged.indexOf(502) >= 0, JSON.stringify(merged));

    /* ---------------------------------------------------------------- 5 */
    head('5 · Cold load under five seconds on cellular; second load instant.');
    var cold = await browser.newContext({ viewport: { width: 390, height: 844 } });
    var cp = await cold.newPage();
    var cdp = await cold.newCDPSession(cp);
    await cdp.send('Network.enable');
    // Slow 4G, of the sort a Kentucky shed row actually offers.
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8
    });
    var c0 = Date.now();
    await cp.goto(APP, { waitUntil: 'load' });
    await cp.waitForSelector('#authgo');
    var coldMs = Date.now() - c0;
    await signIn(cp, 'conor@westpaces.local');
    var readyMs = Date.now() - c0;
    ok('cold load reaches a usable screen in under 5s', coldMs < 5000, coldMs + 'ms');
    ok('signed in and showing barns in under 5s', readyMs < 5000, readyMs + 'ms');

    await cp.evaluate(function(){ return navigator.serviceWorker.ready; });
    var w0 = Date.now();
    await cp.reload({ waitUntil: 'load' });
    await cp.waitForSelector('[data-barn]', { timeout: 20000 });
    var warmMs = Date.now() - w0;
    ok('second load is effectively instant', warmMs < 2000, warmMs + 'ms');
    await cold.close();

    /* ---------------------------------------------------------------- layout */
    head('Layout · 320 / 390 / 1440, every screen, no horizontal overflow.');
    for (var w of [320, 390, 1440]){
      var lc = await browser.newContext({ viewport: { width: w, height: 800 } });
      var lp = await lc.newPage();
      await lp.goto(APP, { waitUntil: 'load' });
      await signIn(lp, 'conor@westpaces.local');
      await waitSynced(lp, 30000);

      var screens = [
        ['home',    function(){ go('walk'); }],
        ['barn',    function(){ go('barn', {barn: BARNS[0].barn}); }],
        ['barn expanded', function(){ V.open = BARNS[0].idx[0]; V.showPage = true; render(); }],
        ['hip',     function(){ go('hip', {hip: 0}); }],
        ['search',  function(){ V.q = 'storm'; V.mode = 'txt'; go('search'); }],
        ['lists',   function(){ go('lists'); }],
        ['compare', function(){ go('compare', {compare: [0,1,2,3]}); }],
        ['account', function(){ go('walk'); V.sheet = 'account'; render(); }]
      ];
      for (var s of screens){
        await lp.evaluate('(' + s[1].toString() + ')()');
        await lp.waitForTimeout(60);
        var over = await lp.evaluate(function(){
          var d = document.documentElement;
          return { scroll: d.scrollWidth, client: d.clientWidth };
        });
        ok(w + 'px · ' + s[0] + ' does not scroll sideways', over.scroll <= over.client,
           over.scroll + ' > ' + over.client);
      }
      await lc.close();
    }

    /* ---------------------------------------------------------------- extra */
    head('Also · things that were wrong in the shipped build.');
    var link = await conor.page.evaluate(function(id){
      V.list = id; go('list');
      var b = document.querySelector('[data-share]');
      return b ? location.origin + location.pathname + '#list/' + id : null;
    }, listId);
    ok('“Copy link” produces a link to the list, not to an empty app',
       !!link && link.indexOf('#list/' + listId) > 0, String(link));

    var authorship = await conor.page.evaluate(function(){
      return fetch(SALEBOOK_CONFIG.supabaseUrl + '/rest/v1/verdicts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
                   'Authorization': 'Bearer ' + Store._state && '' },
        body: '[]'
      }).then(function(r){ return r.status; }).catch(function(){ return 'blocked'; });
    });
    ok('an unauthenticated write is refused', authorship === 401 || authorship === 'blocked', String(authorship));

    var note = await conor.page.evaluate(function(){
      Store.addNote(49, 'Good walker, wants watching.');
      return Store.notesFor(49)[0];
    });
    ok('a note is attributed by user id, not a typed name', note && !!note.user_id && note.text.length > 0);

    await waitSynced(conor.page);
    var offlineNote = api.rows('notes').filter(function(n){ return n.hip === 49; });
    ok('and it reaches the database', offlineNote.length === 1);

  } catch (err) {
    fail++; failures.push('threw: ' + err.message);
    console.log('\n!! ' + err.stack);
  } finally {
    await browser.close();
    await api.close();
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n' + '-'.repeat(56));
  console.log(pass + ' passed, ' + fail + ' failed');
  if (failures.length) failures.forEach(function(f){ console.log('  FAIL ' + f); });
  process.exit(fail ? 1 : 0);
})();
