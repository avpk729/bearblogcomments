'use strict';

/*
 * Owner dashboard: magic-link sign-in, site management, embed snippets, and the
 * end-to-end-encrypted moderation queue.
 *
 * The encryption passphrase NEVER leaves this page. On "set up" we derive a
 * keypair in-browser and upload only the public key + salt + KDF params. On
 * "unlock" we re-derive, verify the derived public key matches the stored one,
 * then decrypt pending comments locally for the owner to approve.
 */

var ORIGIN = window.location.origin;

// In-memory keypairs per site (cleared on reload). Never persisted.
var keys = {}; // site_id -> { keypair, key }

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function api(path, opts) {
  opts = opts || {};
  return fetch(path, opts).then(function (r) {
    return r.json().then(function (b) {
      if (!r.ok) throw new Error(b && b.error ? b.error : 'Request failed');
      return b;
    }).catch(function (e) {
      if (e instanceof SyntaxError) throw new Error('Request failed (' + r.status + ')');
      throw e;
    });
  });
}

function planBadge(site) {
  var s = site.plan_status;
  if (s === 'lifetime' || s === 'active') return '<span class="badge ok">' + esc(s) + '</span>';
  if (s === 'past_due') return '<span class="badge warn">past due</span>';
  return '<span class="badge bad">' + esc(s) + '</span>';
}

function snippet(site, mode, targetId) {
  return (
    '<div id="' + targetId + '"></div>\n' +
    '<script src="' + ORIGIN + '/embed.js"\n' +
    '        data-site-id="' + esc(site.site_id) + '"\n' +
    '        data-mode="' + mode + '"\n' +
    '        data-target="' + targetId + '"></scr' + 'ipt>'
  );
}

function siteCard(site) {
  return (
    '<div class="card" data-site="' + esc(site.site_id) + '">' +
    '<div class="row" style="justify-content:space-between">' +
    '<strong>' + esc(site.name) + '</strong>' + planBadge(site) +
    '</div>' +
    '<div class="muted" style="margin:0.3rem 0">site id: <code>' + esc(site.site_id) + '</code></div>' +
    (!['active', 'lifetime', 'past_due'].includes(site.plan_status)
      ? '<div class="msg" style="opacity:.8">This site isn\'t active yet — it won\'t accept new comments until you subscribe (billing coming soon).</div>'
      : '') +
    '<details><summary>Embed snippets</summary>' +
    '<label>Per-post comments (POST template):</label>' +
    '<pre>' + esc(snippet(site, 'post', 'comments')) + '</pre>' +
    '<label>Per-blog guestbook (a PAGE):</label>' +
    '<pre>' + esc(snippet(site, 'guestbook', 'guestbook')) + '</pre>' +
    '</details>' +
    '<div class="mod" data-site="' + esc(site.site_id) + '" style="margin-top:0.9rem">' +
    '<div class="muted">Loading moderation…</div></div>' +
    '</div>'
  );
}

function renderSites(sites) {
  var host = $('sites');
  if (!sites.length) { host.innerHTML = '<p class="muted">No sites yet. Create your first one below.</p>'; return; }
  host.innerHTML = sites.map(siteCard).join('');
  sites.forEach(function (site) { initMod(site); });
}

// ── Per-site moderation panel ───────────────────────────────────────────────

function modEl(siteId) { return document.querySelector('.mod[data-site="' + siteId + '"]'); }

function initMod(site) {
  var el = modEl(site.site_id);
  api('/api/sites/' + site.site_id + '/key')
    .then(function (data) { renderUnlock(site, data.key); })
    .catch(function (e) {
      if (/No key set|404/.test(e.message)) renderSetup(site);
      else el.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>';
    });
}

function renderSetup(site) {
  var el = modEl(site.site_id);
  el.innerHTML =
    '<strong>Set up encryption</strong>' +
    '<p class="muted">Choose a passphrase. Visitor comments will be encrypted to it; only you can read them. ' +
    '<b>It is never sent to us and cannot be recovered</b> — if you lose it, pending comments are unreadable (published ones are unaffected).</p>' +
    '<label>Encryption passphrase</label><input type="password" class="set-pass" placeholder="a strong passphrase" />' +
    '<label>Confirm passphrase</label><input type="password" class="set-pass2" placeholder="repeat it" />' +
    '<label style="display:flex;gap:0.5rem;align-items:center;margin-top:0.6rem"><input type="checkbox" class="set-ack" style="width:auto" /> I understand it can\'t be recovered.</label>' +
    '<div class="row" style="margin-top:0.6rem"><button class="primary set-go">Enable encryption</button></div>' +
    '<div class="msg set-msg"></div>';
  el.querySelector('.set-go').addEventListener('click', function () { doSetup(site, el); });
}

