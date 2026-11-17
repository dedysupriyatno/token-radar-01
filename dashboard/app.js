/* Token Launch Radar — board rendering, sorting, filtering, detail view.
   Data comes from data.js (window.TOKEN_RADAR), written by main.ts from
   the sealed snapshot. No network: no fetch, no external assets. */
(function () {
  'use strict';
  var DATA = window.TOKEN_RADAR;
  var rowsEl = document.getElementById('rows');
  var detailEl = document.getElementById('detail');
  var countEl = document.getElementById('count');
  var emptyEl = document.getElementById('empty');
  var qEl = document.getElementById('q');
  var catEl = document.getElementById('cat');
  var chainEl = document.getElementById('chain');
  var watchEl = document.getElementById('watchOnly');
  var preEl = document.getElementById('preOnly');

  if (!DATA || !Array.isArray(DATA.rows)) {
    rowsEl.innerHTML = '<tr><td colspan="8">No board data found. Run main.ts first — it writes data.js beside the dashboard.</td></tr>';
    return;
  }
  var ROWS = DATA.rows;
  var META = DATA.meta || {};
  var BY_SLUG = {};
  ROWS.forEach(function (r) { BY_SLUG[r.slug] = r; });

  var state = { sort: 'rank', dir: 1, q: '', cat: '', chain: '', watch: false, pre: true, slug: null };

  function money(n) {
    if (n === null || n === undefined) return '—';
    var abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n;
  }
  function pct(n) {
    if (n === null || n === undefined) return '<span class="flat">—</span>';
    var cls = n > 0 ? 'up' : n < 0 ? 'dn' : 'flat';
    var sign = n > 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + n.toFixed(2) + '%</span>';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ageText(r) {
    if (r.age_years === null || r.age_years === undefined) return '—';
    return r.age_years.toFixed(1) + 'y';
  }
  function chainText(r) {
    var c = r.chains || [];
    if (c.length === 0) return '—';
    if (c.length <= 2) return esc(c.join(', '));
    return esc(c[0] + ', ' + c[1] + ' +' + (c.length - 2));
  }

  function fillMeta() {
    document.getElementById('asOf').textContent = META.as_of || '—';
    document.getElementById('asOf2').textContent = META.as_of || '—';
    document.getElementById('statRows').textContent = ROWS.length;
    document.getElementById('statWatch').textContent = META.watchlist_total != null ? META.watchlist_total : ROWS.filter(function (r) { return r.watchlist; }).length;
    document.getElementById('statPre').textContent = META.pre_token_total != null ? META.pre_token_total : '—';
    document.getElementById('statTrading').textContent = META.trading_total != null ? META.trading_total : '—';
    document.getElementById('statFloor').textContent = META.floor_usd ? money(META.floor_usd) : '—';
    var cats = {};
    var chains = {};
    ROWS.forEach(function (r) {
      if (r.category) cats[r.category] = 1;
      (r.chains || []).forEach(function (c) { chains[c] = 1; });
    });
    Object.keys(cats).sort().forEach(function (c) {
      var o = document.createElement('option'); o.value = c; o.textContent = c; catEl.appendChild(o);
    });
    Object.keys(chains).sort().forEach(function (c) {
      var o = document.createElement('option'); o.value = c; o.textContent = c; chainEl.appendChild(o);
    });
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return ROWS.filter(function (r) {
      if (state.pre && r.has_token) return false;
      if (state.watch && !r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  function sorted(list) {
    var k = state.sort;
    var d = state.dir;
    return list.slice().sort(function (a, b) {
      var av = a[k], bv = b[k];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'string') return av.localeCompare(bv) * d;
      return (av - bv) * d || (a.rank - b.rank);
    });
  }

  function render() {
    var list = sorted(filtered());
    var html = list.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.slug === r.slug ? ' class="sel"' : '') + '>' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><span class="nm">' + esc(r.name) + '</span>' +
        (r.watchlist ? '<span class="tag">WATCHLIST</span>' : '') +
        '<br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + chainText(r) + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num"><strong>' + money(r.implied_value_usd) + '</strong></td>' +
        '<td class="num">' + ageText(r) + '</td></tr>';
    }).join('');
    rowsEl.innerHTML = html;
    emptyEl.hidden = list.length !== 0;
    countEl.textContent = 'Showing ' + list.length + ' of ' + ROWS.length + ' ranked protocols' +
      (state.watch ? ' · watchlist only' : '') + (state.cat ? ' · ' + state.cat : '') +
      (state.chain ? ' · ' + state.chain : '') + '. Click a row for its detail and farm plan.';
    document.querySelectorAll('thead button').forEach(function (b) {
      if (b.getAttribute('data-sort') === state.sort) {
        b.setAttribute('aria-sort', state.dir === 1 ? 'ascending' : 'descending');
      } else { b.removeAttribute('aria-sort'); }
    });
  }

  function breakdown(r) {
    var base = money(r.tvl_usd) + ' TVL';
    var cat = '× ' + r.category_multiple.toFixed(2) + ' (' + esc(r.category || 'no category') + ')';
    var gro = '× ' + r.growth_factor.toFixed(2) + ' (7d ' + (r.change_7d === null ? 'not reported' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(2) + '%') + ')';
    var age = '× ' + r.age_factor.toFixed(2) + ' (' + (r.age_years === null ? 'listing date not reported' : r.age_years.toFixed(1) + ' years listed') + ')';
    return base + ' ' + cat + ' ' + gro + ' ' + age + ' = <strong>' + money(r.implied_value_usd) + '</strong>';
  }

  function showDetail(slug) {
    var r = BY_SLUG[slug];
    if (!r) { detailEl.hidden = true; detailEl.innerHTML = ''; state.slug = null; render(); return; }
    state.slug = slug;
    var listed = r.listed_at ? esc(r.listed_at) : 'Not reported';
    var tokenLine = r.watchlist
      ? 'On the watchlist: TVL at or above the $50,000,000 floor and no token recorded.'
      : 'Below the watchlist floor or outside the watchlist rule, but ranked here because it records no token.';
    detailEl.innerHTML =
      '<button class="close" type="button" id="closeDetail">Close ✕</button>' +
      '<h2>' + esc(r.name) + (r.watchlist ? ' <span class="tag">WATCHLIST</span>' : '') + '</h2>' +
      '<p class="sub">Rank #' + r.rank + ' · ' + esc(r.slug) + ' · ' + esc(r.category || 'No category') + ' · ' +
      '<span class="badge">RECORDS NO TOKEN</span> — the snapshot carries no CoinGecko id, symbol or market cap for it; that is the record, not proof it has no token.</p>' +
      '<dl class="grid">' +
      '<div><dt>TVL</dt><dd>' + money(r.tvl_usd) + '</dd></div>' +
      '<div><dt>7-day TVL change</dt><dd>' + (r.change_7d === null ? 'Not reported' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(2) + '%') + '</dd></div>' +
      '<div><dt>Implied value</dt><dd>' + money(r.implied_value_usd) + '</dd></div>' +
      '<div><dt>Listed since</dt><dd>' + listed + '</dd></div>' +
      '<div><dt>Age</dt><dd>' + ageText(r) + '</dd></div>' +
      '<div><dt>Chains</dt><dd>' + esc((r.chains || []).join(', ') || '—') + '</dd></div>' +
      '</dl>' +
      '<h3>Implied-value breakdown</h3><p class="math">' + breakdown(r) + '</p>' +
      '<h3>How to farm it</h3><ol>' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p class="sub">' + esc(tokenLine) + '</p>';
    detailEl.hidden = false;
    document.getElementById('closeDetail').addEventListener('click', function () { showDetail(null); syncUrl(); });
    render();
    detailEl.scrollIntoView({ block: 'nearest' });
  }

  function syncUrl() {
    var p = new URLSearchParams();
    if (state.slug) p.set('slug', state.slug);
    if (state.cat) p.set('filter', state.cat);
    var qs = p.toString();
    var url = window.location.pathname + (qs ? '?' + qs : '');
    window.history.replaceState(null, '', url);
  }

  function bind() {
    qEl.addEventListener('input', function () { state.q = qEl.value; render(); });
    catEl.addEventListener('change', function () { state.cat = catEl.value; render(); syncUrl(); });
    chainEl.addEventListener('change', function () { state.chain = chainEl.value; render(); });
    watchEl.addEventListener('change', function () { state.watch = watchEl.checked; render(); });
    preEl.addEventListener('change', function () { state.pre = preEl.checked; render(); });
    document.querySelectorAll('thead button').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-sort');
        if (state.sort === k) { state.dir = -state.dir; } else { state.sort = k; state.dir = k === 'name' || k === 'category' ? 1 : -1; }
        render();
      });
    });
    rowsEl.addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-slug]');
      if (tr) { showDetail(tr.getAttribute('data-slug')); syncUrl(); }
    });
  }

  function initFromUrl() {
    var p = new URLSearchParams(window.location.search);
    var slug = p.get('slug');
    var filter = p.get('filter');
    if (filter) {
      var ok = Array.prototype.some.call(catEl.options, function (o) { return o.value === filter; });
      if (ok) { state.cat = filter; catEl.value = filter; }
    }
    if (slug && BY_SLUG[slug]) showDetail(slug);
  }

  fillMeta();
  bind();
  initFromUrl();
  render();
  if (state.slug) showDetail(state.slug);
})();
