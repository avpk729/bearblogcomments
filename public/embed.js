/*
 * Bear Blog Comments — embeddable widget.
 *
 * Per-post comments (in your POST template):
 *   <div id="comments"></div>
 *   <script src="https://YOUR-APP.up.railway.app/embed.js"
 *           data-site-id="YOUR_SITE_ID" data-mode="post" data-target="comments"></script>
 *
 * Per-blog guestbook (in a PAGE):
 *   <div id="guestbook"></div>
 *   <script src="https://YOUR-APP.up.railway.app/embed.js"
 *           data-site-id="YOUR_SITE_ID" data-mode="guestbook" data-target="guestbook"></script>
 *
 * mode "post" threads comments by the page URL. mode "guestbook" uses one
 * thread for the whole site. Optional data-thread-key pins a stable key (handy
 * if you later rename a post's slug). The script derives the API base from its
 * own src, so you only ever change the src + site-id.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var apiBase =
    (script && script.getAttribute('data-api')) ||
    (script && script.src ? new URL(script.src).origin : window.location.origin);
  var siteId = script && script.getAttribute('data-site-id');
  var mode = (script && script.getAttribute('data-mode')) || 'guestbook';
  var threadKeyOverride = script && script.getAttribute('data-thread-key');
  var targetId = script && script.getAttribute('data-target');

  // Params identifying this thread, sent with every request.
  function threadParams() {
    var p = { site_id: siteId, mode: mode };
    if (mode === 'post') p.page_url = window.location.href;
    if (threadKeyOverride) p.thread_key = threadKeyOverride;
    return p;
  }
  function qs(obj) {
    return Object.keys(obj)
      .filter(function (k) { return obj[k] != null && obj[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]); })
      .join('&');
  }

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }
  function textToHtml(s) { return escapeHtml(s).replace(/\n/g, '<br>'); }

  function timeAgo(iso) {
    var d = new Date(iso);
    var diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 2592000) return Math.floor(diff / 86400) + 'd ago';
    return d.toLocaleDateString();
  }

  function injectStyles() {
    if (document.getElementById('gbk-styles')) return;
    var css =
      '.gbk{max-width:680px;margin:1.5rem auto;font-size:1rem;line-height:1.5}' +
      '.gbk *{box-sizing:border-box}' +
      '.gbk-form{border:1px solid currentColor;border-radius:12px;padding:1rem;margin-bottom:1.5rem;opacity:.95}' +
      '.gbk-name{width:100%;padding:.5rem;margin-bottom:.5rem;border:1px solid #ccc;border-radius:8px;font:inherit;background:transparent;color:inherit}' +
      '.gbk-body{width:100%;padding:.5rem;border:1px solid #ccc;border-radius:8px;font:inherit;resize:vertical;min-height:4.5rem;background:transparent;color:inherit}' +
      '.gbk-row{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-top:.5rem;flex-wrap:wrap}' +
      '.gbk-count{font-size:.85rem;opacity:.6}' +
      '.gbk-count.over{color:#c00;opacity:1}' +
      '.gbk-btn{font:inherit;cursor:pointer;padding:.45rem .9rem;border:1px solid currentColor;border-radius:999px;background:transparent;color:inherit}' +
      '.gbk-btn:hover{opacity:.7}' +
      '.gbk-btn[disabled]{opacity:.4;cursor:not-allowed}' +
      '.gbk-note{border-top:1px solid rgba(128,128,128,.25);padding:.9rem 0}' +
      '.gbk-meta{font-size:.9rem;margin-bottom:.25rem}' +
      '.gbk-author{font-weight:600}' +
      '.gbk-owner-tag{font-size:.7rem;border:1px solid currentColor;border-radius:999px;padding:.05rem .4rem;margin-left:.4rem;opacity:.7;vertical-align:middle}' +
      '.gbk-time{opacity:.55;margin-left:.4rem;font-size:.85rem}' +
      '.gbk-text{white-space:normal;word-wrap:break-word;overflow-wrap:anywhere}' +
      '.gbk-replies{margin:.6rem 0 0 1rem;padding-left:.8rem;border-left:2px solid rgba(128,128,128,.25)}' +
      '.gbk-reply{padding:.5rem 0}' +
      '.gbk-actions{margin-top:.3rem}' +
      '.gbk-link{font-size:.85rem;background:none;border:none;cursor:pointer;color:inherit;opacity:.6;padding:0;text-decoration:underline;font-family:inherit}' +
      '.gbk-link:hover{opacity:1}' +
      '.gbk-msg{font-size:.9rem;margin-top:.5rem}' +
      '.gbk-msg.err{color:#c00}' +
      '.gbk-msg.ok{color:#197a19}' +
      '.gbk-empty{opacity:.6;padding:1rem 0}';
    var el = document.createElement('style');
    el.id = 'gbk-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function loadTurnstile() {
    return new Promise(function (resolve) {
      if (window.turnstile) return resolve();
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true; s.defer = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { resolve(); };
      document.head.appendChild(s);
    });
  }

  function api(pathname, opts) {
    return fetch(apiBase + pathname, opts).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.error ? body.error : 'Request failed');
        return body;
      });
    });
  }

  // Lazily load the crypto helper + libsodium (≈1MB) only when needed, so blog
  // pages aren't slowed down until a visitor actually writes a comment.
  var cryptoPromise = null;
  function ensureCrypto() {
    if (cryptoPromise) return cryptoPromise;
    cryptoPromise = new Promise(function (resolve, reject) {
      if (window.BBCrypto) return resolve(window.BBCrypto);
      var s = document.createElement('script');
      s.src = apiBase + '/crypto.js';
      s.onload = function () { resolve(window.BBCrypto); };
      s.onerror = function () { reject(new Error('Could not load encryption library.')); };
      document.head.appendChild(s);
    }).then(function (bb) { return bb.load(apiBase).then(function () { return bb; }); });
    return cryptoPromise;
  }

  function GuestBook(root, config) {
    this.root = root;
    this.config = config;
    this.widgets = {};
    this.render();
  }

  GuestBook.prototype.canPost = function () {
    return this.config.accepting && this.config.encryption_ready;
  };

  GuestBook.prototype.render = function () {
    this.root.className = (this.root.className ? this.root.className + ' ' : '') + 'gbk';
    var label = mode === 'guestbook' ? 'guestbook' : 'comment section';
    var formOrNote;
    if (this.canPost()) {
      formOrNote = this.formHtml('main', mode === 'guestbook' ? 'Leave a note' : 'Leave a comment', null);
    } else if (!this.config.encryption_ready) {
      formOrNote = '<p class="gbk-empty">Comments aren’t enabled yet.</p>';
    } else {
      formOrNote = '<p class="gbk-empty">This ' + label + ' is not accepting new entries right now.</p>';
    }
    this.root.innerHTML = formOrNote + '<div class="gbk-list"><p class="gbk-empty">Loading…</p></div>';
    if (this.canPost()) {
      this.wireForm('main', null);
      ensureCrypto().catch(function () {}); // warm up in the background
    }
    this.load();
  };

  GuestBook.prototype.formHtml = function (key, label, parentId) {
    var c = this.config;
    return (
      '<form class="gbk-form" data-key="' + key + '"' + (parentId ? ' data-parent="' + parentId + '"' : '') + '>' +
      '<input class="gbk-name" name="name" type="text" maxlength="' + c.max_name + '" placeholder="Your name (optional)" autocomplete="name">' +
      '<textarea class="gbk-body" name="body" maxlength="' + c.max_body + '" placeholder="' + escapeHtml(label) + '…"></textarea>' +
      '<input class="gbk-hp" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0" aria-hidden="true">' +
      '<div class="gbk-captcha"></div>' +
      '<div class="gbk-row"><span class="gbk-count">0 / ' + c.max_body + '</span>' +
      '<button class="gbk-btn" type="submit">Post</button></div>' +
      '<div class="gbk-msg" role="status"></div>' +
      '</form>'
    );
  };

  GuestBook.prototype.wireForm = function (key, parentId) {
    var self = this;
    var form = this.root.querySelector('.gbk-form[data-key="' + key + '"]');
    if (!form) return;
    var body = form.querySelector('.gbk-body');
    var count = form.querySelector('.gbk-count');
    var max = this.config.max_body;
    body.addEventListener('input', function () {
      count.textContent = body.value.length + ' / ' + max;
      count.classList.toggle('over', body.value.length >= max);
    });
    if (this.config.turnstile_site_key && window.turnstile) {
      var holder = form.querySelector('.gbk-captcha');
      this.widgets[key] = window.turnstile.render(holder, { sitekey: this.config.turnstile_site_key, theme: 'auto' });
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); self.submit(form, key, parentId); });
  };

  GuestBook.prototype.submit = function (form, key, parentId) {
    var self = this;
    var msg = form.querySelector('.gbk-msg');
    var btn = form.querySelector('button[type="submit"]');
    var name = form.querySelector('.gbk-name').value;
    var body = form.querySelector('.gbk-body').value;
    var website = form.querySelector('.gbk-hp').value;
    msg.className = 'gbk-msg'; msg.textContent = '';
    if (!body.trim()) { msg.className = 'gbk-msg err'; msg.textContent = 'Please write something first.'; return; }

    var token = '';
    if (this.config.turnstile_site_key && window.turnstile && this.widgets[key] != null) {
      token = window.turnstile.getResponse(this.widgets[key]) || '';
      if (!token) { msg.className = 'gbk-msg err'; msg.textContent = 'Please complete the human check.'; return; }
    }

    btn.disabled = true;
    msg.className = 'gbk-msg'; msg.textContent = 'Encrypting…';

    // Seal {name, body} in the browser to the owner's public key. The server
    // only ever receives ciphertext.
    ensureCrypto()
      .then(function (bb) {
        var ciphertext = bb.seal(self.config.public_key, { name: name, body: body });
        var payload = threadParams();
        payload.ciphertext = ciphertext;
        payload.key_version = self.config.key_version;
        payload.parent_id = parentId;
        payload.website = website;
        payload.turnstileToken = token;
        return api('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      })
      .then(function () {
        msg.className = 'gbk-msg ok';
        msg.textContent = 'Thanks! Your comment is encrypted and awaiting the owner’s approval.';
        form.querySelector('.gbk-body').value = '';
        form.querySelector('.gbk-name').value = name;
        form.querySelector('.gbk-count').textContent = '0 / ' + self.config.max_body;
        if (self.config.turnstile_site_key && window.turnstile && self.widgets[key] != null) window.turnstile.reset(self.widgets[key]);
        // No list reload — the new comment stays hidden until approved.
      })
      .catch(function (err) { msg.className = 'gbk-msg err'; msg.textContent = err.message || 'Something went wrong.'; })
      .then(function () { btn.disabled = false; });
  };

  GuestBook.prototype.load = function () {
    var self = this;
    var list = this.root.querySelector('.gbk-list');
    api('/api/comments?' + qs(threadParams()), {})
      .then(function (data) {
        var notes = data.comments || [];
        if (!notes.length) {
          list.innerHTML = '<p class="gbk-empty">No comments yet.' + (self.canPost() ? ' Be the first!' : '') + '</p>';
          return;
        }
        list.innerHTML = notes.map(function (n) { return self.noteHtml(n); }).join('');
        self.wireReplyButtons();
      })
      .catch(function () { list.innerHTML = '<p class="gbk-empty">Could not load comments.</p>'; });
  };

  GuestBook.prototype.noteHtml = function (n) {
    var self = this;
    var replies = (n.replies || []).map(function (r) { return self.replyHtml(r); }).join('');
    return (
      '<div class="gbk-note" data-id="' + n.id + '">' +
      '<div class="gbk-meta">' + this.metaHtml(n) + '</div>' +
      '<div class="gbk-text">' + textToHtml(n.body) + '</div>' +
      (this.canPost() ? '<div class="gbk-actions"><button class="gbk-link gbk-reply-btn" data-id="' + n.id + '">Reply</button></div>' : '') +
      '<div class="gbk-reply-slot"></div>' +
      (replies ? '<div class="gbk-replies">' + replies + '</div>' : '') +
      '</div>'
    );
  };

  GuestBook.prototype.replyHtml = function (r) {
    return (
      '<div class="gbk-reply" data-id="' + r.id + '">' +
      '<div class="gbk-meta">' + this.metaHtml(r) + '</div>' +
      '<div class="gbk-text">' + textToHtml(r.body) + '</div>' +
      '</div>'
    );
  };

  GuestBook.prototype.metaHtml = function (n) {
    return (
      '<span class="gbk-author">' + escapeHtml(n.name || 'Anonymous') + '</span>' +
      (n.is_owner ? '<span class="gbk-owner-tag">owner</span>' : '') +
      '<span class="gbk-time">' + timeAgo(n.created_at) + '</span>'
    );
  };

  GuestBook.prototype.wireReplyButtons = function () {
    var self = this;
    this.root.querySelectorAll('.gbk-reply-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var note = self.root.querySelector('.gbk-note[data-id="' + id + '"]');
        var slot = note.querySelector('.gbk-reply-slot');
        if (slot.firstChild) { slot.innerHTML = ''; return; }
        var key = 'reply-' + id;
        slot.innerHTML = self.formHtml(key, 'Write a reply', id);
        self.wireForm(key, parseInt(id, 10));
      });
    });
  };

  // ---- Boot ----
  function boot() {
    injectStyles();
    var root =
      (targetId && document.getElementById(targetId)) ||
      document.getElementById('bearblog-comments') ||
      document.getElementById('comments') ||
      document.getElementById('guestbook');
    if (!root) {
      root = document.createElement('div');
      if (script && script.parentNode) script.parentNode.insertBefore(root, script.nextSibling);
      else document.body.appendChild(root);
    }
    if (!siteId) { root.textContent = 'Comments misconfigured: missing data-site-id.'; return; }

    api('/api/config?site_id=' + encodeURIComponent(siteId), {})
      .then(function (config) {
        var go = function () { new GuestBook(root, config); };
        if (config.turnstile_site_key) loadTurnstile().then(go); else go();
      })
      .catch(function () { root.textContent = 'Comments are unavailable right now.'; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
