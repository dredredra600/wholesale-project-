const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/core.js');

const T0 = '2026-11-20T10:00:00.000Z';
const cfg = () => Object.assign(P.clone(P.DEFAULT_CONFIG), {
  pricing: [{ service: 'Full interior detail', sedan: 150, suv: 180, truck: 200 }, { service: 'Ceramic coating', sedan: 900, suv: '', truck: '' }],
  links: { booking: 'https://example.com/book', form: '', sheet: '', review: 'https://example.com/review' },
});
const imp = (leads, rows) => P.importRows(leads, 'instagram', rows, T0, { sample: true });

test('repeat events do not create duplicate leads', () => {
  const r = imp({}, P.sampleRows());
  assert.strictEqual(r.created, 3);       // marcus, priya, dre
  assert.strictEqual(r.duplicates, 1);    // identical Sheet row pasted twice
  assert.strictEqual(r.ignored.length, 1); // HELLO keyword
  const again = imp(r.leads, P.sampleRows());
  assert.strictEqual(again.created, 0);
  assert.strictEqual(Object.keys(again.leads).length, 3);
});

test('same person commenting again merges into the open lead', () => {
  let r = imp({}, [{ 'Instagram handle': 'a', Keyword: 'price', Timestamp: '1' }]);
  r = imp(r.leads, [{ 'Instagram handle': '@A', Keyword: 'PRICE', Timestamp: '2', Vehicle: '2020 Civic' }]);
  assert.strictEqual(Object.keys(r.leads).length, 1);
  assert.strictEqual(r.merged, 1);
  assert.strictEqual(Object.values(r.leads)[0].vehicle, '2020 Civic');
});

test('source keyword is recorded and missing details flagged', () => {
  const { leads } = imp({}, P.sampleRows());
  const dre = leads[P.leadId('instagram', 'sample_dre', 'PRICE')];
  assert.strictEqual(dre.source, 'PRICE');
  assert.strictEqual(dre.stage, 'needs_info');
  assert.deepStrictEqual(P.missingDetails(dre), ['vehicle', 'service']);
});

test('missing pricing goes to the owner for review', () => {
  const { leads } = imp({}, P.sampleRows());
  const priya = leads[P.leadId('instagram', 'sample_priya', 'BOOK')];
  const none = P.draftQuote(priya, P.clone(P.DEFAULT_CONFIG), T0);
  assert.strictEqual(none.quote.status, 'needs_review');
  assert.strictEqual(none.stage, 'ready_to_quote');
  assert.ok(P.attention(none).some((a) => a.agent === 'quote'));
  const partial = P.draftQuote(priya, cfg(), T0); // ceramic sedan has price; suv/truck do not
  assert.strictEqual(partial.quote.status, 'drafted');
  const suv = P.draftQuote(Object.assign(P.clone(priya), { vehicleClass: 'suv' }), cfg(), T0);
  assert.strictEqual(suv.quote.status, 'needs_review');
  assert.match(suv.quote.reason, /suv price/);
});

test('full path: inquiry to intake to quote to approval to booking handoff', () => {
  const { leads } = imp({}, P.sampleRows());
  let l = leads[P.leadId('instagram', 'sample_marcus', 'PRICE')];
  assert.strictEqual(l.stage, 'ready_to_quote');
  l = P.draftQuote(l, cfg(), T0);
  assert.strictEqual(l.stage, 'awaiting_approval');
  assert.strictEqual(l.quote.amount, 200);
  assert.match(l.reply.text, /\[\[QUOTE NEEDED\]\]|\$200/);
  assert.throws(() => P.prepareBooking(l, cfg(), {}, T0)); // no booking before approval
  l = P.approveQuote(l, 200, cfg(), T0);
  assert.strictEqual(l.stage, 'approved');
  assert.match(l.reply.text, /\$200/);
  assert.deepStrictEqual(l.reply.missing, []);
  l = P.prepareBooking(l, cfg(), {}, T0);
  assert.strictEqual(l.stage, 'booking_handoff');
  assert.strictEqual(l.booking.status, 'link_ready');
  assert.throws(() => P.confirmBooked(l, '', T0)); // booked only after confirmation
  l = P.confirmBooked(l, '2026-11-25T15:00', T0);
  assert.strictEqual(l.stage, 'booked');
  assert.ok(l.history.length >= 5);
});

test('no booking link or custom time request flags a custom slot', () => {
  const { leads } = imp({}, P.sampleRows());
  let l = P.draftQuote(leads[P.leadId('instagram', 'sample_marcus', 'PRICE')], cfg(), T0);
  l = P.approveQuote(l, 200, cfg(), T0);
  const c = cfg(); c.links.booking = '';
  assert.strictEqual(P.prepareBooking(l, c, {}, T0).booking.status, 'needs_custom_slot');
  assert.strictEqual(P.prepareBooking(l, cfg(), { customSlot: true }, T0).booking.status, 'needs_custom_slot');
});

test('follow-ups and review requests become due', () => {
  const { leads } = imp({}, P.sampleRows());
  let l = P.draftQuote(leads[P.leadId('instagram', 'sample_marcus', 'PRICE')], cfg(), T0);
  const later = '2026-11-24T10:00:00.000Z';
  const due = P.followUps({ [l.id]: l }, cfg(), later);
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].kind, 'quote');
});

test('parseTable reads a pasted Google Sheet', () => {
  const rows = P.parseTable('Timestamp\tInstagram handle\tKeyword\n1\t@x\tPRICE\n');
  assert.deepStrictEqual(rows, [{ Timestamp: '1', 'Instagram handle': '@x', Keyword: 'PRICE' }]);
});
