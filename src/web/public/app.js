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

  /* ---------- log viewer ---------- */

  /* The admin Logs page. Two jobs that stay deliberately apart:

     The filter is entirely local. It runs on every keystroke over lines that are
     already in the page, so it never waits for the network — that is what makes
     "type a few characters and see them light up" feel immediate. Channel and level
     are the opposite: they are query parameters, the form submits them, and the
     page comes back filtered. Those change rarely and belong in a URL.

     The tail asks only for lines newer than the last sequence number it has seen,
     so a running viewer transfers a line once and never re-renders what is already
     on screen. */
  function initLogViewer(root) {
    var LOG_POLL_MS = 2000;
    var MAX_ROWS = 4000; // what the page will hold before dropping from the top

    var list = root.querySelector('[data-log-lines]');
    var empty = root.querySelector('[data-log-empty]');
    var filters = document.querySelector('[data-log-filters]');
    var input = document.querySelector('[data-log-filter]');
    var regexBox = document.querySelector('[data-log-regex]');
    var onlyBox = document.querySelector('[data-log-only]');
    var followBox = document.querySelector('[data-log-follow]');
    var stateEl = document.querySelector('[data-log-state]');
    var countEl = document.querySelector('[data-log-count]');
    var refreshLink = document.querySelector('[data-log-refresh]');

    var cursor = parseInt(root.getAttribute('data-cursor') || '0', 10) || 0;
    var channel = root.getAttribute('data-channel') || 'all';
    var level = root.getAttribute('data-level') || 'debug';
    var timer = null;
    var fetching = false;

    /* ----- filtering and highlighting ----- */

    function escapeRe(s) {
      return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /* The compiled query, or null for "no filter", or an error to show. A bad
       regular expression is reported rather than silently matching nothing —
       half-typed patterns are the normal state of a box being typed into. */
    function matcher() {
      var text = input ? input.value : '';
      if (!text) return { re: null };
      var source = regexBox && regexBox.checked ? text : escapeRe(text);
      try {
        return { re: new RegExp(source, 'gi') };
      } catch (e) {
        return { error: 'not a valid regular expression' };
      }
    }

    /* Rebuild one line's text, wrapping each match in <mark>. Always starts from
       data-text, never from the last pass's markup, so highlights cannot nest or
       accumulate as the query is edited. */
    function paint(li, re) {
      var text = li.getAttribute('data-text') || '';
      var cell = li.querySelector('.log-text');
      if (!re) {
        cell.textContent = text;
        return true;
      }

      re.lastIndex = 0;
      var out = '';
      var at = 0;
      var hit = false;
      var m;
      while ((m = re.exec(text)) !== null) {
        hit = true;
        out += esc(text.slice(at, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
        at = m.index + m[0].length;
        // A pattern that can match nothing would otherwise spin here forever.
        if (m[0].length === 0) re.lastIndex += 1;
      }
      if (!hit) {
        cell.textContent = text;
        return false;
      }
      cell.innerHTML = out + esc(text.slice(at));
      return true;
    }

    function applyFilter() {
      var q = matcher();
      var only = !onlyBox || onlyBox.checked;
      var rows = list.children;
      var matched = 0;

      for (var i = 0; i < rows.length; i += 1) {
        var li = rows[i];
        var hit = paint(li, q.error ? null : q.re);
        if (hit) matched += 1;
        // With no query every line matches, so nothing is hidden or dimmed.
        var filtering = !!q.re && !q.error;
        li.hidden = filtering && only && !hit;
        li.classList.toggle('log-dim', filtering && !only && !hit);
      }

      if (input) input.setAttribute('aria-invalid', q.error ? 'true' : 'false');
      if (countEl) {
        if (q.error) countEl.textContent = q.error;
        else if (!q.re) countEl.textContent = rows.length ? rows.length + ' lines' : '';
        else countEl.textContent = matched + ' of ' + rows.length + ' lines match';
        countEl.classList.toggle('none', !!q.error || (!!q.re && matched === 0));
      }
      if (empty) empty.hidden = rows.length > 0;
    }

    /* ----- tailing ----- */

    function renderLine(line) {
      var li = document.createElement('li');
      li.className =
        'log-line lv-' + line.level + (line.wire ? ' wire-' + line.wire : '') + ' log-new';
      li.setAttribute('data-text', line.text);
      li.innerHTML =
        '<time datetime="' + esc(line.time) + '" title="' + esc(line.time) + '">' +
        esc(line.time.slice(11, 19)) + '</time>' +
        '<span class="log-level">' + esc(line.level) + '</span>' +
        '<span class="log-text"></span>';
      li.querySelector('.log-text').textContent = line.text;
      return li;
    }

    function atBottom() {
      return root.scrollTop + root.clientHeight >= root.scrollHeight - 24;
    }

    function setState(text) {
      if (stateEl) stateEl.textContent = text;
    }

    function tick() {
      if (fetching) return Promise.resolve();
      fetching = true;
      var stick = followBox && followBox.checked && atBottom();

      return fetch(
        '/api/admin/logs?since=' + cursor +
          '&channel=' + encodeURIComponent(channel) +
          '&level=' + encodeURIComponent(level),
        { headers: { accept: 'application/json' } },
      )
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) { setState('not responding'); return; }
          setState('');
          if (!data.lines.length) return;

          cursor = data.cursor;
          data.lines.forEach(function (line) { list.appendChild(renderLine(line)); });
          // Keep the page bounded on an instance that has been logging for hours.
          while (list.children.length > MAX_ROWS) list.removeChild(list.firstChild);

          applyFilter();
          if (stick) root.scrollTop = root.scrollHeight;
        })
        .catch(function () { setState('not responding'); })
        .then(function () { fetching = false; });
    }

    function startPolling() {
      if (timer) return;
      timer = setInterval(function () {
        // A hidden tab has nobody reading it; catching up on return is enough.
        if (!document.hidden) tick();
      }, LOG_POLL_MS);
    }

    function stopPolling() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      setState('paused');
    }

    /* ----- wiring ----- */

    if (input) {
      input.addEventListener('input', applyFilter);
      // Escape empties the box, which is the quickest way back to the whole log.
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && input.value) {
          ev.preventDefault();
          input.value = '';
          applyFilter();
        }
      });
    }
    if (regexBox) regexBox.addEventListener('change', applyFilter);
    if (onlyBox) onlyBox.addEventListener('change', applyFilter);

    if (followBox) {
      followBox.addEventListener('change', function () {
        if (followBox.checked) { startPolling(); tick(); } else { stopPolling(); }
      });
    }

    /* Refresh stays a real link for the no-JavaScript case, but with the viewer
       running a reload would throw away what is typed in the filter. So it fetches
       instead, and only the lines change. */
    if (refreshLink) {
      refreshLink.addEventListener('click', function (ev) {
        ev.preventDefault();
        setState('checking…');
        tick();
      });
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && followBox && followBox.checked) tick();
    });

    // The selects re-query the server, so they submit the form they sit in.
    if (filters) {
      filters.querySelectorAll('[data-log-submit]').forEach(function (el) {
        el.addEventListener('change', function () { filters.submit(); });
      });
    }

    applyFilter();
    // Newest is at the bottom, which is where a log is read from.
    root.scrollTop = root.scrollHeight;
    if (!followBox || followBox.checked) startPolling();
  }

  /* ---------- number fields ---------- */

  /* A focused <input type="number"> takes the scroll wheel as an instruction to
     count, so scrolling a settings page with the pointer over one silently edits it.
     That is how a web port of 8025 becomes 7964 — sixty-one notches — with nothing on
     screen to say it happened, and the next save stores it.

     The field loses focus instead, which lets the page scroll normally and leaves the
     value alone. Arrow keys and the spinners still step it, because those are asked
     for; the wheel never is. */
  function initNumberWheelGuard() {
    document.addEventListener(
      'wheel',
      function (ev) {
        var el = document.activeElement;
        if (el && el.tagName === 'INPUT' && el.type === 'number' && el === ev.target) el.blur();
      },
      { passive: true },
    );
  }

  document.addEventListener('DOMContentLoaded', function () {
    initNumberWheelGuard();

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

    var logView = document.querySelector('[data-log-view]');
    if (logView) initLogViewer(logView);
  });
})();
