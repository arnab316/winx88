# Frontend spec — marketing channel tracking

**For the frontend developer.** The backend is live; this is the piece that
makes it work. Without it, paid-ad clicks are recorded but **no registration is
ever attributed**, so the media buyer's report shows clicks and zero signups.

---

> **The tracking link host is `safurion.online`, not the website.**
> `https://winx-88.com/c/<code>` does NOT work — the website has no `/c/` route,
> so it serves the app shell (or a 404) and the click is lost with no trace.
> Nothing in this document changes that; see "Optional: serving links from the
> brand domain" at the end if you want the brand-domain form.

## Why the frontend is involved at all

The backend can log the click (it happens on our server, at `/c/:code`). But
registration is a form your app submits — the server has no way to know which
ad the user came from unless **you carry that value across the journey and put
it in the register payload.**

The journey looks like this:

```
1. User clicks an ad
   → lands on  https://safurion.online/c/fb_bd_q3
   → BACKEND logs the click, generates a click id (cid), redirects to:
     https://winx-88.com/register?channel=fb_bd_q3&cid=8b41...

2. User browses around, maybe closes the tab, comes back tomorrow
   ← the params are LOST from the URL here unless you saved them   ← YOUR JOB

3. User registers
   → POST /auth/register  { ...credentials, channel, cid }          ← YOUR JOB
   → backend ties the account to the campaign
```

Steps 2 and 3 are the whole task.

---

## What to implement

### 1. On every page load — capture

Read `channel` and `cid` from the query string. Save them **only if nothing is
already saved** (first touch wins — this matches the server, which will ignore a
second attribution for the same user anyway).

```js
const KEY = 'mkt_attr';
const MAX_AGE_DAYS = 30;

export function captureChannel() {
  const params = new URLSearchParams(window.location.search);
  const channel = params.get('channel');
  if (!channel) return;

  // First touch wins — never overwrite an existing attribution.
  if (localStorage.getItem(KEY)) return;

  localStorage.setItem(KEY, JSON.stringify({
    channel,
    cid: params.get('cid') || null,
    ts: Date.now(),
  }));
}
```

Call this as early as possible, before any router logic strips the query string.

### 2. Read helper — with expiry

```js
export function getChannelAttribution() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const ageDays = (Date.now() - data.ts) / 86400000;
    if (ageDays > MAX_AGE_DAYS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
```

### 3. Beacon — only when `channel` is present but `cid` is not

This covers traffic that lands on the homepage or a promo page with
`?channel=fb_bd_q3` rather than going through `/c/:code`. In that case no click
was recorded server-side, so tell the backend.

```js
export async function beaconChannel() {
  const attr = getChannelAttribution();
  if (!attr || attr.cid) return;                 // nothing to do
  if (sessionStorage.getItem('mkt_beaconed')) return;  // once per session
  sessionStorage.setItem('mkt_beaconed', '1');

  try {
    const res = await fetch(`${API_BASE}/c/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: attr.channel,
        landingPath: window.location.pathname,
      }),
    });
    const { cid } = await res.json();
    if (cid) {
      localStorage.setItem(KEY, JSON.stringify({ ...attr, cid }));
    }
  } catch {
    // Never block the page on tracking.
  }
}
```

### 4. Registration — forward both values

```js
const attr = getChannelAttribution();

await api.post('/auth/register', {
  full_name,
  username,
  password,
  phone_number,
  // ...whatever you send today, unchanged
  ...(attr?.channel ? { channel: attr.channel } : {}),
  ...(attr?.cid ? { cid: attr.cid } : {}),
});
```

Send the keys **only when you have values** — omit them rather than sending
empty strings.

---

## Rules that matter

**Don't strip the query params before step 1 runs.** If your router cleans the
URL on mount, capture must happen first.

**Don't block the register button on the beacon.** It is fire-and-forget. A
failed beacon costs one attribution; a hung button costs a customer.

**Don't overwrite an existing stored attribution.** First touch wins. If you
overwrite on every visit, a user who first arrived via a paid ad and later via
an organic link would be credited to nobody, and the numbers stop matching what
the vendor is invoiced for.

**Send `channel` and `cid` on every registration**, not just when the user
registers in the same session they landed. That is the entire point of storing
it.

**Never invent or guess a `cid`.** The backend verifies that the click id
actually belongs to the submitted channel and silently discards it if not.

---

## Testing

1. Open `https://safurion.online/c/fb_bd_q3` in a clean browser profile. You should
   land on `/register?channel=fb_bd_q3&cid=<uuid>`.
2. Check `localStorage.mkt_attr` — it should hold both values.
3. Navigate away, close the tab, reopen the site normally. `mkt_attr` should
   still be there and unchanged.
4. Register. Confirm the network payload contains `channel` and `cid`.
5. Ask backend to confirm a row appeared in `user_channel_attribution` with
   `source = 'REDIRECT'`.
6. Repeat in a clean profile using `https://winx-88.com/?channel=fb_bd_q3` (no
   `/c/`). The beacon should fire, store a `cid`, and the row should show
   `source = 'PARAM'`.

---

## API summary

| Endpoint | Method | Body | Purpose |
|---|---|---|---|
| `/c/:code` | GET | — | Backend-handled. Your ad links point here; it redirects to you |
| `/c/track` | POST | `{ channel, landingPath?, subId? }` | Beacon. Returns `{ ok, cid }` |
| `/auth/register` | POST | existing fields **+** `channel`, `cid` | Attribution |

`/c/track` is rate limited to 120 requests per minute per IP — call it once per
session, not per page view.

---

## Optional: serving links from the brand domain

Everything above works with links of the form
`https://safurion.online/c/<code>`. If you want the link to read
`https://winx-88.com/c/<code>` instead — nicer for Facebook, which scrutinises
ads pointing at unfamiliar redirect hosts — that is a **separate, independent
job**. Implementing the capture/forward steps above does not create the `/c/`
route; the website would still 404.

Two ways to get it, pick one:

**A. Edge rewrite (recommended — no app code).** Cloudflare sits in front of
the domains, so a Rule or Worker forwarding `/c/*` to the API does it:

```nginx
location /c/ {
    proxy_pass https://safurion.online;
    proxy_set_header Host $host;
}
```

The backend keeps doing the logging and redirecting, exactly as now. Nothing in
this document changes.

**B. A frontend route.** Add a `/c/:code` route that calls
`POST {API}/c/track` with the code, stores the returned `cid`, then sends the
user to `/register`. Works, but it is strictly worse than A: the click is only
recorded if JavaScript runs, so ad-blockers and fast bounces lose clicks that
the server-side path would have caught.

Until one of these ships, **give the vendor `safurion.online/c/<code>` links.**
