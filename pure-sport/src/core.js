/* Pure Sport Detailing: shared lead logic. No DOM, no network. Runs in the page and in Node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PSD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const AGENTS = [
    { id: 'intake', name: 'Lead Intake', blurb: 'Captures inquiries, records PRICE or BOOK as the source, flags missing vehicle or service details.' },
    { id: 'quote', name: 'Quote Assistant', blurb: 'Drafts quotes from your pricing rules and the reply from your template. You approve every quote.' },
    { id: 'booking', name: 'Booking', blurb: 'Prepares the booking link or flags a custom slot. Marks a job booked only after you confirm.' },
    { id: 'followup', name: 'Follow-Up', blurb: 'Tracks open quotes and finished jobs. Drafts follow-ups and review requests.' },
    { id: 'content', name: 'Content', blurb: 'Turns footage notes into Reel hooks, captions and PRICE or BOOK calls to action.' },
  ];

  const STAGES = {
    new: 'New', needs_info: 'Needs info', ready_to_quote: 'Ready to quote', awaiting_approval: 'Quote to approve',
    approved: 'Quote approved', booking_handoff: 'Booking handoff', booked: 'Booked', followup: 'Follow-up', closed: 'Closed',
  };

  const KEYWORDS = ['PRICE', 'BOOK'];
  const VEHICLE_CLASSES = ['sedan', 'suv', 'truck'];

  const DEFAULT_TEMPLATES = {
    PRICE: 'Hey {{first_name}}, thanks for asking about pricing! For your {{vehicle}}, the {{service}} is {{quote}}. If you want a time on the schedule, reply BOOK. Pure Sport Detailing',
    BOOK: 'Hey {{first_name}}, let\'s get your {{vehicle}} on the schedule. Pick a time here: {{booking_link}}. Pure Sport Detailing',
    FOLLOWUP: 'Hey {{first_name}}, checking in on the {{service}} quote for your {{vehicle}}. Want me to hold a spot this week? Pure Sport Detailing',
    REVIEW: 'Hey {{first_name}}, thanks for trusting us with your {{vehicle}}. If you\'re happy with the result, a quick review helps a lot: {{review_link}}. Pure Sport Detailing',
  };

  const DEFAULT_CONFIG = {
    business: { name: 'Pure Sport Detailing', area: '', hours: '' },
    instagram: { handle: '', testReel: '' },
    links: { booking: '', form: '', sheet: '', review: '' },
    pricing: [], // [{service, sedan, suv, truck}] dollars; blank = not priced
    templates: DEFAULT_TEMPLATES,
    publishing: 'off', // 'off' | 'buffer'
    followupDays: 3,
    connections: { manychat: false, sheets: false, calendar: false, buffer: false },
    templatesAreSample: true,
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const nowIso = () => new Date().toISOString();
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const clean = (s) => String(s == null ? '' : s).trim();

  /* ---------- platform adapters (add new platforms here) ---------- */
  const ALIASES = {
    handle: ['igusername', 'instagramhandle', 'handle', 'username', 'instagram'],
    keyword: ['keyword', 'trigger', 'source'],
    eventId: ['eventid', 'commentid', 'id'],
    postId: ['reel', 'postid', 'post', 'reelurl'],
    timestamp: ['timestamp', 'time', 'submittedat'],
    name: ['name', 'fullname', 'firstname'],
    vehicle: ['vehicle', 'vehicleyearmakemodel', 'car'],
    vehicleClass: ['vehiclesize', 'size', 'vehicleclass'],
    service: ['servicewanted', 'service'],
    photos: ['photoslink', 'photos', 'photolinks'],
    notes: ['notes', 'message', 'comments'],
  };
  function pick(raw, key) {
    const map = {};
    Object.keys(raw || {}).forEach((k) => { map[norm(k)] = raw[k]; });
    for (const a of ALIASES[key]) if (clean(map[a])) return clean(map[a]);
    return '';
  }
  function guessClass(sizeText, vehicleText) {
    const t = (sizeText + ' ' + vehicleText).toLowerCase();
    if (/truck|pickup|f-?150|silverado|ram|tacoma/.test(t)) return 'truck';
    if (/suv|crossover|tahoe|suburban|explorer|rav4|cr-?v/.test(t)) return 'suv';
    if (/sedan|coupe|hatch|civic|accord|mustang|camaro|miata/.test(t)) return 'sedan';
    return '';
  }
  const adapters = {
    instagram: {
      label: 'Instagram (ManyChat + Google Form)',
      normalize(raw) {
        const handle = pick(raw, 'handle').replace(/^@/, '');
        const keyword = pick(raw, 'keyword').toUpperCase();
        if (!handle) return { ok: false, reason: 'No Instagram handle on this row.' };
        if (!KEYWORDS.includes(keyword)) return { ok: false, reason: 'Keyword "' + keyword + '" is not PRICE or BOOK.' };
        const timestamp = pick(raw, 'timestamp');
        const given = pick(raw, 'eventId');
        const vehicle = pick(raw, 'vehicle');
        const sizeText = pick(raw, 'vehicleClass');
        return {
          ok: true,
          evt: {
            platform: 'instagram', handle, keyword,
            eventId: given || (timestamp ? timestamp + '|' + handle.toLowerCase() + '|' + keyword : ''),
            postId: pick(raw, 'postId'), name: pick(raw, 'name'), vehicle,
            vehicleClass: VEHICLE_CLASSES.includes(sizeText.toLowerCase()) ? sizeText.toLowerCase() : guessClass(sizeText, vehicle),
            service: pick(raw, 'service'), photos: pick(raw, 'photos'), notes: pick(raw, 'notes'),
          },
        };
      },
    },
  };
  function registerAdapter(platform, adapter) { adapters[platform] = adapter; }

  /* ---------- leads ---------- */
  function leadId(platform, handle, keyword) {
    return (platform + '_' + handle.toLowerCase() + '_' + keyword.toLowerCase()).replace(/[^a-z0-9_]+/g, '-');
  }
  function addHistory(lead, agent, action, detail, now) {
    lead.history.push({ at: now, agent, action, detail: detail || '' });
  }
  function setStage(lead, stage, now) { lead.stage = stage; lead.stageAt = now; }
  function missingDetails(lead) {
    const m = [];
    if (!clean(lead.vehicle)) m.push('vehicle');
    if (!clean(lead.service)) m.push('service');
    return m;
  }
  function triage(lead, now) {
    if (['new', 'needs_info', 'ready_to_quote'].indexOf(lead.stage) === -1) return;
    const miss = missingDetails(lead);
    const next = miss.length ? 'needs_info' : 'ready_to_quote';
    if (next !== lead.stage) setStage(lead, next, now);
  }

  function ingest(leads, evt, now, opts) {
    now = now || nowIso(); opts = opts || {};
    let id = leadId(evt.platform, evt.handle, evt.keyword);
    if (leads[id] && leads[id].stage === 'closed') id = id + '-' + now.slice(0, 10).replace(/-/g, '');
    const out = Object.assign({}, leads);
    const existing = out[id];
    if (existing) {
      if (evt.eventId && (existing.seenEvents || []).indexOf(evt.eventId) !== -1) {
        return { leads: out, lead: existing, created: false, duplicate: true, merged: false };
      }
      const lead = clone(existing);
      lead.seenEvents = (lead.seenEvents || []).concat(evt.eventId ? [evt.eventId] : []);
      lead.repeatCount = (lead.repeatCount || 0) + 1;
      const filled = [];
      ['name', 'vehicle', 'vehicleClass', 'service', 'photos', 'notes', 'postId'].forEach((k) => {
        if (!clean(lead[k]) && clean(evt[k])) { lead[k] = evt[k]; filled.push(k); }
      });
      addHistory(lead, 'Lead Intake', 'Repeat event merged', filled.length ? 'Filled in: ' + filled.join(', ') : 'No new details.', now);
      triage(lead, now);
      out[id] = lead;
      return { leads: out, lead, created: false, duplicate: false, merged: true };
    }
    const lead = {
      id, platform: evt.platform, handle: evt.handle, keyword: evt.keyword, source: evt.keyword,
      postId: evt.postId || '', name: evt.name || '', vehicle: evt.vehicle || '', vehicleClass: evt.vehicleClass || '',
      service: evt.service || '', photos: evt.photos || '', notes: evt.notes || '',
      stage: 'new', stageAt: now, createdAt: now, isNew: true, sample: !!opts.sample,
      repeatCount: 0, seenEvents: evt.eventId ? [evt.eventId] : [], history: [],
      quote: null, reply: null, booking: null,
    };
    addHistory(lead, 'Lead Intake', 'Inquiry captured', evt.platform + ' comment keyword ' + evt.keyword + (evt.postId ? ' on ' + evt.postId : ''), now);
    triage(lead, now);
    const miss = missingDetails(lead);
    if (miss.length) addHistory(lead, 'Lead Intake', 'Flagged missing details', miss.join(', '), now);
    out[id] = lead;
    return { leads: out, lead, created: true, duplicate: false, merged: false };
  }

  function importRows(leads, platform, rows, now, opts) {
    const adapter = adapters[platform];
    const res = { leads, created: 0, merged: 0, duplicates: 0, ignored: [] };
    if (!adapter) { res.ignored.push({ reason: 'No adapter for ' + platform }); return res; }
    rows.forEach((row, i) => {
      const n = adapter.normalize(row);
      if (!n.ok) { res.ignored.push({ row: i + 1, reason: n.reason }); return; }
      const r = ingest(res.leads, n.evt, now, opts);
      res.leads = r.leads;
      if (r.created) res.created++; else if (r.duplicate) res.duplicates++; else if (r.merged) res.merged++;
    });
    return res;
  }

  function updateDetails(lead, patch, now) {
    now = now || nowIso();
    const l = clone(lead); const changed = [];
    ['name', 'vehicle', 'vehicleClass', 'service', 'photos', 'notes'].forEach((k) => {
      if (patch[k] !== undefined && clean(patch[k]) !== clean(l[k])) { l[k] = clean(patch[k]); changed.push(k); }
    });
    if (changed.length) { addHistory(l, 'Owner', 'Details updated', changed.join(', '), now); triage(l, now); }
    return l;
  }

  /* ---------- quote assistant ---------- */
  function priceQuote(lead, config) {
    const rules = (config.pricing || []).filter((r) => clean(r.service));
    if (!rules.length) return { status: 'needs_review', reason: 'No pricing rules saved yet. Add them in Setup.' };
    const s = clean(lead.service).toLowerCase();
    const rule = rules.find((r) => r.service.toLowerCase() === s) || rules.find((r) => s.indexOf(r.service.toLowerCase()) !== -1 || r.service.toLowerCase().indexOf(s) !== -1);
    if (!rule) return { status: 'needs_review', reason: 'No pricing rule matches "' + lead.service + '".' };
    if (!lead.vehicleClass) return { status: 'needs_review', reason: 'Vehicle size (sedan, SUV or truck) is not set, so the price is ambiguous.' };
    const price = Number(rule[lead.vehicleClass]);
    if (!isFinite(price) || price <= 0 || rule[lead.vehicleClass] === '' || rule[lead.vehicleClass] == null) {
      return { status: 'needs_review', reason: 'No ' + lead.vehicleClass + ' price saved for "' + rule.service + '".' };
    }
    return { status: 'drafted', amount: price, service: rule.service };
  }

  function fill(template, vars) {
    const missing = [];
    const text = String(template || '').replace(/\{\{(\w+)\}\}/g, (m, k) => {
      if (clean(vars[k])) return vars[k];
      if (missing.indexOf(k) === -1) missing.push(k);
      return '[[' + k.toUpperCase() + ' NEEDED]]';
    });
    return { text, missing };
  }
  function vars(lead, config, extra) {
    return Object.assign({
      first_name: clean(lead.name).split(/\s+/)[0] || lead.handle,
      vehicle: lead.vehicle, service: lead.service,
      quote: lead.quote && lead.quote.amount ? '$' + lead.quote.amount : '',
      booking_link: config.links && config.links.booking, review_link: config.links && config.links.review,
    }, extra || {});
  }
  function draftReply(lead, config) {
    const t = (config.templates || DEFAULT_TEMPLATES)[lead.keyword] || DEFAULT_TEMPLATES[lead.keyword];
    const r = fill(t, vars(lead, config));
    return { text: r.text, missing: r.missing, status: 'draft', sampleTemplate: !!config.templatesAreSample };
  }

  function draftQuote(lead, config, now) {
    now = now || nowIso();
    const l = clone(lead);
    if (missingDetails(l).length) {
      addHistory(l, 'Quote Assistant', 'Skipped', 'Missing ' + missingDetails(l).join(' and ') + '. Request photos or details first.', now);
      return l;
    }
    const q = priceQuote(l, config);
    l.quote = Object.assign({ at: now }, q);
    l.reply = draftReply(l, config);
    if (q.status === 'drafted') {
      setStage(l, 'awaiting_approval', now);
      addHistory(l, 'Quote Assistant', 'Quote drafted', '$' + q.amount + ' for ' + q.service + ' (' + l.vehicleClass + '). Waiting for your approval.', now);
    } else {
      setStage(l, 'ready_to_quote', now);
      addHistory(l, 'Quote Assistant', 'Sent to owner for pricing', q.reason, now);
    }
    return l;
  }

  function approveQuote(lead, amount, config, now) {
    now = now || nowIso();
    const n = Number(amount);
    if (!lead.quote) throw new Error('No quote draft to approve.');
    if (!isFinite(n) || n <= 0) throw new Error('Enter a quote amount greater than zero.');
    const l = clone(lead);
    l.quote.amount = n; l.quote.status = 'approved'; l.quote.approvedAt = now; delete l.quote.reason;
    l.reply = draftReply(l, config);
    setStage(l, 'approved', now);
    addHistory(l, 'Owner', 'Quote approved', '$' + n, now);
    return l;
  }
  function markReplySent(lead, now) {
    now = now || nowIso();
    const l = clone(lead);
    if (l.reply) l.reply.status = 'sent_by_owner';
    addHistory(l, 'Owner', 'Reply sent by owner', '', now);
    return l;
  }

  /* ---------- booking ---------- */
  function prepareBooking(lead, config, opts, now) {
    now = now || nowIso(); opts = opts || {};
    const bookNoQuote = lead.keyword === 'BOOK' && !missingDetails(lead).length && ['ready_to_quote', 'awaiting_approval'].indexOf(lead.stage) !== -1;
    if (lead.stage !== 'approved' && !bookNoQuote) throw new Error('Approve a quote first, or use a BOOK lead with complete details.');
    const l = clone(lead);
    const link = clean(config.links && config.links.booking);
    if (opts.customSlot || !link) {
      l.booking = { status: 'needs_custom_slot', reason: opts.customSlot ? 'Marked as needing a custom time.' : 'No approved booking link saved in Setup.' };
      addHistory(l, 'Booking', 'Flagged custom slot', l.booking.reason, now);
    } else {
      l.booking = { status: 'link_ready', link };
      addHistory(l, 'Booking', 'Booking link prepared', link, now);
    }
    setStage(l, 'booking_handoff', now);
    return l;
  }
  function confirmBooked(lead, slot, now) {
    now = now || nowIso();
    if (lead.stage !== 'booking_handoff') throw new Error('Only a lead in booking handoff can be marked booked.');
    if (!slot || isNaN(Date.parse(slot))) throw new Error('Enter the confirmed date and time.');
    const l = clone(lead);
    l.booking = Object.assign({}, l.booking, { status: 'confirmed', slot: new Date(slot).toISOString(), confirmedAt: now });
    setStage(l, 'booked', now);
    addHistory(l, 'Owner', 'Booking confirmed', new Date(slot).toLocaleString(), now);
    return l;
  }

  /* ---------- follow-up and summary ---------- */
  function daysBetween(a, b) { return (Date.parse(b) - Date.parse(a)) / 86400000; }
  function followUps(leads, config, now) {
    now = now || nowIso();
    const days = Number(config.followupDays) || 3;
    const out = [];
    Object.values(leads).forEach((l) => {
      if (['awaiting_approval', 'approved', 'booking_handoff'].indexOf(l.stage) !== -1 && daysBetween(l.stageAt, now) >= days) {
        out.push({ leadId: l.id, kind: 'quote', since: l.stageAt, draft: fill(config.templates.FOLLOWUP || DEFAULT_TEMPLATES.FOLLOWUP, vars(l, config)).text });
      }
      if (l.stage === 'booked' && l.booking && l.booking.slot && Date.parse(l.booking.slot) < Date.parse(now)) {
        out.push({ leadId: l.id, kind: 'review', since: l.booking.slot, draft: fill(config.templates.REVIEW || DEFAULT_TEMPLATES.REVIEW, vars(l, config)).text });
      }
    });
    return out;
  }
  function attention(lead) {
    const a = [];
    const miss = missingDetails(lead);
    if (miss.length) a.push({ agent: 'intake', text: 'Missing ' + miss.join(' and ') });
    if (lead.quote && lead.quote.status === 'needs_review' && lead.stage === 'ready_to_quote') a.push({ agent: 'quote', text: lead.quote.reason });
    if (lead.stage === 'awaiting_approval') a.push({ agent: 'quote', text: 'Quote of $' + lead.quote.amount + ' waiting for your approval' });
    if (lead.booking && lead.booking.status === 'needs_custom_slot' && lead.stage === 'booking_handoff') a.push({ agent: 'booking', text: lead.booking.reason });
    return a;
  }
  function summary(leads, content, config, now) {
    now = now || nowIso();
    const L = Object.values(leads);
    return {
      newLeads: L.filter((l) => l.isNew).length,
      quotesToApprove: L.filter((l) => l.stage === 'awaiting_approval').length,
      needsPricing: L.filter((l) => l.stage === 'ready_to_quote' && l.quote && l.quote.status === 'needs_review').length,
      upcomingJobs: L.filter((l) => l.stage === 'booked' && l.booking && Date.parse(l.booking.slot) >= Date.parse(now)).length,
      followUpsDue: followUps(leads, config, now).length,
      contentDrafts: Object.values(content || {}).filter((c) => c.status === 'draft').length,
      total: L.length,
    };
  }

  /* ---------- content ---------- */
  function fallbackContent(notes, cta) {
    const first = clean(notes).split(/[.\n]/)[0].slice(0, 80) || 'Before and after';
    return {
      hook: 'Watch this: ' + first.toLowerCase(),
      caption: first + '. Full detail by Pure Sport Detailing. Comment ' + cta + ' and we will send you the next step.',
      cta,
    };
  }

  /* ---------- CSV / TSV paste ---------- */
  function parseTable(text) {
    const src = String(text || '').replace(/\r/g, '');
    if (!clean(src)) return [];
    const first = src.split('\n')[0];
    const d = first.indexOf('\t') !== -1 ? '\t' : ',';
    const rows = []; let row = []; let cur = ''; let q = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (q) { if (c === '"' && src[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === d) { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    row.push(cur); rows.push(row);
    const data = rows.filter((r) => r.some((c) => clean(c)));
    if (data.length < 2) return [];
    const head = data[0].map(clean);
    return data.slice(1).map((r) => { const o = {}; head.forEach((h, i) => { o[h] = r[i] || ''; }); return o; });
  }

  /* ---------- clearly labeled sample data ---------- */
  function sampleRows() {
    return [
      { Timestamp: '2026-11-18 09:12', 'Instagram handle': '@sample_marcus', Keyword: 'PRICE', Reel: 'TEST-REEL', Name: 'Marcus (SAMPLE)', 'Vehicle (year make model)': '2021 Ford F-150', 'Vehicle size': 'Truck', 'Service wanted': 'Full interior detail', Notes: 'Pet hair' },
      { Timestamp: '2026-11-18 09:12', 'Instagram handle': '@sample_marcus', Keyword: 'PRICE', Reel: 'TEST-REEL', Name: 'Marcus (SAMPLE)', 'Vehicle (year make model)': '2021 Ford F-150', 'Vehicle size': 'Truck', 'Service wanted': 'Full interior detail' },
      { Timestamp: '2026-11-19 14:40', 'Instagram handle': '@sample_priya', Keyword: 'BOOK', Reel: 'TEST-REEL', Name: 'Priya (SAMPLE)', 'Vehicle (year make model)': '2019 Honda Civic', 'Vehicle size': 'Sedan', 'Service wanted': 'Ceramic coating' },
      { Timestamp: '2026-11-19 18:05', 'Instagram handle': '@sample_dre', Keyword: 'PRICE', Reel: 'TEST-REEL', Name: 'Dre (SAMPLE)' },
      { Timestamp: '2026-11-20 08:30', 'Instagram handle': '@sample_spam', Keyword: 'HELLO', Reel: 'TEST-REEL' },
    ];
  }

  return {
    AGENTS, STAGES, KEYWORDS, DEFAULT_CONFIG, DEFAULT_TEMPLATES, adapters, registerAdapter,
    leadId, ingest, importRows, updateDetails, missingDetails, priceQuote, fill, draftReply, draftQuote,
    approveQuote, markReplySent, prepareBooking, confirmBooked, followUps, attention, summary,
    fallbackContent, parseTable, sampleRows, clone,
  };
});
