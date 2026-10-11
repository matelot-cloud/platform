// Documentation pages: search over search-index.json, version switcher from ../versions.json, "on this page"
// highlighting, and the contents toggle on phones.
(function () {
  var input = document.getElementById('q'), box = document.getElementById('results'), index = null, active = -1;
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function load() { return index ? Promise.resolve(index) : fetch('search-index.json').then(function (r) { return r.json(); }).then(function (i) { return (index = i); }); }
  function snippet(text, q) {
    var i = text.toLowerCase().indexOf(q); if (i < 0) return text.slice(0, 120) + '…';
    var s = Math.max(0, i - 50); return (s ? '…' : '') + text.slice(s, i + 90) + '…';
  }
  function search(q) {
    q = q.trim().toLowerCase(); if (!q) { box.hidden = true; return; }
    load().then(function (pages) {
      var hits = pages.map(function (p) {
        var score = 0;
        if (p.title.toLowerCase().indexOf(q) >= 0) score += 10;
        p.headings.forEach(function (h) { if (h.toLowerCase().indexOf(q) >= 0) score += 4; });
        score += Math.min(p.text.toLowerCase().split(q).length - 1, 5);
        return { p: p, score: score };
      }).filter(function (h) { return h.score > 0; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 8);
      active = -1;
      box.innerHTML = hits.length ? hits.map(function (h) {
        return '<a href="' + h.p.slug + '.html"><div class="t">' + esc(h.p.title) + ' <span class="s">· ' + esc(h.p.section) + '</span></div><div class="s">' + esc(snippet(h.p.text, q)) + '</div></a>';
      }).join('') : '<div class="empty">Nothing matches “' + esc(q) + '”.</div>';
      box.hidden = false;
    });
  }
  if (input) {
    input.addEventListener('input', function () { search(input.value); });
    input.addEventListener('focus', function () { if (input.value) search(input.value); });
    input.addEventListener('keydown', function (e) {
      var items = box.querySelectorAll('a'); if (!items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; items.forEach(function (a, i) { a.classList.toggle('active', i === active); }); }
      if (e.key === 'Enter' && active >= 0) { location.href = items[active].href; }
      if (e.key === 'Escape') { box.hidden = true; input.blur(); }
    });
    document.addEventListener('click', function (e) { if (!e.target.closest('.search')) box.hidden = true; });
    document.addEventListener('keydown', function (e) { if (e.key === '/' && document.activeElement !== input && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); } });
  }

  // version switcher: ../versions.json lists every published version; switching keeps the same page when it exists there
  var select = document.getElementById('version');
  var current = (document.querySelector('meta[name="docs-version"]') || {}).content;
  if (select) {
    fetch('../versions.json').then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
      if (!v || !v.versions) return;
      select.innerHTML = v.versions.map(function (x) { return '<option value="' + esc(x.name) + '"' + (x.name === current ? ' selected' : '') + '>' + esc(x.label || x.name) + '</option>'; }).join('');
    }).catch(function () {});
    select.addEventListener('change', function () {
      var page = location.pathname.split('/').pop() || 'index.html';
      var target = '../' + select.value + '/';
      fetch(target + page, { method: 'HEAD' }).then(function (r) { location.href = target + (r.ok ? page : ''); }).catch(function () { location.href = target; });
    });
  }

  var toggle = document.querySelector('.nav-toggle'), side = document.getElementById('side');
  if (toggle) toggle.addEventListener('click', function () { var open = side.classList.toggle('open'); toggle.setAttribute('aria-expanded', String(open)); });

  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (links.length && 'IntersectionObserver' in window) {
    var byId = {}; links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { links.forEach(function (a) { a.classList.remove('active'); }); var a = byId[en.target.id]; if (a) a.classList.add('active'); } });
    }, { rootMargin: '-64px 0px -70% 0px' });
    Object.keys(byId).forEach(function (id) { var el = document.getElementById(id); if (el) obs.observe(el); });
  }
})();
