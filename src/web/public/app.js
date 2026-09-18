/* Tinpost client. Two small jobs: keep the inbox live, and size the HTML iframe. */
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
        '<span class="meta">' +
        (m.hasAttachments
          ? '<svg class="ico clip" viewBox="0 0 24 24" aria-label="Has attachments" role="img"><use href="#i-clip"/></svg>'
          : '') +
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

  /* ---------- theme ---------- */

  /* Three states, not two: following the system is the default, and a click moves
     to whichever theme is not currently showing. Only an explicit choice is
     stored, so a machine that switches at sunset keeps doing so until told not to. */
  function initTheme(button) {
    function showing() {
      var set = document.documentElement.dataset.theme;
      if (set === 'light' || set === 'dark') return set;
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark' : 'light';
    }
    button.addEventListener('click', function () {
      var next = showing() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('mb.theme', next); } catch (e) {}
    });
  }

  /* ---------- settings ribbon ---------- */

  /* Collapsing is a per-browser convenience, so it lives in localStorage and the
     page must render correctly when that read fails. */
  function initRibbon(ribbon) {
    var toggle = ribbon.querySelector('[data-ribbon-toggle]');
    if (!toggle) return;

    function apply(collapsed, persist) {
      ribbon.classList.toggle('collapsed', collapsed);
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      toggle.setAttribute('title', collapsed ? 'Expand the sidebar' : 'Collapse the sidebar');
      var use = toggle.querySelector('use');
      if (use) use.setAttribute('href', collapsed ? '#i-expand' : '#i-collapse');
      var text = toggle.querySelector('.ribbon-toggle-text');
      if (text) text.textContent = collapsed ? 'Expand' : 'Collapse';
      if (persist) {
        try { localStorage.setItem('mb.ribbon', collapsed ? 'collapsed' : 'expanded'); } catch (e) {}
      }
    }

    var stored = null;
    try { stored = localStorage.getItem('mb.ribbon'); } catch (e) {}
    if (stored === 'collapsed') apply(true, false);

    toggle.addEventListener('click', function () {
      apply(!ribbon.classList.contains('collapsed'), true);
    });
  }

  /* ---------- mailbox autocomplete ---------- */

  /* A combobox over the addresses this instance already knows. Typing completes the
     rest of the first match inline with the completion selected, so carrying on
     typing replaces it and nothing is ever forced on the operator — a new address
     stays as easy to enter as an existing one. */
  function initMailboxCombo(combo) {
    var input = combo.querySelector('input');
    var list = combo.querySelector('.combo-list');
    var options = [];
    var active = -1;
    var lastQuery = null;
    var completedTo = null;

    function close() {
      list.hidden = true;
      list.innerHTML = '';
      options = [];
      active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function render() {
      if (!options.length) return close();
      list.innerHTML = options
        .map(function (a, i) {
          return '<li role="option" id="mb-opt-' + i + '" class="combo-option"' +
            (i === active ? ' aria-selected="true"' : '') + '>' + esc(a) + '</li>';
        })
        .join('');
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    function highlight(next) {
      active = next;
      Array.prototype.forEach.call(list.children, function (li, i) {
        if (i === active) li.setAttribute('aria-selected', 'true');
        else li.removeAttribute('aria-selected');
      });
      if (active >= 0) {
        input.setAttribute('aria-activedescendant', 'mb-opt-' + active);
        list.children[active].scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function choose(value) {
      input.value = value;
      completedTo = null;
      close();
    }

    /* Fill in the rest of the best match and select it, so the next keystroke
       overwrites the suggestion rather than fighting it. Never do this while the
       caret is mid-string or the operator is deleting. */
    function completeInline(typed, best) {
      if (!best || best === typed) return;
      if (best.indexOf(typed) !== 0) return;
      // Selection is unavailable on some input types and in some browsers; the
      // dropdown is the real affordance, so failing here must not break it.
      try {
        if (input.selectionStart !== typed.length) return;
        input.value = best;
        input.setSelectionRange(typed.length, best.length);
        completedTo = best;
      } catch (e) {
        input.value = typed;
      }
    }

    function suggest(allowInline) {
      var typed = input.value.trim().toLowerCase();
      if (!typed) return close();
      if (typed === lastQuery) return;
      lastQuery = typed;

      fetch('/api/mailboxes?q=' + encodeURIComponent(typed), { headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || input.value.trim().toLowerCase() !== typed) return;
          // Every match is offered, not just the one completed inline: with several
          // candidates the operator needs to see the choice, not be quietly committed
          // to the first one.
          options = data.addresses.filter(function (a) { return a !== typed; });
          active = -1;
          render();
          // Only complete in place when there is exactly one candidate. With several,
          // filling one of them in would be a guess, and the list is the honest answer.
          if (allowInline) {
            var starts = options.filter(function (a) { return a.indexOf(typed) === 0; });
            if (starts.length === 1) completeInline(typed, starts[0]);
          }
        })
        .catch(close);
    }

    input.addEventListener('input', function (ev) {
      // Deleting should never re-complete what was just removed.
      var deleting = ev.inputType && ev.inputType.indexOf('delete') === 0;
      completedTo = null;
      suggest(!deleting);
    });

    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (list.hidden || !options.length) return;
        ev.preventDefault();
        // -1 is "nothing selected", so the cycle runs over options.length + 1 slots
        // and passes back through the typed text on the way round.
        var slots = options.length + 1;
        var step = ev.key === 'ArrowDown' ? 1 : -1;
        highlight(((active + 1 + step) % slots + slots) % slots - 1);
      } else if (ev.key === 'Enter') {
        if (!list.hidden && active >= 0) {
          ev.preventDefault();
          choose(options[active]);
        } else if (completedTo) {
          // Accept the inline completion rather than submitting a half-typed address.
          try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
          completedTo = null;
        }
      } else if (ev.key === 'Escape') {
        if (!list.hidden) {
          ev.preventDefault();
          close();
        }
      } else if (ev.key === 'Tab' && completedTo) {
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
        completedTo = null;
      }
    });

    list.addEventListener('mousedown', function (ev) {
      var li = ev.target.closest('.combo-option');
      if (!li) return;
      ev.preventDefault(); // keep focus in the field
      choose(li.textContent);
    });

    input.addEventListener('blur', function () { setTimeout(close, 120); });
    input.addEventListener('focus', function () { if (input.value.trim()) suggest(false); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var combo = document.querySelector('[data-mailbox-combo]');
    if (combo) initMailboxCombo(combo);

    var themeBtn = document.querySelector('[data-theme-toggle]');
    if (themeBtn) initTheme(themeBtn);

    var ribbon = document.querySelector('[data-ribbon]');
    if (ribbon) initRibbon(ribbon);

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
