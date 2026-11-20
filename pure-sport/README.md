# Pure Sport Command

Private dashboard for Pure Sport Detailing. Five draft-only agents share one lead record. Instagram is connected first (ManyChat + Google Form/Sheet). Other platforms plug in as adapters.

This folder is self-contained so it can move to its own repo as-is.

## Layout
- `src/core.js`: all lead logic (ingest, dedupe, quote, booking, follow-up). No DOM, no network.
- `src/app.js`, `src/style.css`, `src/shell.html`: the dashboard.
- `build.py`: inlines everything into `dist/index.html`, the file that is published.
- `tests/core.test.js`: `node --test tests/core.test.js`

## Rules the code enforces
- Agents only draft. The owner sends every message and approves every quote, booking and post.
- A lead is keyed on platform + handle + keyword. Re-pasting a Sheet row or commenting twice never creates a second lead.
- Missing pricing, missing vehicle size or a missing booking link routes the job to the owner. Nothing is guessed.
- A job is `booked` only after the owner confirms a date and time.
- Publishing is off. Nothing is sent to ManyChat, Instagram or Buffer by this code.

## Adding a platform
Register an adapter in `core.js`: `PSD.registerAdapter('tiktok', { normalize(row) { return { ok: true, evt: {...} } } })`. It returns the same event shape as the Instagram adapter; the lead record and agents do not change.

## Sheet columns the Instagram adapter reads
`Timestamp, Instagram handle, Keyword, Reel, Name, Vehicle (year make model), Vehicle size, Service wanted, Photos link, Notes`. Setup steps are in the dashboard's Setup page.
