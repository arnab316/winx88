# WinX88 — Device Contacts API (player app)

Companion to `WinX88-Contacts.postman_collection.json`.

Three player-facing endpoints. The app asks for the OS contacts permission, uploads the
address book in chunks, and can show or erase what was uploaded. Admin endpoints exist
(`/contacts/admin/*`) but are **not** part of this integration and are excluded here.

Source: `src/contacts/` · migration `src/migrations/2400000000000-devicecontacts.ts`

---

## 1. Environments

| Environment | Base URL |
|---|---|
| Beta / staging | `https://beta.safurion.online` |
| Production | `https://safurion.online` |
| Local | `http://localhost:3000` |

No global route prefix — paths are literal (`/contacts/sync`, not `/api/contacts/sync`).

---

## 2. Auth

Every contacts route requires a **player** token:

```
Authorization: Bearer <accessToken>
```

Get one with `POST /auth/login  { username, password }`.

The uploader is read from the token (`req.user.sub`). There is no `userId` field in any
request body — a client cannot upload a book on behalf of another account, and must not
try to send one.

---

## 3. Endpoints

### 3.1 `POST /contacts/sync` — upload one chunk

Call once per chunk, immediately after the player grants the contacts permission.

```http
POST /contacts/sync
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "contacts": [
    { "name": "Rahim Uddin", "phone": "+8801712345678" },
    { "name": "Karim", "phone": "01812345678" },
    { "phone": "8801912345678" }
  ],
  "platform": "android",
  "deviceModel": "Redmi Note 12",
  "appVersion": "1.4.0"
}
```

| Field | Type | Required | Limit | Notes |
|---|---|---|---|---|
| `contacts` | array | yes | **max 400 items** | more than 400 → `400` validation error |
| `contacts[].phone` | string | yes | ≤ 64 chars | send it exactly as the device has it, do not reformat |
| `contacts[].name` | string | no | ≤ 200 chars | omit for a nameless number |
| `platform` | string | no | ≤ 20 | `"android"` / `"ios"` |
| `deviceModel` | string | no | ≤ 120 | |
| `appVersion` | string | no | ≤ 40 | |

Response `201`:

```json
{
  "success": true,
  "data": { "received": 400, "stored": 387, "matched": 12, "syncId": 91 }
}
```

| Field | Meaning |
|---|---|
| `received` | how many the server was sent |
| `stored` | how many were kept — see note below, `stored < received` is normal |
| `matched` | how many of them are already players on the platform |
| `syncId` | id of this upload's log row; useful in a bug report |

**`stored` is legitimately lower than `received`.** The server drops anything that
normalises to fewer than 6 digits (shortcodes, extensions, `*123#` service dial strings)
and collapses the same number written two ways inside one chunk. Do not treat the
difference as an error or retry because of it.

**Retries are free.** Storage is an upsert keyed on (player, normalised number), so
re-sending an identical chunk after a timeout updates the existing rows instead of
duplicating them. Retry the failed chunk, not the whole book.

**An empty `contacts: []` is valid** and still records an upload. Send it when the player
grants permission but has no contacts — the server treats "consented and sent nothing" and
"never consented" as different facts.

---

### 3.2 `GET /contacts/me/summary` — what the server holds

```http
GET /contacts/me/summary
Authorization: Bearer <token>
```

```json
{
  "success": true,
  "data": {
    "total": 387,
    "matched": 12,
    "lastUpload": "2026-11-13T14:21:09.000Z",
    "lastSync": {
      "created_at": "2026-11-13T14:21:09.000Z",
      "received_count": 400,
      "stored_count": 387,
      "device_model": "Redmi Note 12"
    }
  }
}
```

`lastSync` is `null` if the player has never uploaded. Back the privacy screen with this —
a player who granted the permission is entitled to see what it produced, and a build that
hides it is the kind that gets pulled from the store.

---

### 3.3 `DELETE /contacts/me` — erase

```http
DELETE /contacts/me
Authorization: Bearer <token>
```

```json
{ "success": true, "data": { "deleted": 387 } }
```

Deletes every stored contact for this player. The upload log rows survive by design: they
are the record that an upload happened and was later withdrawn.

**The client is the only thing that can trigger this.** Android never tells a server that
a permission was revoked, so unless the app calls this, the data outlives the consent
indefinitely. Required client behaviour:

- check the contacts permission on **every launch**
- if it was granted before and is now denied → call `DELETE /contacts/me` once
- also call it when the player turns the feature off in-app

---

## 4. Errors

All failures come back in the same envelope:

```json
{ "success": false, "message": "..." }
```

| Status | Cause | What the client should do |
|---|---|---|
| `400` | validation — over 400 contacts, missing `phone`, field too long | fix the payload; do not retry unchanged |
| `401` | missing / expired token | refresh the token, then retry |
| `413` | payload above the proxy's body limit | reduce chunk size; see §5 |
| `500` | server-side failure | retry the chunk with backoff |

A `413` from nginx is returned **before** the app is reached, so it carries no CORS headers
and no JSON body. In a browser this surfaces as a bare "Failed to fetch" with nothing in
the server logs. If a sync fails with no response body, suspect the body limit first.

---

## 5. Chunking

Chunk at **400 contacts or fewer** — the server rejects more. Roughly 40KB of JSON per
chunk. A 2,000-contact book is five sequential requests.

Send chunks **sequentially**, not in parallel: each one writes an upload-log row, and
parallel chunks produce a misleading set of receipts for a single sync.

Suggested client loop:

```
for each chunk of 400:
    POST /contacts/sync
    on 5xx / network error → retry the same chunk, up to 3 times, backing off
    on 400 → stop, log, do not retry
accumulate `stored` + `matched` across chunks for any progress UI
```

---

## 6. Consent — not optional

The upload stores phone numbers of people who are **not** users of this platform and who
never agreed to anything. Only the uploader consented, and they cannot consent for their
contacts. Two client-side requirements follow:

1. The permission prompt must say, in plain words, that the contact list is **uploaded to
   WinX88 servers** — not merely that the app "needs access to your contacts". A rationale
   screen before the OS dialog is the usual place for this.
2. The in-app privacy screen must show the summary (§3.2) and offer the erase action
   (§3.3). Both need to be reachable without contacting support.

Store-listing data-safety declarations have to match this: contacts are collected,
transmitted off-device, and retained until deleted.

---

## 7. Server prerequisites

Before the client can be tested against an environment:

- migration `2400000000000-devicecontacts.ts` must be run there
  (`npm run typeorm -- migration:run` — the plain `migration:run` script is broken on Node 24)
- nginx on that host needs `client_max_body_size` raised from the 1MB default
  (`20m`, to match the Express body limit set in `src/main.ts`); beta's vhost had no such
  directive, so it was capped at 1MB
