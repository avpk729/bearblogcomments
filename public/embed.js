/*
 * Bear Blog Guestbook — embeddable widget.
 *
 * Usage on your (upgraded) Bear Blog "Guest Book" page:
 *
 *   <div id="guestbook"></div>
 *   <script src="https://YOUR-APP.up.railway.app/embed.js" data-target="guestbook"></script>
 *
 * The script figures out the API base from its own URL, so you only ever
 * change the src. It renders directly into the page (no iframe) so it
 * inherits your blog's look while staying namespaced under .gbk-*.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var apiBase =
    (script && script.getAttribute('data-api')) ||
    (script && script.src ? new URL(script.src).origin : window.location.origin);
  var targetId = script && script.getAttribute('data-target');

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ESC[c];
    });
  }
  // Plain text -> safe HTML, preserving line breaks. No formatting allowed.
  function textToHtml(s) {
    return escapeHtml(s).replace(/\n/g, '<br>');
  }

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
      s.async = true;
      s.defer = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { resolve(); }; // fail open to the server check
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

  function GuestBook(root, config) {
    this.root = root;
    this.config = config;
    this.widgets = {}; // turnstile widget ids keyed by form key
    this.render();
  }

  GuestBook.prototype.render = function () {
    var c = this.config;
    this.root.className = (this.root.className ? this.root.className + ' ' : '') + 'gbk';
    this.root.innerHTML =
      this.formHtml('main', 'Leave a note', null) +
      '<div class="gbk-list"><p class="gbk-empty">Loading…</p></div>';
    this.wireForm('main', null);
    this.load();
  };

  GuestBook.prototype.formHtml = function (key, label, parentId) {
    var c = this.config;
    return (
      '<form class="gbk-form" data-key="' + key + '"' +
      (parentId ? ' data-parent="' + parentId + '"' : '') + '>' +
      '<input class="gbk-name" name="name" type="text" maxlength="' + c.maxName +
      '" placeholder="Your name (optional)" autocomplete="name">' +
      '<textarea class="gbk-body" name="body" maxlength="' + c.maxBody +
      '" placeholder="' + escapeHtml(label) + '…"></textarea>' +
      // Honeypot — hidden from humans.
      '<input class="gbk-hp" name="website" tabindex="-1" autocomplete="off" ' +
      'style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0" aria-hidden="true">' +
      '<div class="gbk-captcha"></div>' +
      '<div class="gbk-row">' +
      '<span class="gbk-count">0 / ' + c.maxBody + '</span>' +
      '<button class="gbk-btn" type="submit">Post</button>' +
      '</div>' +
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
    var max = this.config.maxBody;

    body.addEventListener('input', function () {
      count.textContent = body.value.length + ' / ' + max;
      count.classList.toggle('over', body.value.length >= max);
    });

    // Render a Turnstile widget into this form if configured.
    if (this.config.siteKey && window.turnstile) {
      var holder = form.querySelector('.gbk-captcha');
      this.widgets[key] = window.turnstile.render(holder, {
        sitekey: this.config.siteKey,
        theme: 'auto',
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      self.submit(form, key, parentId);
    });
  };

  GuestBook.prototype.submit = function (form, key, parentId) {
    var self = this;
    var msg = form.querySelector('.gbk-msg');
    var btn = form.querySelector('button[type="submit"]');
    var name = form.querySelector('.gbk-name').value;
    var body = form.querySelector('.gbk-body').value;
    var website = form.querySelector('.gbk-hp').value;

    msg.className = 'gbk-msg';
    msg.textContent = '';

    if (!body.trim()) {
      msg.className = 'gbk-msg err';
      msg.textContent = 'Please write something first.';
      return;
    }

    var token = '';
    if (this.config.siteKey && window.turnstile && this.widgets[key] != null) {
      token = window.turnstile.getResponse(this.widgets[key]) || '';
      if (!token) {
        msg.className = 'gbk-msg err';
        msg.textContent = 'Please complete the human check.';
        return;
      }
    }

    btn.disabled = true;
    api('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        body: body,
        parent_id: parentId,
        website: website,
        turnstileToken: token,
      }),
    })
      .then(function () {
        msg.className = 'gbk-msg ok';
        msg.textContent = 'Posted — thanks!';
        form.querySelector('.gbk-body').value = '';
        form.querySelector('.gbk-name').value = name; // keep their name
        var count = form.querySelector('.gbk-count');
        count.textContent = '0 / ' + self.config.maxBody;
        if (self.config.siteKey && window.turnstile && self.widgets[key] != null) {
          window.turnstile.reset(self.widgets[key]);
        }
        self.load();
      })
      .catch(function (err) {
        msg.className = 'gbk-msg err';
        msg.textContent = err.message || 'Something went wrong.';
      })
      .then(function () {
        btn.disabled = false;
      });
  };

  GuestBook.prototype.load = function () {
    var self = this;
    var list = this.root.querySelector('.gbk-list');
    api('/api/notes', {})
      .then(function (data) {
        var notes = data.notes || [];
        if (!notes.length) {
          list.innerHTML = '<p class="gbk-empty">No notes yet. Be the first to sign the guestbook!</p>';
          return;
        }
        list.innerHTML = notes.map(function (n) { return self.noteHtml(n); }).join('');
        self.wireReplyButtons();
      })
      .catch(function () {
        list.innerHTML = '<p class="gbk-empty">Could not load the guestbook.</p>';
      });
  };

  GuestBook.prototype.noteHtml = function (n) {
    var self = this;
    var replies = (n.replies || [])
      .map(function (r) { return self.replyHtml(r); })
      .join('');
    return (
      '<div class="gbk-note" data-id="' + n.id + '">' +
      '<div class="gbk-meta">' + this.metaHtml(n) + '</div>' +
      '<div class="gbk-text">' + textToHtml(n.body) + '</div>' +
      '<div class="gbk-actions">' +
      '<button class="gbk-link gbk-reply-btn" data-id="' + n.id + '">Reply</button>' +
      '</div>' +
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
    var btns = this.root.querySelectorAll('.gbk-reply-btn');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var note = self.root.querySelector('.gbk-note[data-id="' + id + '"]');
        var slot = note.querySelector('.gbk-reply-slot');
        if (slot.firstChild) {
          slot.innerHTML = '';
          return;
        }
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
      document.getElementById('bearblog-guestbook') ||
      document.getElementById('guestbook');
    if (!root) {
      // Fall back to inserting right after the script tag.
      root = document.createElement('div');
      if (script && script.parentNode) script.parentNode.insertBefore(root, script.nextSibling);
      else document.body.appendChild(root);
    }

    api('/api/config', {})
      .then(function (config) {
        var go = function () { new GuestBook(root, config); };
        if (config.siteKey) loadTurnstile().then(go);
        else go();
      })
      .catch(function () {
        root.textContent = 'Guestbook is unavailable right now.';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
