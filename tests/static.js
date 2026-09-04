/* Minimal static server for public/ — the same files Vercel will serve. */
var http = require('http'), fs = require('fs'), path = require('path'), url = require('url');

var TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
              '.json':'application/json', '.woff2':'font/woff2', '.png':'image/png',
              '.webmanifest':'application/manifest+json' };

function start(port, root){
  var server = http.createServer(function(req, res){
    var p = decodeURIComponent(url.parse(req.url).pathname);
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
