/* ============================================================================
   auth.js — email and password, and a session that survives a barn.

   Deliberately not magic links. The failure mode for a link is a man standing in
   a shed row with no signal who has been logged out and now needs to receive an
   email to get back in. A password works against a cached session and, if it
   comes to it, can be typed from memory.
   ========================================================================== */

var Auth = (function(){

  var sb = null;
  var signingOut = false;

  function client(){
    if (!sb){
      var c = window.SALEBOOK_CONFIG;
      sb = supabase.createClient(c.supabaseUrl, c.supabaseKey, {
        auth: {
          persistSession: true,        // survives a force-quit on the home screen
          autoRefreshToken: true,
          detectSessionInUrl: false
        }
      });
    }
    return sb;
  }

  // Reads the session out of localStorage; no network, so this resolves offline.
  function session(){
    return client().auth.getSession().then(function(r){ return r.data.session; });
  }

  function signIn(email, password){
    return client().auth.signInWithPassword({
      email: String(email || '').trim(),
      password: String(password || '')
    });
  }

  function signOut(){
    signingOut = true;
    return client().auth.signOut();
  }

  // A failed token refresh offline must NOT look like a sign-out — that is exactly
  // how a day's work gets locked behind a login screen with no signal to satisfy it.
  function onAuthChange(fn){
    client().auth.onAuthStateChange(function(event, sess){
      if (event === 'SIGNED_OUT' && !signingOut && !navigator.onLine) return;
      fn(event, sess);
    });
  }

  function friendlyError(err){
    var m = String(err && err.message || err || '');
    if (/Invalid login credentials/i.test(m)) return 'That email and password do not match.';
    if (/Email not confirmed/i.test(m))       return 'That account is not confirmed yet. Ask Perry.';
    if (/fetch|network|Failed to fetch/i.test(m))
      return 'No connection. Signing in for the first time needs signal — once you are in, the app works offline.';
    return m || 'Could not sign in.';
  }

  /* ---------------------------------------------------------------- screen */

  function screen(state){
    state = state || {};
    return '<div class="bar"><h1>West Paces</h1></div>'
      + '<div style="padding:28px 20px 6px">'
      +   '<div style="font-size:22px;font-weight:600;letter-spacing:-.02em">Keeneland September</div>'
      +   '<div class="sub" style="margin-top:6px;font-size:13.5px">4,642 yearlings. Sign in once — '
      +     'the app remembers you, and keeps working when the signal does not.</div>'
      + '</div>'
      + '<form id="authform" style="padding:14px 20px 0">'
      +   '<div class="pgh">EMAIL</div>'
      +   '<input id="authemail" class="noteinput" type="email" inputmode="email" autocomplete="username" '
      +     'autocapitalize="none" autocorrect="off" spellcheck="false" '
      +     'style="width:100%;height:52px;border-style:solid;font-size:16px" value="' + esc(state.email || '') + '">'
      +   '<div class="pgh" style="margin-top:16px">PASSWORD</div>'
      +   '<input id="authpw" class="noteinput" type="password" autocomplete="current-password" '
      +     'style="width:100%;height:52px;border-style:solid;font-size:16px">'
      +   (state.error
          ? '<div style="margin-top:14px;padding:12px 14px;border:1.5px solid var(--out);background:var(--outT);'
            + 'border-radius:8px;font-size:13px;line-height:1.45;color:var(--out)">' + esc(state.error) + '</div>'
          : '')
      +   '<button class="btn" id="authgo" type="submit" data-authgo="1" style="width:100%;margin-top:18px;height:52px">'
      +     (state.busy ? 'Signing in…' : 'Sign in') + '</button>'
      +   '<div class="sub" style="margin-top:16px;font-size:12.5px;line-height:1.5">'
      +     'Accounts are set up by Perry. If you cannot get in, text him — there is no '
      +     '“forgot password” email on this system by design.</div>'
      + '</form>';
  }

  return { client: client, session: session, signIn: signIn, signOut: signOut,
           onAuthChange: onAuthChange, screen: screen, friendlyError: friendlyError };
})();
