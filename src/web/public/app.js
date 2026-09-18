/* MailButler client. Two small jobs: keep the inbox live, and size the HTML iframe. */
(function () {
  'use strict';

  var POLL_MS = 5000;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var sameDay = d.toDateString() === new Date().toDateString();
    // Must match fmtDate() on the server exactly: both render rows into one list.
    var time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return time;
    return d.toLocaleDateString('en', { month: 'short' }) + ' ' + d.getDate() + ' ' + time;
  }

  /* ---------- live inbox ---------- */

  function initLiveInbox(root) {
    var list = root.querySelector('[data-list]');
    var empty = root.querySelector('[data-empty]');
    var unreadEl = document.querySelector('[data-unread]');
    var stateEl = document.querySelector('[data-live-state]');
    var folder = root.getAttribute('data-folder') || 'inbox';
    var since = parseInt(root.getAttribute('data-since') || '0', 10) || 0;
    var baseTitle = document.title.replace(/^\(\d+\)\s*/, '');
    var fetching = false;
    var pollTimer = null;

    function setState(s) {
      if (stateEl) {
        stateEl.setAttribute('data-live-state', s);
        stateEl.textContent = s === 'polling' ? 'polling' : s === 'live' ? 'live' : 'connecting';
      }
    }

    function renderRow(m) {
      var li = document.createElement('li');
      li.className = 'msg arrived' + (m.seen ? '' : ' unseen');
      var who = folder === 'sent' ? (m.toLine || '(no recipient)') : (m.fromName || m.from);
      li.innerHTML =
        '<a href="/mail/' + m.id + '">' +
        '<span class="who">' + esc(who) + '</span>' +
        '<span class="subject">' + esc(m.subject || '(no subject)') + '</span>' +
        '<span class="snippet">' + esc(m.snippet) + '</span>' +
        '<span class="meta">' + (m.hasAttachments ? '<span class="clip" title="Has attachments">\u{1F4CE}</span> ' : '') +
        '<time datetime="' + esc(m.date) + '">' + esc(fmtTime(m.date)) + '</time></span></a>';
      return li;
    }

    function applyUnread(n) {
      if (unreadEl) unreadEl.textContent = n ? String(n) : '';
      document.title = n ? '(' + n + ') ' + baseTitle : baseTitle;
    }

    /* Pull anything newer than the highest id we have shown. Used by both the SSE
       path (as the actual fetch after a nudge) and the polling fallback, so there
       is exactly one code path that adds rows. */
    function refresh() {
      if (fetching) return Promise.resolve();
      fetching = true;
      return fetch('/api/mail/since?folder=' + encodeURIComponent(folder) + '&since=' + since, {
        headers: { accept: 'application/json' },
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) return;
          if (data.messages && data.messages.length) {
            data.messages.slice().reverse().forEach(function (m) {
              if (m.id > since) since = m.id;
              list.insertBefore(renderRow(m), list.firstChild);
            });
            if (empty) empty.hidden = true;
          }
          applyUnread(data.unread);
        })
        .catch(function () { /* transient; the next tick tries again */ })
        .then(function () { fetching = false; });
    }

    function startPolling() {
      if (pollTimer) return;
      setState('polling');
      pollTimer = setInterval(refresh, POLL_MS);
    }

    function stopPolling() {
      if (!pollTimer) return;
      clearInterval(pollTimer);
      pollTimer = null;
    }

    /* Server-sent events push a nudge the moment delivery.js writes a message, so
       the inbox updates immediately. If the stream is unavailable we fall back to
       polling and the page still stays current, just less promptly. */
    if (typeof EventSource === 'function') {
      var es = new EventSource('/api/stream');
      es.addEventListener('open', function () { stopPolling(); setState('live'); refresh(); });
      es.addEventListener('mail', function () { refresh(); });
      es.addEventListener('error', function () {
        // EventSource retries on its own; poll meanwhile so nothing is missed.
        setState('connecting');
        startPolling();
      });
    } else {
      startPolling();
    }

    // Catch up immediately when the tab is brought back to the foreground.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh();
    });
  }

  /* ---------- message view ---------- */

  /* The HTML body lives in a fully sandboxed frame: no scripts, no same-origin
     access, so it cannot read the app's cookies or measure itself. The frame is
     given a fixed viewport and scrolls internally, and the reader can drag it
     taller. The src is assigned here rather than in the markup so the load is a
     scripted navigation, which behaves consistently across embedded browsers. */
  function initHtmlFrame(frame) {
    var src = frame.getAttribute('data-html-src');
    if (src) frame.src = src;
  }

  function initSource(pre) {
    var id = pre.getAttribute('data-source-for');
    fetch('/mail/' + encodeURIComponent(id) + '/raw')
      .then(function (r) { return r.ok ? r.text() : 'Could not load the message source.'; })
      .then(function (t) { pre.textContent = t; })
      .catch(function () { pre.textContent = 'Could not load the message source.'; });
  }

  /* Remember the reader's last choice of HTML vs plain text vs source. */
  function initViewTabs(tabs) {
    var KEY = 'mb.view';
    try {
      var saved = localStorage.getItem(KEY);
      if (saved) {
        tabs.querySelectorAll('[data-view]').forEach(function (a) {
          if (a.getAttribute('data-view') === saved && !a.classList.contains('on')) {
            // Only redirect when the saved view actually exists for this message.
            location.replace(a.getAttribute('href'));
          }
        });
      }
    } catch (e) { /* storage unavailable; the server default stands */ }

    tabs.addEventListener('click', function (ev) {
      var a = ev.target.closest('[data-view]');
      if (!a) return;
      try { localStorage.setItem(KEY, a.getAttribute('data-view')); } catch (e) {}
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var inbox = document.querySelector('[data-live-inbox]');
    if (inbox) initLiveInbox(inbox);

    var frame = document.querySelector('iframe[data-html-src]');
    if (frame) initHtmlFrame(frame);

    var pre = document.querySelector('[data-source-for]');
    if (pre) initSource(pre);

    var tabs = document.querySelector('[data-view-tabs]');
    if (tabs) initViewTabs(tabs);
  });
})();
