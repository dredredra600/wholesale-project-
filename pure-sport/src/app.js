(function () {
  'use strict';
  const P = window.PSD;
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = P.clone;
  const PAGES = [
    ['home', 'Home', 'Galaxy overview'], ['leads', 'Leads', 'One record per customer'], ['intake', 'Lead Intake', 'Agent'],
    ['quote', 'Quote Assistant', 'Agent'], ['booking', 'Booking', 'Agent'], ['followup', 'Follow-Up', 'Agent'],
    ['content', 'Content', 'Agent'], ['chat', 'Chat', 'Ask Claude'], ['setup', 'Setup', 'Your answers and connections'],
  ];

  /* ---------- state and storage ---------- */
  const S = { leads: {}, content: {}, config: clone(P.DEFAULT_CONFIG), mode: 'local', ready: false, errors: [], chat: [], open: null, filter: 'all', busy: false };
  let db = null, sample = null;
  const LS = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  const lastVisit = LS.get('psd.last');
  LS.set('psd.last', new Date().toISOString());

  function mergeConfig(c) {
    const d = clone(P.DEFAULT_CONFIG);
    c = c || {};
    return Object.assign(d, c, {
      business: Object.assign(d.business, c.business), instagram: Object.assign(d.instagram, c.instagram),
      links: Object.assign(d.links, c.links), templates: Object.assign(d.templates, c.templates),
      connections: Object.assign(d.connections, c.connections), pricing: c.pricing || [],
    });
  }
  function localSave() { LS.set('psd.v1', JSON.stringify({ leads: S.leads, content: S.content, config: S.config })); }
  function localLoad() {
    try { const j = JSON.parse(LS.get('psd.v1') || 'null'); if (j) { S.leads = j.leads || {}; S.content = j.content || {}; S.config = mergeConfig(j.config); } } catch (e) {}
  }
  const plain = (o) => JSON.parse(JSON.stringify(o));
  async function saveLead(l) {
    S.leads[l.id] = l;
    if (db) { try { await db.doc('leads/' + l.id).set(plain(l)); } catch (e) { fail('Could not save lead: ' + (e.message || e.code)); } } else localSave();
    refresh();
  }
  async function saveLeads(map) {
    S.leads = map;
    if (db) { try { await Promise.all(Object.values(map).map((l) => db.doc('leads/' + l.id).set(plain(l)))); } catch (e) { fail('Could not save leads: ' + (e.message || e.code)); } } else localSave();
    refresh();
  }
  async function removeLeads(ids) {
    ids.forEach((id) => delete S.leads[id]);
    if (db) { try { await Promise.all(ids.map((id) => db.doc('leads/' + id).delete())); } catch (e) { fail('Could not delete: ' + (e.message || e.code)); } } else localSave();
    refresh();
  }
  async function saveConfig() {
    if (db) { try { await db.doc('config/main').set(plain(S.config)); } catch (e) { fail('Could not save setup: ' + (e.message || e.code)); return; } } else localSave();
    toast('Setup saved'); refresh();
  }
  async function saveContent(c) {
    S.content[c.id] = c;
    if (db) { try { await db.doc('content/' + c.id).set(plain(c)); } catch (e) { fail('Could not save draft: ' + (e.message || e.code)); } } else localSave();
    refresh();
  }
  async function removeContent(id) {
    delete S.content[id];
    if (db) { try { await db.doc('content/' + id).delete(); } catch (e) { fail('Could not delete: ' + (e.message || e.code)); } } else localSave();
    refresh();
  }
  function fail(msg, agent) { S.errors.unshift({ at: new Date().toISOString(), agent: agent || 'system', text: msg }); toast(msg); }

  async function boot() {
    localLoad();
    try { db = await window.claude.use('db'); } catch (e) { db = null; }
    try { sample = await window.claude.use('sample'); } catch (e) { sample = null; }
    if (db) {
      S.mode = 'shared';
      let loaded = 0;
      const done = () => { loaded++; if (loaded >= 3) { S.ready = true; } refresh(true); };
      const err = (e) => { fail('Shared storage error: ' + (e.message || e.code)); if (e.code === 'revoked') { db = null; S.mode = 'local'; } };
      db.collection('leads').onSnapshot((snap) => { const m = {}; snap.docs.forEach((d) => { m[d.id] = d.data(); }); S.leads = m; done(); }, err);
      db.collection('content').onSnapshot((snap) => { const m = {}; snap.docs.forEach((d) => { m[d.id] = d.data(); }); S.content = m; done(); }, err);
      db.doc('config/main').onSnapshot((d) => { if (d.exists) S.config = mergeConfig(d.data()); done(); }, err);
      setTimeout(() => { if (!S.ready) { S.ready = true; refresh(true); } }, 10000);
    } else { S.ready = true; }
    buildChatPanel();
    route();
  }

  /* ---------- helpers ---------- */
  function toast(msg) {
    const old = $('.toast'); if (old) old.remove();
    const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 3200);
  }
  function copy(text) {
    const done = () => toast('Copied');
    try { navigator.clipboard.writeText(text).then(done, () => toast('Select the text and copy it by hand')); } catch (e) { toast('Select the text and copy it by hand'); }
  }
  const when = (iso) => { try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };
  const ago = (iso) => {
    if (!iso) return '';
    const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
    if (m < 60) return Math.round(m) + ' min ago'; if (m < 1440) return Math.round(m / 60) + ' hours ago'; return Math.round(m / 1440) + ' days ago';
  };
  const leadsArr = () => Object.values(S.leads).sort((a, b) => Date.parse(b.stageAt) - Date.parse(a.stageAt));
  const stagePill = (l) => {
    const tone = { new: '', needs_info: 'warn', ready_to_quote: 'warn', awaiting_approval: 'warn', approved: 'ok', booking_handoff: 'warn', booked: 'ok', followup: 'warn', closed: '' }[l.stage] || '';
    return '<span class="badge ' + tone + '">' + esc(P.STAGES[l.stage] || l.stage) + '</span>';
  };
  const srcPill = (l) => '<span class="badge">' + esc(l.source) + '</span>';
  const sampleBadge = (l) => (l.sample ? ' <span class="badge sample">Sample</span>' : '');
  const money = (n) => '$' + Number(n).toLocaleString();

  function openQuestions() {
    const c = S.config; const q = [];
    if (!c.pricing.some((r) => r.service && (r.sedan || r.suv || r.truck))) q.push('Add your pricing rules');
    if (c.templatesAreSample) q.push('Write your PRICE and BOOK reply templates');
    if (!c.links.booking) q.push('Add your approved booking link');
    if (!c.links.form) q.push('Add your Google Form link');
    if (!c.instagram.handle) q.push('Add your Instagram handle');
    if (!c.instagram.testReel) q.push('Pick the test Reel');
    if (!c.links.review) q.push('Add your Google review link');
    return q;
  }
  function counts() { return P.summary(S.leads, S.content, S.config); }
  function agentStats(id) {
    const L = leadsArr(); const due = P.followUps(S.leads, S.config);
    return {
      intake: { n: L.length, label: 'leads' },
      quote: { n: L.filter((l) => ['ready_to_quote', 'awaiting_approval'].includes(l.stage)).length, label: 'quotes' },
      booking: { n: L.filter((l) => ['approved', 'booking_handoff', 'booked'].includes(l.stage)).length, label: 'jobs' },
      followup: { n: due.length, label: 'due' },
      content: { n: Object.keys(S.content).length, label: 'drafts' },
    }[id];
  }

  /* ---------- routing and shell ---------- */
  let galaxy = null;
  function current() { const h = (location.hash || '#home').slice(1); return PAGES.some((p) => p[0] === h) ? h : 'home'; }
  function route() {
    if (location.hash === '#chat') { location.hash = 'home'; openChat(true); return; }
    if (galaxy) { galaxy.stop(); galaxy = null; }
    const id = current();
    const view = $('#view');
    view.innerHTML = '';
    document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === id));
    window.scrollTo(0, 0);
    if (id === 'home') return buildHome();
    renderPage(id);
  }
  function refresh(force) {
    const a = document.activeElement;
    const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && !force;
    $('#sampleflag').hidden = !Object.values(S.leads).some((l) => l.sample);
    if (current() === 'home') updateHome();
    else if (!typing || !$('#view').contains(a)) renderPage(current());
    renderDrawer();
  }
  window.addEventListener('hashchange', route);

  /* ---------- home / galaxy ---------- */
  const NODE_AGENTS = [['intake', 190], ['content', 250], ['quote', 315], ['booking', 20], ['followup', 110]];
  function greet() { const h = new Date().getHours(); return h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.'; }

  function buildHome() {
    $('#view').innerHTML = '<section class="home"><div class="stage" id="stage"><canvas id="sky" aria-hidden="true"></canvas><div id="labels"></div>' +
      '<div class="dock" role="toolbar" aria-label="Galaxy controls"><button data-g="out" aria-label="Zoom out">−</button><button data-g="in" aria-label="Zoom in">+</button><button data-g="reset" aria-label="Reset view">↺</button><button data-g="pause" aria-label="Pause motion">❚❚</button></div></div>' +
      '<aside class="panel-home" id="panel"></aside></section>';
    galaxy = startGalaxy($('#sky'), $('#stage'));
    $('#stage').addEventListener('click', (e) => {
      const g = e.target.closest('[data-g]'); if (!g) return;
      const k = g.dataset.g;
      if (k === 'in') galaxy.zoom(1.2); else if (k === 'out') galaxy.zoom(1 / 1.2); else if (k === 'reset') galaxy.zoom(0); else if (k === 'pause') { const p = galaxy.togglePause(); g.textContent = p ? '▶' : '❚❚'; g.setAttribute('aria-label', p ? 'Resume motion' : 'Pause motion'); }
    });
    updateHome();
  }
  function updateHome() {
    if (!$('#panel') || !galaxy) return;
    const c = counts(); const q = openQuestions();
    const row = (n, label, href) => '<li><a href="' + href + '"><span class="n ' + (n ? '' : 'zero') + '">' + n + '</span><span>' + label + '</span></a></li>';
    const since = lastVisit ? 'Since you were last here · ' + ago(lastVisit) : 'First visit';
    const empty = !c.total ? '<p class="lead-line">No leads yet. Open <a href="#intake">Lead Intake</a> to load labeled sample data or paste rows from your Google Sheet.</p>' : '<p class="lead-line">' + (c.quotesToApprove + c.needsPricing ? 'You have quotes waiting on you.' : 'Nothing is waiting on you right now.') + '</p>';
    $('#panel').innerHTML = '<h1>' + greet() + '</h1><div class="sub">' + since + ' · ' + (S.mode === 'shared' ? 'saved to your dashboard' : 'saved in this browser only') + '</div>' + empty +
      '<div class="eyebrow">Needs you</div><ul class="up">' +
      row(c.newLeads, 'New leads', '#leads') + row(c.quotesToApprove + c.needsPricing, 'Quotes to approve or price', '#quote') + row(c.upcomingJobs, 'Upcoming jobs', '#booking') + row(c.followUpsDue, 'Follow-ups due', '#followup') + row(c.contentDrafts, 'Content drafts', '#content') + '</ul>' +
      (q.length ? '<div class="eyebrow">Questions for you</div><ul class="q-list">' + q.slice(0, 4).map((x) => '<li><a href="#setup">' + esc(x) + '</a></li>').join('') + (q.length > 4 ? '<li><a href="#setup">+ ' + (q.length - 4) + ' more in Setup</a></li>' : '') + '</ul>' : '');
    galaxy.setAgents(NODE_AGENTS.map(([id, ang]) => ({ id, ang, name: P.AGENTS.find((a) => a.id === id).name, n: agentStats(id).n, label: agentStats(id).label })));
  }

  function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function startGalaxy(canvas, stage) {
    const ctx = canvas.getContext('2d');
    const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const rnd = mulberry(11);
    let W = 0, H = 0, dpr = 1, zoomK = 1, paused = false, raf = 0, T = 0, agents = [], clusters = [];
    const stars = Array.from({ length: 340 }, () => ({ x: rnd(), y: rnd(), r: rnd() * 1.1 + 0.2, a: rnd() * 0.7 + 0.2, p: rnd() * 6.28 }));
    const disk = Array.from({ length: 300 }, () => ({ a: rnd() * 6.28, r: 0.075 + Math.pow(rnd(), 1.7) * 0.25, s: 0.4 + rnd() * 0.6, b: rnd() }));
    const dust = Array.from({ length: 6 }, () => ({ x: rnd(), y: rnd(), r: 0.25 + rnd() * 0.3, a: 0.025 + rnd() * 0.03 }));
    const M = () => Math.min(W, H);
    function size() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = stage.clientWidth; H = stage.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      layout(); draw(); labels();
    }
    function layout() {
      const mob = W < 640; const rx = mob ? W * 0.34 : Math.min(W * 0.33, H * 0.62), ry = mob ? H * 0.34 : H * 0.31;
      clusters = agents.map((a, i) => {
        const r = mnr(i + 3); const rad = a.ang * Math.PI / 180;
        const cx = Math.cos(rad) * rx, cy = Math.sin(rad) * ry;
        const count = Math.min(70, 26 + a.n * 3); const R = M() * (mob ? 0.1 : 0.115);
        const nodes = Array.from({ length: count }, () => { const t = r() * 6.28, d = Math.sqrt(r()) * R; return { x: Math.cos(t) * d * 1.25, y: Math.sin(t) * d, ph: r() * 6.28, sz: 0.6 + r() * 1.6 }; });
        return { cx, cy, nodes, a };
      });
    }
    const mnr = (s) => mulberry(s * 977);
    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#05060a'; ctx.fillRect(0, 0, W, H);
      dust.forEach((d) => { const g = ctx.createRadialGradient(d.x * W, d.y * H, 0, d.x * W, d.y * H, d.r * M()); g.addColorStop(0, 'rgba(130,140,170,' + d.a + ')'); g.addColorStop(1, 'rgba(130,140,170,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); });
      stars.forEach((s) => { const tw = rm ? 1 : 0.6 + 0.4 * Math.sin(T * 0.8 + s.p); ctx.globalAlpha = s.a * tw; ctx.fillStyle = '#dfe6ff'; ctx.beginPath(); ctx.arc(s.x * W, s.y * H, s.r, 0, 6.283); ctx.fill(); });
      ctx.globalAlpha = 1;
      ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(zoomK, zoomK);
      ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
      [[0.46, 0.4, 0.2, 2.6], [0.66, 0.54, 3.4, 5.2], [0.86, 0.7, 5.6, 8.1]].forEach(([fx, fy, a0, a1], i) => { ctx.beginPath(); ctx.ellipse(0, 0, W * fx, H * fy, i * 0.12, a0, a1); ctx.stroke(); });
      clusters.forEach((c) => {
        ctx.save(); ctx.translate(c.cx, c.cy);
        const pts = c.nodes.map((n) => ({ x: n.x + (rm ? 0 : Math.sin(T * 0.3 + n.ph) * 3), y: n.y + (rm ? 0 : Math.cos(T * 0.27 + n.ph) * 3), sz: n.sz }));
        ctx.lineWidth = 0.6;
        for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) { const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, d = Math.hypot(dx, dy); if (d < 46) { ctx.strokeStyle = 'rgba(190,205,255,' + (0.26 * (1 - d / 46)) + ')'; ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke(); } }
        pts.forEach((p) => { ctx.fillStyle = 'rgba(235,240,255,.9)'; ctx.beginPath(); ctx.arc(p.x, p.y, p.sz, 0, 6.283); ctx.fill(); });
        ctx.restore();
      });
      const m = M(), r0 = m * 0.058;
      const pdraw = (front) => disk.forEach((p) => {
        const a = p.a + (rm ? 0 : T * p.s * 0.18 / (p.r * 7));
        const x = Math.cos(a) * p.r * m * 1.7, y = Math.sin(a) * p.r * m * 0.2;
        if ((y > 0) !== front) return;
        const k = 1 - Math.min(1, (p.r - 0.075) / 0.25);
        ctx.fillStyle = 'rgba(255,' + Math.round(170 + 80 * k) + ',' + Math.round(90 + 140 * k * k) + ',' + (0.25 + 0.6 * k) + ')';
        ctx.beginPath(); ctx.arc(x, y, 0.6 + p.b * 1.1, 0, 6.283); ctx.fill();
      });
      pdraw(false);
      const halo = ctx.createRadialGradient(0, 0, r0 * 0.9, 0, 0, r0 * 3.2); halo.addColorStop(0, 'rgba(255,170,80,.38)'); halo.addColorStop(1, 'rgba(255,170,80,0)'); ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(0, 0, r0 * 3.2, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(0, 0, r0, 0, 6.283); ctx.fill();
      ctx.save(); ctx.shadowColor = '#ffb561'; ctx.shadowBlur = 16; ctx.strokeStyle = 'rgba(255,222,170,.95)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, r0 * 1.06, 0, 6.283); ctx.stroke(); ctx.restore();
      pdraw(true);
      ctx.save(); ctx.scale(1, 0.07); const fl = ctx.createRadialGradient(0, 0, 0, 0, 0, r0 * 3.6); fl.addColorStop(0, 'rgba(255,240,215,1)'); fl.addColorStop(0.25, 'rgba(255,190,110,.75)'); fl.addColorStop(1, 'rgba(255,170,80,0)'); ctx.fillStyle = fl; ctx.beginPath(); ctx.arc(0, 0, r0 * 3.6, 0, 6.283); ctx.fill(); ctx.restore();
      ctx.restore();
    }
    function labels() {
      const box = $('#labels'); if (!box) return;
      box.innerHTML = clusters.map((c) => '<button class="label" data-go="' + c.a.id + '" style="left:' + (W / 2 + c.cx * zoomK) + 'px;top:' + (H / 2 + c.cy * zoomK + 4) + 'px"><b>' + esc(c.a.name) + '</b><small>' + c.a.n + ' ' + esc(c.a.n === 1 ? c.a.label.replace(/s$/, "") : c.a.label) + '</small></button>').join('');
      box.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.go; }));
    }
    function loop(ts) { T = ts / 1000; if (!paused) draw(); raf = requestAnimationFrame(loop); }
    const ro = new ResizeObserver(size); ro.observe(stage);
    size();
    if (!rm) raf = requestAnimationFrame(loop);
    return {
      stop() { cancelAnimationFrame(raf); ro.disconnect(); },
      setAgents(a) { agents = a; layout(); draw(); labels(); },
      zoom(f) { zoomK = f === 0 ? 1 : Math.max(0.6, Math.min(2.2, zoomK * f)); draw(); labels(); },
      togglePause() { paused = !paused; return paused; },
    };
  }

  /* ---------- pages ---------- */
  function head(id, title, blurb, stats) {
    return '<div class="page-head"><h1>' + esc(title) + '</h1><p>' + esc(blurb) + '</p>' + (stats ? '<div class="stats">' + stats.map((s) => '<span><b>' + s[0] + '</b>' + esc(s[1]) + '</span>').join('') + '</div>' : '') + '</div>';
  }
  function renderPage(id) {
    const v = $('#view');
    const fn = { leads: pgLeads, intake: pgIntake, quote: pgQuote, booking: pgBooking, followup: pgFollow, content: pgContent, setup: pgSetup }[id];
    if (!fn) return;
    const st = v.scrollTop; v.innerHTML = '<div class="page">' + fn() + '</div>'; v.scrollTop = st;
  }
  const historyBy = (agentName) => { const o = []; Object.values(S.leads).forEach((l) => l.history.forEach((h) => { if (h.agent === agentName) o.push(Object.assign({ lead: l }, h)); })); return o.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); };
  function handledList(agentName) {
    const h = historyBy(agentName).slice(0, 12);
    return h.length ? '<div class="card">' + h.map((x) => '<div class="item"><div class="t"><b>' + esc(x.action) + '</b><span class="muted">@' + esc(x.lead.handle) + sampleBadge(x.lead) + ' · ' + when(x.at) + '</span></div>' + (x.detail ? '<div class="muted">' + esc(x.detail) + '</div>' : '') + '</div>').join('') + '</div>' : '<div class="empty">Nothing handled yet.</div>';
  }
  function errorList(agentId, extra) {
    const e = S.errors.filter((x) => x.agent === agentId).map((x) => '<div class="item"><div class="t"><span class="badge bad">Error</span><span class="muted">' + when(x.at) + '</span></div><div>' + esc(x.text) + '</div></div>').concat(extra || []);
    return e.length ? '<div class="card">' + e.join('') + '</div>' : '<div class="empty">No errors.</div>';
  }
  function leadLine(l) { return '<div class="t"><b>@' + esc(l.handle) + '</b>' + srcPill(l) + stagePill(l) + sampleBadge(l) + '<span class="muted">' + esc([l.vehicle, l.service].filter(Boolean).join(' · ') || 'No vehicle or service yet') + '</span></div>'; }
  const openBtn = (l) => '<button class="btn ghost" data-act="open" data-id="' + esc(l.id) + '">Open record</button>';

  function pgLeads() {
    const L = leadsArr();
    const filters = [['all', 'All'], ['new', 'New'], ['needs_info', 'Needs info'], ['ready_to_quote', 'Ready to quote'], ['awaiting_approval', 'To approve'], ['approved', 'Approved'], ['booking_handoff', 'Booking'], ['booked', 'Booked']];
    const shown = L.filter((l) => S.filter === 'all' || (S.filter === 'new' ? l.isNew : l.stage === S.filter));
    return head('leads', 'Leads', 'Every inquiry lives in one record that follows the customer from inquiry to quote to booking.', [[L.length, 'total'], [L.filter((l) => l.isNew).length, 'new']]) +
      '<div class="chips">' + filters.map((f) => '<button class="chip ' + (S.filter === f[0] ? 'on' : '') + '" data-act="filter" data-v="' + f[0] + '">' + f[1] + '</button>').join('') + '</div>' +
      (shown.length ? '<div class="tbl-wrap"><table><thead><tr><th>Customer</th><th>Source</th><th>Vehicle</th><th>Service</th><th>Stage</th><th>Updated</th></tr></thead><tbody>' +
        shown.map((l) => '<tr class="click" data-act="open" data-id="' + esc(l.id) + '"><td>@' + esc(l.handle) + sampleBadge(l) + (l.isNew ? ' <span class="badge warn">New</span>' : '') + (l.repeatCount ? ' <span class="muted">+' + l.repeatCount + ' repeat</span>' : '') + '</td><td>' + srcPill(l) + '</td><td>' + esc(l.vehicle || '—') + '</td><td>' + esc(l.service || '—') + '</td><td>' + stagePill(l) + '</td><td class="muted">' + ago(l.stageAt) + '</td></tr>').join('') + '</tbody></table></div>'
        : '<div class="empty">No leads here yet. Go to <a href="#intake">Lead Intake</a> to paste rows from your Sheet or load labeled sample data.</div>');
  }

  function pgIntake() {
    const L = leadsArr(); const need = L.filter((l) => P.missingDetails(l).length);
    const sampleCount = L.filter((l) => l.sample).length;
    return head('intake', 'Lead Intake', P.AGENTS[0].blurb, [[L.length, 'captured'], [need.length, 'need details'], [S.errors.filter((e) => e.agent === 'intake').length, 'errors']]) +
      '<div class="sec"><h2>Add inquiries</h2><div class="card"><div class="fld"><label for="paste">Paste rows copied from your Google Sheet (include the header row)</label><textarea id="paste" placeholder="Timestamp\tInstagram handle\tKeyword\tReel\tName\t..."></textarea></div>' +
      '<div class="row"><button class="btn go" data-act="import">Import rows</button><button class="btn" data-act="sample">Load sample data</button>' + (sampleCount ? '<button class="btn ghost" data-act="clear-sample">Remove ' + sampleCount + ' sample leads</button>' : '') + '</div>' +
      '<div class="muted">Re-pasting the same rows is safe. Rows are matched on Instagram handle and keyword, so repeats never create a second lead. Automatic Sheet sync needs a connector and comes next. Sample leads are labeled Sample.</div></div></div>' +
      '<div class="sec"><h2>Needs your attention <small>' + need.length + '</small></h2>' + (need.length ? '<div class="card">' + need.map((l) => '<div class="item">' + leadLine(l) + '<div class="muted">Missing ' + P.missingDetails(l).join(' and ') + '. Ask for it in your template reply or open the record to fill it in.</div><div class="row">' + openBtn(l) + '</div></div>').join('') + '</div>' : '<div class="empty">Every lead has a vehicle and a service.</div>') + '</div>' +
      '<div class="sec"><h2>Handled</h2>' + handledList('Lead Intake') + '</div>' +
      '<div class="sec"><h2>Errors</h2>' + errorList('intake') + '</div>';
  }

  function quoteCard(l) {
    const amt = l.quote && l.quote.amount ? l.quote.amount : '';
    let body = '';
    if (l.stage === 'ready_to_quote' && !l.quote) body = '<div class="row"><button class="btn go" data-act="draftq" data-id="' + esc(l.id) + '">Draft quote</button>' + openBtn(l) + '</div>';
    else if (l.stage === 'ready_to_quote') body = '<div class="muted"><span class="badge warn">Pricing needed</span> ' + esc(l.quote.reason) + '</div><div class="row"><div class="fld" style="width:140px"><label for="amt-' + esc(l.id) + '">Your price ($)</label><input id="amt-' + esc(l.id) + '" type="number" min="1" step="1" inputmode="decimal"></div><button class="btn go" data-act="approveq" data-id="' + esc(l.id) + '">Approve at this price</button><button class="btn" data-act="draftq" data-id="' + esc(l.id) + '">Redraft</button>' + openBtn(l) + '</div>';
    else body = '<div class="row"><div class="fld" style="width:140px"><label for="amt-' + esc(l.id) + '">Quote ($)</label><input id="amt-' + esc(l.id) + '" type="number" min="1" step="1" value="' + esc(amt) + '"></div><button class="btn go" data-act="approveq" data-id="' + esc(l.id) + '">Approve quote</button><button class="btn" data-act="draftq" data-id="' + esc(l.id) + '">Redraft</button>' + openBtn(l) + '</div>';
    return '<div class="item">' + leadLine(l) + body + (l.reply ? '<div class="muted">Reply draft' + (l.reply.sampleTemplate ? ' (sample template, edit in Setup)' : '') + (l.reply.missing.length ? ' · missing: ' + esc(l.reply.missing.join(', ')) : '') + '</div><div class="copybox">' + esc(l.reply.text) + '</div>' : '') + '</div>';
  }
  function pgQuote() {
    const L = leadsArr(); const todo = L.filter((l) => ['ready_to_quote', 'awaiting_approval'].includes(l.stage));
    const sent = L.filter((l) => l.stage === 'approved');
    return head('quote', 'Quote Assistant', P.AGENTS[1].blurb, [[todo.length, 'need you'], [L.filter((l) => l.quote && l.quote.status === 'needs_review' && l.stage === 'ready_to_quote').length, 'missing pricing'], [sent.length, 'approved']]) +
      '<div class="sec"><h2>Needs your attention <small>' + todo.length + '</small></h2>' + (todo.length ? '<div class="card">' + todo.map(quoteCard).join('') + '</div>' : '<div class="empty">No quotes are waiting. New leads with a vehicle and service show up here.</div>') + '</div>' +
      '<div class="sec"><h2>Approved, reply to send</h2>' + (sent.length ? '<div class="card">' + sent.map((l) => '<div class="item">' + leadLine(l) + (l.reply ? '<div class="copybox">' + esc(l.reply.text) + '</div><div class="row"><button class="btn" data-act="copy" data-id="' + esc(l.id) + '">Copy reply</button>' + (l.reply.status === 'sent_by_owner' ? '<span class="badge ok">You sent it</span>' : '<button class="btn" data-act="sent" data-id="' + esc(l.id) + '">I sent it</button>') + openBtn(l) + '</div>' : '') + '</div>').join('') + '</div>' : '<div class="empty">Approved quotes appear here with the reply for you to send. Nothing is sent for you.</div>') + '</div>' +
      '<div class="sec"><h2>Handled</h2>' + handledList('Quote Assistant') + '</div>' +
      '<div class="sec"><h2>Errors</h2>' + errorList('quote', S.config.pricing.some((r) => r.service) ? [] : ['<div class="item"><span class="badge warn">Setup</span> No pricing rules saved. Every quote goes to you until you add them in <a href="#setup">Setup</a>.</div>']) + '</div>';
  }

  function pgBooking() {
    const L = leadsArr();
    const ready = L.filter((l) => l.stage === 'approved' || (l.keyword === 'BOOK' && !P.missingDetails(l).length && ['ready_to_quote', 'awaiting_approval'].includes(l.stage)));
    const hand = L.filter((l) => l.stage === 'booking_handoff'); const booked = L.filter((l) => l.stage === 'booked');
    return head('booking', 'Booking', P.AGENTS[2].blurb, [[ready.length, 'ready for handoff'], [hand.length, 'awaiting confirmation'], [booked.length, 'booked']]) +
      '<div class="sec"><h2>Needs your attention <small>' + (ready.length + hand.length) + '</small></h2>' +
      (ready.length + hand.length ? '<div class="card">' +
        ready.map((l) => '<div class="item">' + leadLine(l) + '<div class="row"><label class="muted"><input type="checkbox" id="cs-' + esc(l.id) + '"> Needs a custom time slot</label><button class="btn go" data-act="prep" data-id="' + esc(l.id) + '">Prepare booking</button>' + openBtn(l) + '</div></div>').join('') +
        hand.map((l) => '<div class="item">' + leadLine(l) + (l.booking.status === 'link_ready' ? '<div class="muted">Send this approved link:</div><div class="copybox">' + esc(l.booking.link) + '</div>' : '<div class="muted"><span class="badge warn">Custom slot</span> ' + esc(l.booking.reason) + '</div>') + '<div class="row"><div class="fld" style="width:220px"><label for="slot-' + esc(l.id) + '">Confirmed date and time</label><input id="slot-' + esc(l.id) + '" type="datetime-local"></div><button class="btn go" data-act="confirm" data-id="' + esc(l.id) + '">Mark booked</button>' + openBtn(l) + '</div><div class="muted">A job is marked booked only after you confirm the time here.</div></div>').join('') + '</div>' : '<div class="empty">No jobs are waiting for a booking handoff.</div>') + '</div>' +
      '<div class="sec"><h2>Upcoming jobs</h2>' + (booked.length ? '<div class="card">' + booked.sort((a, b) => Date.parse(a.booking.slot) - Date.parse(b.booking.slot)).map((l) => '<div class="item">' + leadLine(l) + '<div class="muted">' + when(l.booking.slot) + '</div></div>').join('') + '</div>' : '<div class="empty">Confirmed jobs appear here. Calendar holds come from the Google Calendar connection once you approve it.</div>') + '</div>' +
      '<div class="sec"><h2>Handled</h2>' + handledList('Booking') + '</div><div class="sec"><h2>Errors</h2>' + errorList('booking', S.config.links.booking ? [] : ['<div class="item"><span class="badge warn">Setup</span> No booking link saved. Every job is flagged as a custom slot until you add one in <a href="#setup">Setup</a>.</div>']) + '</div>';
  }

  function pgFollow() {
    const due = P.followUps(S.leads, S.config);
    return head('followup', 'Follow-Up', P.AGENTS[3].blurb, [[due.length, 'due'], [due.filter((d) => d.kind === 'quote').length, 'open quotes'], [due.filter((d) => d.kind === 'review').length, 'review requests']]) +
      '<div class="sec"><h2>Needs your attention <small>' + due.length + '</small></h2>' + (due.length ? '<div class="card">' + due.map((d, i) => { const l = S.leads[d.leadId]; return '<div class="item">' + leadLine(l) + '<div class="muted">' + (d.kind === 'quote' ? 'Open quote, no movement since ' : 'Job finished ') + when(d.since) + '</div><div class="copybox" id="fu-' + i + '">' + esc(d.draft) + '</div><div class="row"><button class="btn" data-act="copytext" data-v="' + esc(d.draft) + '">Copy draft</button>' + openBtn(l) + '</div></div>'; }).join('') + '</div>' : '<div class="empty">No follow-ups are due. Quotes with no movement for ' + S.config.followupDays + ' days and finished jobs appear here.</div>') + '</div>' +
      '<div class="sec"><h2>Handled</h2>' + handledList('Follow-Up') + '</div><div class="sec"><h2>Errors</h2>' + errorList('followup') + '</div>';
  }

  function pgContent() {
    const C = Object.values(S.content).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const pub = S.config.publishing === 'buffer' && S.config.connections.buffer;
    return head('content', 'Content', P.AGENTS[4].blurb, [[C.filter((c) => c.status === 'draft').length, 'drafts'], [C.filter((c) => c.status === 'approved').length, 'approved']]) +
      '<div class="sec"><h2>Draft a Reel</h2><div class="card"><div class="fld"><label for="notes">Footage notes: what the car was, what you did, the before and after</label><textarea id="notes" placeholder="2021 Tahoe, heavy pet hair, full interior extraction, finished with leather conditioner."></textarea></div><div class="row"><div class="fld" style="width:140px"><label for="cta">Call to action</label><select id="cta"><option>PRICE</option><option>BOOK</option></select></div><button class="btn go" data-act="draftc" ' + (S.busy ? 'disabled' : '') + '>' + (S.busy ? 'Drafting…' : (sample ? 'Draft with Claude' : 'Quick draft')) + '</button></div><div class="muted">' + (sample ? 'Uses your Claude access from this page.' : 'Claude drafting is not available in this view, so this makes a simple template draft you can edit.') + '</div></div></div>' +
      '<div class="sec"><h2>Needs your attention <small>' + C.filter((c) => c.status === 'draft').length + '</small></h2>' + (C.length ? '<div class="card">' + C.map((c) => '<div class="item"><div class="t"><b>' + (c.status === 'approved' ? 'Approved' : 'Draft') + '</b><span class="badge">' + esc(c.cta) + '</span><span class="muted">' + when(c.at) + '</span></div><div class="fld"><label for="h-' + esc(c.id) + '">Hook</label><input id="h-' + esc(c.id) + '" value="' + esc(c.hook) + '"></div><div class="fld"><label for="c-' + esc(c.id) + '">Caption</label><textarea id="c-' + esc(c.id) + '">' + esc(c.caption) + '</textarea></div><div class="row">' + (c.status === 'draft' ? '<button class="btn go" data-act="approvec" data-id="' + esc(c.id) + '">Approve</button>' : '<button class="btn" data-act="savec" data-id="' + esc(c.id) + '">Save edits</button>') + '<button class="btn" data-act="copyc" data-id="' + esc(c.id) + '">Copy caption</button><button class="btn ghost" data-act="delc" data-id="' + esc(c.id) + '">Delete</button></div></div>').join('') + '</div>' : '<div class="empty">No drafts yet. Add footage notes above.</div>') + '</div>' +
      '<div class="sec"><h2>Publishing</h2><div class="card"><div><span class="badge ' + (pub ? 'ok' : '') + '">' + (pub ? 'Buffer on' : 'Off') + '</span></div><div class="muted">Nothing is queued or published from this page. Approved drafts are for you to copy into Buffer or Instagram. Turning on Buffer queueing happens only after you tell me to, and each queued post is confirmed with you first.</div></div></div>' +
      '<div class="sec"><h2>Errors</h2>' + errorList('content') + '</div>';
  }

  /* ---------- setup ---------- */
  function pricingRows() {
    return S.config.pricing.map((r, i) => '<div class="grid2" style="grid-template-columns:2fr 1fr 1fr 1fr auto;align-items:end" data-prow="' + i + '"><div class="fld"><label>Service</label><input data-pf="service" value="' + esc(r.service) + '"></div>' + ['sedan', 'suv', 'truck'].map((k) => '<div class="fld"><label>' + (k === 'suv' ? 'SUV' : k[0].toUpperCase() + k.slice(1)) + ' $</label><input data-pf="' + k + '" type="number" min="0" value="' + esc(r[k]) + '"></div>').join('') + '<button class="btn ghost" data-act="delprice" data-i="' + i + '" aria-label="Remove service">✕</button></div>').join('');
  }
  function check(done, text) { return '<div class="check ' + (done ? 'done' : '') + '"><i></i><span>' + text + '</span></div>'; }
  function pgSetup() {
    const c = S.config; const q = openQuestions();
    const f = (id, label, val, ph, type) => '<div class="fld"><label for="' + id + '">' + label + '</label><input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val) + '" placeholder="' + esc(ph || '') + '"></div>';
    const tpl = (k, label) => '<div class="fld"><label for="t-' + k + '">' + label + '</label><textarea id="t-' + k + '" rows="3">' + esc(c.templates[k]) + '</textarea></div>';
    return head('setup', 'Setup', 'Your answers live here. Save once and every agent uses them. Anything left blank goes to you for review instead of being guessed.', [[q.length, 'open questions']]) +
      '<div class="sec"><h2>Questions for you</h2><div class="card">' + [
        check(c.pricing.some((r) => r.service && (r.sedan || r.suv || r.truck)), 'Pricing rules by service and vehicle size'), check(!c.templatesAreSample, 'Your PRICE and BOOK reply wording'),
        check(!!c.links.booking, 'Approved booking link'), check(!!c.links.form, 'Google Form link for intake'), check(!!c.instagram.handle, 'Instagram handle'), check(!!c.instagram.testReel, 'Test Reel for the first ManyChat flow'), check(!!c.links.review, 'Google review link')].join('') + '</div></div>' +
      '<form id="setupform" class="sec" autocomplete="off"><h2>Business and Instagram</h2><div class="card"><div class="grid2">' + f('b-name', 'Business name', c.business.name) + f('b-area', 'Service area', c.business.area, 'City, neighborhoods, mobile or shop') + f('b-hours', 'Hours', c.business.hours, 'Mon to Sat, 8 to 5') + f('i-handle', 'Instagram handle', c.instagram.handle, '@puresportdetailing') + f('i-reel', 'Test Reel link', c.instagram.testReel, 'https://www.instagram.com/reel/...') + '</div></div>' +
      '<h2>Links</h2><div class="card"><div class="grid2">' + f('l-book', 'Approved booking link', c.links.booking, 'Google Calendar appointment page or other') + f('l-form', 'Google Form (intake) link', c.links.form, 'https://forms.gle/...') + f('l-sheet', 'Google Sheet link', c.links.sheet, 'https://docs.google.com/spreadsheets/...') + f('l-review', 'Google review link', c.links.review, 'https://g.page/r/...') + '</div></div>' +
      '<h2>Pricing rules</h2><div class="card" id="pricing">' + pricingRows() + '<div class="row"><button type="button" class="btn" data-act="addprice">Add a service</button></div><div class="muted">Leave a size blank if you do not price it. Those jobs go to you.</div></div>' +
      '<h2>Reply templates</h2><div class="card">' + (c.templatesAreSample ? '<div><span class="badge sample">Sample</span> <span class="muted">These are placeholders. Replace them with your wording.</span></div>' : '') + tpl('PRICE', 'PRICE reply') + tpl('BOOK', 'BOOK reply') + tpl('FOLLOWUP', 'Quote follow-up') + tpl('REVIEW', 'Review request') + '<div class="muted">Placeholders: <code>{{first_name}}</code> <code>{{vehicle}}</code> <code>{{service}}</code> <code>{{quote}}</code> <code>{{booking_link}}</code> <code>{{review_link}}</code>. A placeholder with no value shows as a NEEDED marker so nothing goes out half-filled.</div></div>' +
      '<h2>Rules</h2><div class="card"><div class="grid2">' + f('f-days', 'Follow up on open quotes after (days)', c.followupDays, '', 'number') + '</div><div class="muted">All agents draft only. You send every message and approve every quote, booking and post.</div></div>' +
      '<div class="row"><button type="submit" class="btn go">Save setup</button></div></form>' +
      '<div class="sec"><h2>Connections</h2><div class="card">' + [['manychat', 'ManyChat linked to your Instagram professional account'], ['sheets', 'Google Form and Sheet created'], ['calendar', 'Google Calendar appointment page'], ['buffer', 'Buffer (optional, publishing stays off)']].map(([k, t]) => '<label class="check ' + (c.connections[k] ? 'done' : '') + '" style="cursor:pointer"><input type="checkbox" data-conn="' + k + '" ' + (c.connections[k] ? 'checked' : '') + ' style="margin-top:3px"><span>' + t + '</span></label>').join('') + '<div class="muted">These are your own checklist. Nothing connects until you authorize it.</div></div>' + guides() + '</div>';
  }
  function guides() {
    return '<details><summary>ManyChat: comment-to-DM flow for PRICE and BOOK</summary><ol>' +
      '<li>In ManyChat, connect your Instagram professional account: Settings, Instagram, Connect.</li>' +
      '<li>Automation, New Automation, trigger: <b>Instagram Comments</b>, pick your <b>test Reel</b> only.</li>' +
      '<li>Keywords: add <code>PRICE</code> and <code>BOOK</code> as two separate conditions (contains, not case sensitive).</li>' +
      '<li>For each keyword, the action is a DM with your approved wording and a button that opens your Google Form link with the prefilled address from the next section.</li>' +
      '<li>Leave the flow in <b>Draft</b>. Turn it on only after you tell me you are ready for live messages.</li></ol></details>' +
      '<details><summary>Google Form and Sheet: keep source and keyword on every lead</summary><ol>' +
      '<li>Create a Form named Pure Sport Intake. Add these questions with exactly these titles: <code>Instagram handle</code>, <code>Keyword</code>, <code>Reel</code>, <code>Name</code>, <code>Vehicle (year make model)</code>, <code>Vehicle size</code> (Sedan, SUV, Truck), <code>Service wanted</code>, <code>Photos link</code>, <code>Notes</code>.</li>' +
      '<li>Responses tab, Link to Sheets, create the Sheet. The <code>Timestamp</code> column is added for you.</li>' +
      '<li>Form menu (three dots), Get pre-filled link. Type <code>PRICE</code> in Keyword, <code>TEST-REEL</code> in Reel, and a placeholder handle. Click Get link, copy it.</li>' +
      '<li>In the link, swap the placeholder values for ManyChat fields: the Keyword value becomes the trigger keyword for that flow (PRICE in the PRICE flow, BOOK in the BOOK flow), and the handle value becomes <code>{{ig_username}}</code>. Use one link per keyword, so the keyword is set by the flow, not typed by the customer.</li>' +
      '<li>In the Sheet, select the header and data rows, copy, and paste into Lead Intake. Re-pasting is safe.</li></ol></details>';
  }

  /* ---------- chat ---------- */
  const SYSTEM = 'You are the assistant inside the Pure Sport Detailing dashboard, a private tool for the owner of a car detailing business. Be brief and practical. You can read dashboard data with the tools provided but you cannot change it or message customers. Never invent prices, availability or customer facts: if the data is missing, say what is missing. Agents only draft; the owner sends and approves everything.';
  let dictation = null, listening = false;
  function buildChatPanel() {
    const fab = document.createElement('button'); fab.id = 'chatfab'; fab.className = 'fab'; fab.dataset.act = 'togglechat'; fab.textContent = 'Ask Claude'; fab.setAttribute('aria-controls', 'chatpanel');
    const pan = document.createElement('aside'); pan.id = 'chatpanel'; pan.className = 'chatpanel'; pan.hidden = true; pan.setAttribute('role', 'dialog'); pan.setAttribute('aria-label', 'Chat with Claude');
    pan.innerHTML = '<div class="row between"><h2>Chat with Claude</h2><button class="btn ghost" data-act="closechat" aria-label="Close chat">✕</button></div>' +
      '<div class="muted">Claude can read your leads, pricing and setup, and help draft wording. It cannot change anything or message customers.</div>' +
      '<div class="msgs" id="msgs" aria-live="polite"></div>' +
      '<div class="chips">' + ['What needs my attention?', 'Draft a PRICE reply template for me to edit', 'Write 3 Reel hooks for a ceramic coating job', 'Which leads are missing details?'].map((s) => '<button class="chip" data-act="suggest" data-v="' + esc(s) + '">' + esc(s) + '</button>').join('') + '</div>' +
      '<form id="chatform" class="row" style="flex-wrap:nowrap"><div class="fld" style="flex:1"><label for="chatin" style="position:absolute;left:-9999px">Message</label><input id="chatin" placeholder="Type or tap the mic and talk" autocomplete="off"></div><button class="btn" type="button" id="micbtn" data-act="mic" aria-label="Dictate a message" hidden>🎙</button><button class="btn go" type="submit">Send</button></form>';
    document.body.appendChild(pan); document.body.appendChild(fab);
    if (!sample) { pan.querySelector('#msgs').innerHTML = '<div class="empty">Chat needs Claude access in this view. Open the dashboard from claude.ai while signed in.</div>'; pan.querySelector('#chatform').hidden = true; pan.querySelector('.chips').hidden = true; }
    try { const j = JSON.parse(LS.get('psd.chat') || '[]'); if (Array.isArray(j)) S.chat = j.filter((m) => m && m.role && typeof m.content === 'string' && m.content).slice(-30); } catch (e) {}
    renderMsgs();
    (async () => {
      try { dictation = await window.claude.use('dictation'); } catch (e) { dictation = null; }
      if (!dictation) return;
      $('#micbtn').hidden = false; let base = '';
      dictation.onPartial(({ text }) => { $('#chatin').value = (base + ' ' + text).trim(); });
      dictation.onFinal(({ text }) => { base = ($('#chatin').value || '').trim(); $('#chatin').value = base; void text; });
      dictation.onState(({ state }) => { listening = state === 'listening'; const b = $('#micbtn'); if (b) { b.classList.toggle('go', listening); b.setAttribute('aria-label', listening ? 'Stop dictating' : 'Dictate a message'); } if (listening) base = ($('#chatin').value || '').trim(); });
    })();
  }
  function openChat(on) {
    const pan = $('#chatpanel'); if (!pan) return;
    const show = on === undefined ? pan.hidden : on; pan.hidden = !show; $('#chatfab').hidden = show;
    if (show) { renderMsgs(); setTimeout(() => { const i = $('#chatin'); if (i && !i.hidden) i.focus(); }, 50); }
  }
  function renderMsgs() {
    const box = $('#msgs'); if (!box || !sample) return;
    box.innerHTML = S.chat.length ? S.chat.map((m, i) => '<div class="msg ' + (m.role === 'user' ? 'user' : 'bot') + '">' + esc(m.content || '…') + (m.role === 'assistant' && m.content ? '<div class="row" style="margin-top:8px"><button class="btn ghost" data-act="usetpl" data-k="PRICE" data-i="' + i + '">Use as PRICE template</button><button class="btn ghost" data-act="usetpl" data-k="BOOK" data-i="' + i + '">Use as BOOK template</button></div>' : '') + '</div>').join('') : '<div class="empty">Ask a question or pick a suggestion. When Claude drafts reply wording, one click puts it into your template.</div>';
    box.scrollTop = box.scrollHeight;
  }
  async function sendChat(text) {
    if (!sample || !text.trim() || S.chatBusy) return;
    if (listening && dictation) { try { await dictation.stop(); } catch (e) {} }
    S.chat.push({ role: 'user', content: text.trim() }); const bot = { role: 'assistant', content: '' }; S.chat.push(bot); S.chatBusy = true; renderMsgs();
    const msgs = S.chat.slice(0, -1).slice(-14).map((m, i) => ({ role: m.role, content: (i === 0 && m.role === 'user' ? SYSTEM + ' The owner is currently viewing the "' + current() + '" page.\n\n' : '') + m.content }));
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    const tools = [
      { name: 'dashboard_summary', description: 'Counts of new leads, quotes to approve, upcoming jobs, follow-ups due and content drafts. Returns an object.', execute: () => counts() },
      { name: 'list_leads', description: 'List leads with id, handle, keyword, stage, vehicle, service. Optional stage filter. Returns an array.', inputSchema: { type: 'object', properties: { stage: { type: 'string' } } }, execute: (i) => leadsArr().filter((l) => !i || !i.stage || l.stage === i.stage).slice(0, 40).map((l) => ({ id: l.id, handle: l.handle, keyword: l.keyword, stage: l.stage, vehicle: l.vehicle, service: l.service, sample: l.sample })) },
      { name: 'get_lead', description: 'Full record for one lead id including history. Returns an object.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, execute: (i) => S.leads[i.id] || { error: 'No such lead' } },
      { name: 'get_setup', description: 'Pricing rules, reply templates and links saved in Setup. Returns an object.', execute: () => ({ pricing: S.config.pricing, templates: S.config.templates, links: S.config.links, business: S.config.business, openQuestions: openQuestions() }) },
    ];
    try {
      await sample(msgs, { tools, cache: false, onText: (u) => { bot.content = u.text; renderMsgs(); } });
    } catch (e) { bot.content = bot.content || (e && e.code === 'not_granted' ? 'Claude access was declined for this page.' : 'Claude could not answer right now (' + ((e && (e.code || e.message)) || 'error') + '). Try again in a moment.'); }
    S.chatBusy = false; renderMsgs();
    LS.set('psd.chat', JSON.stringify(S.chat.filter((m) => m.content).slice(-30)));
  }

  /* ---------- lead drawer ---------- */
  function renderDrawer() {
    let bg = $('#drawer');
    if (!S.open || !S.leads[S.open]) { if (bg) bg.remove(); return; }
    const a = document.activeElement; if (bg && a && bg.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    const l = S.leads[S.open];
    if (!bg) { bg = document.createElement('div'); bg.id = 'drawer'; bg.className = 'drawer-bg'; document.body.appendChild(bg); }
    const sizeOpt = (v) => '<option value="' + v + '" ' + (l.vehicleClass === v ? 'selected' : '') + '>' + (v ? (v === 'suv' ? 'SUV' : v[0].toUpperCase() + v.slice(1)) : 'Not set') + '</option>';
    bg.innerHTML = '<aside class="drawer" role="dialog" aria-label="Lead record"><div class="row between"><div class="t row"><h2>@' + esc(l.handle) + '</h2>' + srcPill(l) + stagePill(l) + sampleBadge(l) + '</div><button class="btn ghost" data-act="close" aria-label="Close">✕</button></div>' +
      '<div class="muted">Captured ' + when(l.createdAt) + ' from ' + esc(l.platform) + (l.postId ? ' · ' + esc(l.postId) : '') + (l.repeatCount ? ' · ' + l.repeatCount + ' repeat event(s) merged' : '') + '</div>' +
      '<form id="detailform" class="card"><div class="grid2">' + ['name:Name', 'vehicle:Vehicle', 'service:Service', 'photos:Photos link'].map((x) => { const [k, lab] = x.split(':'); return '<div class="fld"><label for="d-' + k + '">' + lab + '</label><input id="d-' + k + '" value="' + esc(l[k]) + '"></div>'; }).join('') + '<div class="fld"><label for="d-vehicleClass">Vehicle size</label><select id="d-vehicleClass">' + ['', 'sedan', 'suv', 'truck'].map(sizeOpt).join('') + '</select></div></div><div class="fld"><label for="d-notes">Notes</label><textarea id="d-notes">' + esc(l.notes) + '</textarea></div><div class="row"><button class="btn go" type="submit">Save details</button></div></form>' +
      (l.quote ? '<div class="card"><div class="t"><b>Quote</b><span class="badge ' + (l.quote.status === 'approved' ? 'ok' : 'warn') + '">' + esc(l.quote.status.replace('_', ' ')) + '</span>' + (l.quote.amount ? '<b>' + money(l.quote.amount) + '</b>' : '') + '</div>' + (l.quote.reason ? '<div class="muted">' + esc(l.quote.reason) + '</div>' : '') + '</div>' : '') +
      (l.reply ? '<div class="card"><b>Reply draft</b><div class="copybox">' + esc(l.reply.text) + '</div><div class="row"><button class="btn" data-act="copy" data-id="' + esc(l.id) + '">Copy reply</button></div></div>' : '') +
      '<div class="row">' + (l.stage === 'ready_to_quote' && !l.quote ? '<button class="btn go" data-act="draftq" data-id="' + esc(l.id) + '">Draft quote</button>' : '') + (l.stage === 'closed' ? '' : '<button class="btn ghost" data-act="closelead" data-id="' + esc(l.id) + '">Close lead</button>') + '</div>' +
      '<div><div class="eyebrow">History</div><ul class="tl">' + l.history.slice().reverse().map((h) => '<li><div><b>' + esc(h.action) + '</b><div class="who">' + esc(h.agent) + ' · ' + when(h.at) + '</div>' + (h.detail ? '<div class="muted">' + esc(h.detail) + '</div>' : '') + '</div></li>').join('') + '</ul></div></aside>';
  }

  /* ---------- actions ---------- */
  const val = (id) => { const e = document.getElementById(id); return e ? e.value : ''; };
  async function act(el) {
    const a = el.dataset.act; const id = el.dataset.id; const l = id ? S.leads[id] : null;
    try {
      if (a === 'open') { const x = clone(S.leads[id]); if (x.isNew) { x.isNew = false; await saveLead(x); } S.open = id; renderDrawer(); }
      else if (a === 'close') { S.open = null; renderDrawer(); }
      else if (a === 'filter') { S.filter = el.dataset.v; refresh(true); }
      else if (a === 'import') {
        const rows = P.parseTable(val('paste')); if (!rows.length) return toast('Paste the header row and at least one data row.');
        const r = P.importRows(S.leads, 'instagram', rows); await saveLeads(r.leads);
        r.ignored.forEach((x) => S.errors.unshift({ at: new Date().toISOString(), agent: 'intake', text: 'Row ' + x.row + ' ignored: ' + x.reason }));
        toast(r.created + ' new, ' + r.merged + ' merged, ' + r.duplicates + ' repeats skipped, ' + r.ignored.length + ' ignored'); refresh(true);
      }
      else if (a === 'sample') { const r = P.importRows(S.leads, 'instagram', P.sampleRows(), undefined, { sample: true }); await saveLeads(r.leads); r.ignored.forEach((x) => S.errors.unshift({ at: new Date().toISOString(), agent: 'intake', text: 'Sample row ' + x.row + ' ignored: ' + x.reason })); toast('Sample data loaded. Every sample lead is labeled.'); refresh(true); }
      else if (a === 'clear-sample') { await removeLeads(Object.values(S.leads).filter((x) => x.sample).map((x) => x.id)); toast('Sample leads removed'); }
      else if (a === 'draftq') { await saveLead(P.draftQuote(l, S.config)); toast(S.leads[id].quote.status === 'drafted' ? 'Quote drafted for your approval' : 'Sent to you for pricing'); }
      else if (a === 'approveq') { const n = val('amt-' + id); await saveLead(P.approveQuote(l, n, S.config)); toast('Quote approved'); }
      else if (a === 'copy') copy(l.reply.text);
      else if (a === 'copytext') copy(el.dataset.v);
      else if (a === 'sent') await saveLead(P.markReplySent(l));
      else if (a === 'prep') { const cs = document.getElementById('cs-' + id); await saveLead(P.prepareBooking(l, S.config, { customSlot: !!(cs && cs.checked) })); }
      else if (a === 'confirm') { await saveLead(P.confirmBooked(l, val('slot-' + id))); toast('Marked booked'); }
      else if (a === 'closelead') { const x = clone(l); x.stage = 'closed'; x.stageAt = new Date().toISOString(); x.history.push({ at: x.stageAt, agent: 'Owner', action: 'Lead closed', detail: '' }); await saveLead(x); }
      else if (a === 'addprice') { S.config.pricing.push({ service: '', sedan: '', suv: '', truck: '' }); renderPage('setup'); }
      else if (a === 'delprice') { readPricing(); S.config.pricing.splice(Number(el.dataset.i), 1); renderPage('setup'); }
      else if (a === 'draftc') await draftContent();
      else if (a === 'approvec' || a === 'savec') { const c = clone(S.content[id]); c.hook = val('h-' + id); c.caption = val('c-' + id); if (a === 'approvec') c.status = 'approved'; await saveContent(c); toast(a === 'approvec' ? 'Approved. Copy it into Buffer or Instagram when you are ready.' : 'Saved'); }
      else if (a === 'copyc') copy(val('h-' + id) + '\n\n' + val('c-' + id));
      else if (a === 'delc') await removeContent(id);
      else if (a === 'suggest') { sendChat(el.dataset.v); }
      else if (a === 'togglechat') openChat();
      else if (a === 'closechat') openChat(false);
      else if (a === 'mic') { if (!dictation) return; if (listening) await dictation.stop(); else await dictation.start(); }
      else if (a === 'usetpl') { S.config.templates[el.dataset.k] = S.chat[Number(el.dataset.i)].content; S.config.templatesAreSample = false; await saveConfig(); toast('Saved as your ' + el.dataset.k + ' template'); }
    } catch (e) { fail(e.message || String(e), l ? (a === 'prep' || a === 'confirm' ? 'booking' : 'quote') : 'system'); }
  }
  function readPricing() {
    S.config.pricing = [...document.querySelectorAll('[data-prow]')].map((row) => { const o = {}; row.querySelectorAll('[data-pf]').forEach((i) => { o[i.dataset.pf] = i.dataset.pf === 'service' ? i.value.trim() : (i.value === '' ? '' : Number(i.value)); }); return o; });
  }
  async function draftContent() {
    const notes = val('notes').trim(); const cta = val('cta') || 'PRICE';
    if (!notes) return toast('Add a few footage notes first.');
    let d = null;
    if (sample) {
      S.busy = true; renderPage('content');
      try { d = await sample.json('You write short-form Instagram Reel copy for Pure Sport Detailing, a car detailing business. From these footage notes, write one scroll-stopping hook (under 12 words), one caption (under 60 words, plain, no hashtags spam, no emojis) and end the caption with a call to action telling people to comment ' + cta + '. Do not invent prices, results or guarantees not in the notes. Reply as JSON: {"hook": string, "caption": string}.\n\nNotes:\n' + notes, { cache: false }); } catch (e) { fail('Claude draft failed (' + ((e && (e.code || e.message)) || 'error') + '). Used a simple template instead.', 'content'); }
      S.busy = false;
    }
    if (!d || !d.hook) d = P.fallbackContent(notes, cta);
    const c = { id: 'c' + Date.now().toString(36), hook: d.hook, caption: d.caption, cta, status: 'draft', at: new Date().toISOString(), notes };
    await saveContent(c); renderPage('content');
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (el && !(el.tagName === 'TR' && e.target.closest('a,button'))) { act(el); return; }
    const m = e.target.closest('[data-menu]'); if (m) { toggleMenu(); return; }
    const bg = e.target.closest('.drawer-bg'); if (bg && e.target === bg) { S.open = null; renderDrawer(); }
    if (e.target.closest('.menu a')) toggleMenu(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if ($('.menu')) toggleMenu(false); else if ($('#chatpanel') && !$('#chatpanel').hidden) openChat(false); else if (S.open) { S.open = null; renderDrawer(); } } });
  document.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'chatform') { const i = $('#chatin'); const t = i.value; i.value = ''; sendChat(t); }
    else if (e.target.id === 'detailform') { const l = S.leads[S.open]; const patch = {}; ['name', 'vehicle', 'service', 'photos', 'notes', 'vehicleClass'].forEach((k) => { patch[k] = val('d-' + k); }); await saveLead(P.updateDetails(l, patch)); toast('Details saved'); }
    else if (e.target.id === 'setupform') {
      readPricing(); const c = S.config;
      c.business = { name: val('b-name'), area: val('b-area'), hours: val('b-hours') }; c.instagram = { handle: val('i-handle'), testReel: val('i-reel') };
      c.links = { booking: val('l-book').trim(), form: val('l-form').trim(), sheet: val('l-sheet').trim(), review: val('l-review').trim() };
      const t = { PRICE: val('t-PRICE'), BOOK: val('t-BOOK'), FOLLOWUP: val('t-FOLLOWUP'), REVIEW: val('t-REVIEW') };
      if (JSON.stringify(t) !== JSON.stringify(P.DEFAULT_TEMPLATES)) c.templatesAreSample = false;
      c.templates = t; c.followupDays = Number(val('f-days')) || 3; await saveConfig();
    }
  });
  document.addEventListener('change', (e) => { const k = e.target.dataset && e.target.dataset.conn; if (k) { S.config.connections[k] = e.target.checked; saveConfig(); } });

  function toggleMenu(force) {
    const open = $('.menu'); if (open && force !== true) { open.remove(); return; } if (open) return;
    const m = document.createElement('div'); m.className = 'menu';
    m.innerHTML = '<nav aria-label="Pages">' + PAGES.map((p) => '<a href="#' + p[0] + '">' + esc(p[1]) + '<small>' + esc(p[2]) + '</small></a>').join('') + '</nav>';
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    document.body.appendChild(m);
  }

  boot();
})();
