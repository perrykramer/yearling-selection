/* Local development: serves public/ against the real Supabase project.
   For a run that touches no live data, use `npm test`, which serves the same
   files against the stub in tests/fake-supabase.js. */
var statics = require('../tests/static.js');
var path = require('path');
var port = process.env.PORT || 8080;
statics.start(port, path.join(__dirname, '..', 'public')).then(function(){
  console.log('Sale Book on http://127.0.0.1:' + port);
});