function doSetup(site, el) {
  var p1 = el.querySelector('.set-pass').value;
  var p2 = el.querySelector('.set-pass2').value;
  var ack = el.querySelector('.set-ack').checked;
  var msg = el.querySelector('.set-msg');
  msg.className = 'msg';
  if (p1.length < 8) { msg.className = 'msg err'; msg.textContent = 'Use at least 8 characters.'; return; }
  if (p1 !== p2) { msg.className = 'msg err'; msg.textContent = 'Passphrases do not match.'; return; }
  if (!ack) { msg.className = 'msg err'; msg.textContent = 'Please confirm you understand recovery is impossible.'; return; }
  msg.textContent = 'Deriving key (this can take a few seconds)…';

  BBCrypto.load().then(function (bb) {
    var salt = bb.generateSalt();
    var kp = bb.deriveKeypair(p1, salt, bb.DEFAULT_OPS, bb.DEFAULT_MEM);
    return api('/api/sites/' + site.site_id + '/key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        public_key: kp.publicKeyB64, salt: salt,
        kdf_opslimit: bb.DEFAULT_OPS, kdf_memlimit: bb.DEFAULT_MEM, kdf_algo: 'argon2id13',
      }),
    }).then(function () {
      offerRecovery(kp.seedB64);
      keys[site.site_id] = { keypair: kp };
      // Transition straight to the (empty) moderation queue — its appearance is
      // the success signal. (Setting a message here would be lost on re-render.)
      renderQueue(site, []);
    });
  }).catch(function (e) { msg.className = 'msg err'; msg.textContent = e.message || 'Setup failed.'; });
}

