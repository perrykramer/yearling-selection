/* Minimal static server for public/ — the same files Vercel will serve. */
var http = require('http'), fs = require('fs'), path = require('path'), url = require('url');

var TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
              '.json':'application/json', '.woff2':'font/woff2', '.png':'image/png',
              '.webmanifest':'application/manifest+json' };

function start(port, root){
  var server = http.createServer(function(req, res){
    var p = decodeURIComponent(url.parse(req.url).pathname);

    // Vercel with cleanUrls answers /index.html with a 308 to /. Reproduce that here —
    // a cached redirected response cannot serve a navigation, so a service worker that
    // precaches 'index.html' will fail to open offline in production while passing
    // against a naive local server. The fixture is deliberately stricter than the edge.
    if (p === '/index.html'){
      res.writeHead(308, { Location: '/' });
      return res.end();
    }
    if (p === '/' ) p = '/index.html';
    var file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, function(err, buf){
      if (err){ res.writeHead(404); return res.end('not found'); }
      var h = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' };
      // index.html and sw.js must never be cached by the browser, per vercel.json.
      if (/index\.html$|sw\.js$/.test(file)) h['Cache-Control'] = 'no-cache';
      res.writeHead(200, h);
      res.end(buf);
    });
  });
  return new Promise(function(r){ server.listen(port, '127.0.0.1', function(){ r(server); }); });
}
module.exports = { start: start };
