'use strict';

/*
 * Owner dashboard: magic-link sign-in, site management, and embed snippets.
 * Moderation + encryption setup are added on top of this in the E2EE phase.
 */

var ORIGIN = window.location.origin;

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
    '<label>Per-post comments (paste into your POST template):</label>' +
    '<pre>' + esc(snippet(site, 'post', 'comments')) + '</pre>' +
    '<label>Per-blog guestbook (paste into a PAGE):</label>' +
    '<pre>' + esc(snippet(site, 'guestbook', 'guestbook')) + '</pre>' +
    '<div class="muted" id="mod-' + esc(site.site_id) + '">Encryption &amp; moderation setup appears here in the next step.</div>' +
    '</div>'
  );
}

function renderSites(sites) {
  var host = $('sites');
  if (!sites.length) {
    host.innerHTML = '<p class="muted">No sites yet. Create your first one below.</p>';
    return;
  }
  host.innerHTML = sites.map(siteCard).join('');
}

// ── Boot: decide logged-in vs logged-out ────────────────────────────────────
function boot() {
  api('/api/me')
    .then(function (data) {
      hide($('login-view'));
      show($('app-view'));
      $('who').textContent = data.owner.email;
      renderSites(data.sites || []);
    })
    .catch(function () {
      show($('login-view'));
      hide($('app-view'));
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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email }),
  })
    .then(function () {
      m.className = 'msg ok';
      m.textContent = 'Check your email for a sign-in link. (In local dev, the link is printed to the server console.)';
    })
    .catch(function (e) { m.className = 'msg err'; m.textContent = e.message; });
});

$('logout').addEventListener('click', function () {
  api('/api/auth/logout', { method: 'POST' }).then(function () { window.location.reload(); });
});

$('create-site').addEventListener('click', function () {
  var name = $('site-name').value.trim();
  var domains = $('site-domains').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var m = $('create-msg');
  m.className = 'msg'; m.textContent = 'Creating…';
  api('/api/sites', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, domains: domains }),
  })
    .then(function () { window.location.reload(); })
    .catch(function (e) { m.className = 'msg err'; m.textContent = e.message; });
});

boot();