function offerRecovery(seedB64) {
  var blob = new Blob(
    ['Bear Blog Comments — recovery code\n\nKeep this secret and safe. It can re-derive your\n' +
     'decryption key if you forget your passphrase.\n\n' + seedB64 + '\n'],
    { type: 'text/plain' }
  );
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'comments-recovery-code.txt';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function renderUnlock(site, key) {
  var el = modEl(site.site_id);
  if (keys[site.site_id] && keys[site.site_id].keypair) { loadQueue(site); return; }
  el.innerHTML =
    '<strong>Moderation</strong>' +
    '<p class="muted">Enter your passphrase to decrypt and review pending comments. It stays in this browser.</p>' +
    '<label>Passphrase</label><input type="password" class="unlock-pass" placeholder="your passphrase" />' +
    '<div class="row" style="margin-top:0.6rem"><button class="primary unlock-go">Unlock</button>' +
    '<button class="recover-toggle">Use recovery code</button></div>' +
    '<div class="recover-box hidden" style="margin-top:0.6rem">' +
    '<label>Recovery code (from the file you saved at setup)</label>' +
    '<textarea class="recover-seed" rows="2" placeholder="paste your recovery code"></textarea>' +
    '<div class="row" style="margin-top:0.5rem"><button class="primary recover-go">Recover &amp; unlock</button></div>' +
    '</div>' +
    '<div class="msg unlock-msg"></div>';
  el.dataset.key = JSON.stringify(key);
  el.querySelector('.unlock-go').addEventListener('click', function () { doUnlock(site, el, key); });
  el.querySelector('.unlock-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doUnlock(site, el, key); });
  el.querySelector('.recover-toggle').addEventListener('click', function () { el.querySelector('.recover-box').classList.toggle('hidden'); });
  el.querySelector('.recover-go').addEventListener('click', function () { doRecover(site, el, key); });
}

function doRecover(site, el, key) {
  var seed = el.querySelector('.recover-seed').value.trim();
  var msg = el.querySelector('.unlock-msg');
  if (!seed) { msg.className = 'msg err'; msg.textContent = 'Paste your recovery code.'; return; }
  msg.className = 'msg'; msg.textContent = 'Checking recovery code…';
  BBCrypto.load().then(function (bb) {
    var kp;
    try { kp = bb.keypairFromSeed(seed); }
    catch (e) { msg.className = 'msg err'; msg.textContent = 'That recovery code is not valid.'; return; }
    if (kp.publicKeyB64 !== key.public_key) {
      msg.className = 'msg err'; msg.textContent = 'That recovery code does not match this site’s key.';
      return;
    }
    keys[site.site_id] = { keypair: kp, key: key };
    loadQueue(site);
  }).catch(function (e) { msg.className = 'msg err'; msg.textContent = e.message || 'Recovery failed.'; });
}

function doUnlock(site, el, key) {
  var pass = el.querySelector('.unlock-pass').value;
  var msg = el.querySelector('.unlock-msg');
  if (!pass) { msg.className = 'msg err'; msg.textContent = 'Enter your passphrase.'; return; }
  msg.className = 'msg'; msg.textContent = 'Deriving key…';
  BBCrypto.load().then(function (bb) {
    var kp = bb.deriveKeypair(pass, key.salt, key.kdf_opslimit, key.kdf_memlimit);
    if (kp.publicKeyB64 !== key.public_key) {
      msg.className = 'msg err'; msg.textContent = 'Wrong passphrase.';
      return;
    }
    keys[site.site_id] = { keypair: kp, key: key };
    loadQueue(site);
  }).catch(function (e) { msg.className = 'msg err'; msg.textContent = e.message || 'Unlock failed.'; });
}

function loadQueue(site) {
  var el = modEl(site.site_id);
  el.innerHTML = '<strong>Moderation</strong><div class="muted">Loading pending comments…</div>';
  api('/api/sites/' + site.site_id + '/pending')
    .then(function (data) { renderQueue(site, data.pending || []); })
    .catch(function (e) { el.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
}

function renderQueue(site, rows) {
  var el = modEl(site.site_id);
  var bb = window.BBCrypto;
  var kp = keys[site.site_id].keypair;
  var pending = rows.filter(function (r) { return r.status === 'pending'; });

  var items = pending.map(function (r) {
    var decoded;
    try { decoded = bb.open(r.ciphertext, kp); }
    catch (e) { decoded = { name: '(could not decrypt — different key version)', body: '' }; }
    return (
      '<div class="card" data-id="' + r.id + '" style="margin:0.6rem 0">' +
      '<div class="muted">' + new Date(r.created_at).toLocaleString() + (r.parent_id ? ' · reply' : '') + '</div>' +
      '<div><b>' + esc(decoded.name || 'Anonymous') + '</b></div>' +
      '<div style="white-space:pre-wrap;margin:0.3rem 0">' + esc(decoded.body) + '</div>' +
      '<div class="row">' +
      '<button class="primary act" data-act="publish" data-id="' + r.id + '">Approve &amp; publish</button>' +
      '<button class="act" data-act="reject" data-id="' + r.id + '">Reject</button>' +
      '<button class="act" data-act="delete" data-id="' + r.id + '">Delete</button>' +
      '</div></div>'
    );
  }).join('');

  el.innerHTML =
    '<div class="row" style="justify-content:space-between">' +
    '<strong>Moderation — ' + pending.length + ' pending</strong>' +
    '<button class="act-refresh">Refresh</button></div>' +
    (pending.length ? items : '<div class="muted">No pending comments.</div>');

  // Stash decrypted text on the node so publish can send plaintext back.
  pending.forEach(function (r) {
    var node = el.querySelector('.card[data-id="' + r.id + '"]');
    if (!node) return;
    try { node._decoded = bb.open(r.ciphertext, kp); } catch (e) { node._decoded = null; }
  });

  el.querySelector('.act-refresh').addEventListener('click', function () { loadQueue(site); });
  el.querySelectorAll('.act').forEach(function (btn) {
    btn.addEventListener('click', function () { modAction(site, el, btn); });
  });
}

function modAction(site, el, btn) {
  var id = btn.getAttribute('data-id');
  var act = btn.getAttribute('data-act');
  var node = el.querySelector('.card[data-id="' + id + '"]');
  var done = function () { loadQueue(site); };
  var fail = function (e) { alert(e.message || 'Action failed.'); };

  if (act === 'publish') {
    if (!node._decoded) return fail(new Error('Could not decrypt this comment.'));
    api('/api/sites/' + site.site_id + '/comments/' + id + '/publish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: node._decoded.name, body: node._decoded.body }),
    }).then(done).catch(fail);
  } else if (act === 'reject') {
    api('/api/sites/' + site.site_id + '/comments/' + id + '/reject', { method: 'POST' }).then(done).catch(fail);
  } else if (act === 'delete') {
    if (!confirm('Permanently delete this comment?')) return;
    api('/api/sites/' + site.site_id + '/comments/' + id, { method: 'DELETE' }).then(done).catch(fail);
  }
}

// ── Boot + auth ─────────────────────────────────────────────────────────────
function boot() {
  api('/api/me')
    .then(function (data) {
      hide($('login-view')); show($('app-view'));
      $('who').textContent = data.owner.email;
      renderSites(data.sites || []);
    })
    .catch(function () {
      show($('login-view')); hide($('app-view'));
      var params = new URLSearchParams(window.location.search);
      if (params.get('error') === 'link') {
        var m = $('login-msg'); m.className = 'msg err';
        m.textContent = 'That sign-in link was invalid or expired. Request a new one.';
      }
    });
}

$('send-link').addEventListener('click', function () {
  var email = $('email').value.trim();
  var m = $('login-msg');
  if (!email) { m.className = 'msg err'; m.textContent = 'Enter your email.'; return; }
  m.className = 'msg'; m.textContent = 'Sending…';
  api('/api/auth/magic-link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email }),
  }).then(function () {
    m.className = 'msg ok';
    m.textContent = 'Check your email for a sign-in link. (In local dev, the link is printed to the server console.)';
  }).catch(function (e) { m.className = 'msg err'; m.textContent = e.message; });
});

$('logout').addEventListener('click', function () {
  api('/api/auth/logout', { method: 'POST' }).then(function () { window.location.reload(); });
});

$('create-site').addEventListener('click', function () {
  var name = $('site-name').value.trim();
  var domains = $('site-domains').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var m = $('create-msg'); m.className = 'msg'; m.textContent = 'Creating…';
  api('/api/sites', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, domains: domains }),
  }).then(function () { window.location.reload(); }).catch(function (e) { m.className = 'msg err'; m.textContent = e.message; });
});

boot();
