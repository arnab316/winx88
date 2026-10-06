# WinX88 — Mobile App API Guide

Companion to `WinX88-Mobile-App.postman_collection.json` (34 folders, 178 player-facing
endpoints). Admin endpoints are excluded — they are not for the player app.

---

## 1. Environments

| Environment | Base URL |
|---|---|
| Beta / staging | `https://beta.safurion.online` |
| Production | `https://safurion.online` |
| Local | `http://localhost:3000` |

Set `baseUrl` in the collection's **Variables** tab.

---

## 2. Authentication

All protected endpoints take a bearer token:

```
Authorization: Bearer <accessToken>
```

### Registration flow

```
POST /auth/send-otp              { phoneNumber }
POST /auth/verify-otp-register   { phoneNumber, otp }
POST /auth/register              { username, password, phoneNumber, currency }
```

### Login

```
POST /auth/login                 { username, password }
```

The collection's login request **saves the token automatically** into `{{token}}`, so every
other request works immediately after it.

> The token field name has varied between builds. The login test script accepts
> `accessToken`, `access_token`, `token`, and the same nested under `data`. Confirm which one
> your build returns and hard-code it in the app rather than guessing at runtime.

### Refresh / reset

```
POST /auth/refresh-token         { refreshToken }
POST /auth/forgot-password       { phoneNumber }
POST /auth/verify-reset-otp      { phoneNumber, otp }
POST /auth/reset-password        { phoneNumber, otp, newPassword }
```

### Auth levels used in the collection

| Level | Meaning |
|---|---|
| `public` | No token |
| `player` | Bearer token required |
| `optional` | Works signed-out; returns extra per-player fields (e.g. `isFavourite`) when a token is sent |

**A 401 on any endpoint means log the user out** — the web client treats 401 as session death
and clears state. Do the same in the app so a stale token can't leave the UI half-authenticated.

---

## 3. Realtime (Socket.IO — not REST)

Three namespaces. The JWT goes in the handshake, not a header:

```js
io(`${baseUrl}/notifications`, {
  auth: { token: `Bearer ${accessToken}` },
  transports: ['websocket'],
});
```

| Namespace | Events |
|---|---|
| `/notifications` | `notification:new`, `notification:unread` |
| `/wallet` | `wallet:balance` |
| `/games` | `round:opened`, `round:closed` |

**Sockets are an optimisation, never the source of truth.** On connect, and every time the app
returns to the foreground, re-fetch over REST (`GET /notifications`, `GET /notifications/unread-count`).
Mobile OSes kill sockets aggressively in the background; a design that only listens will lose
messages.

---

## 4. Notifications

### In-app inbox

```
GET    /notifications?limit=20        list + unread count
GET    /notifications/unread-count    badge only (cheap)
PATCH  /notifications/:id/read
POST   /notifications/read-all
GET    /notifications/preferences
PUT    /notifications/preferences     { items: [{ category, channel, enabled }] }
```

Categories: `TRANSACTIONAL`, `GAMEPLAY`, `PROMOTIONAL`, `SECURITY`.
Channels: `IN_APP`, `SOCKET`, `PUSH`, `SMS`, `EMAIL`.

### Opt-in defaults — read this before testing

Defaults are **per channel**, not per category:

| Category | `IN_APP` / `SOCKET` | `PUSH` / `SMS` / `EMAIL` |
|---|---|---|
| `TRANSACTIONAL`, `SECURITY`, `GAMEPLAY` | ON | ON |
| `PROMOTIONAL` | **ON** | **OFF** |

Marketing shown inside the app is on by default; marketing that leaves the app
and lands on the device needs an explicit opt-in. `TRANSACTIONAL` and `SECURITY`
are in `alwaysOn` and a `PUT` trying to disable them returns 400.

Admin broadcasts are **always** `PROMOTIONAL` — the server overrides whatever
category is sent, so a broadcast cannot masquerade as transactional.

`GET /notifications/preferences` returns `defaults` (nested `category → channel →
bool`), `alwaysOn`, and `overrides`. **A missing override means "use the
default", not "off"** — resolve it client-side:

```ts
const row = overrides.find(o => o.category === c && o.channel === ch);
const effective = row ? row.enabled : defaults[c][ch];
```

Build a "Promotions and offers" toggle (writes `PROMOTIONAL` × `IN_APP`+`SOCKET`)
and let the push opt-in write `PROMOTIONAL` × `PUSH`.

---

## 5. Push notifications — read carefully

**The push currently implemented is Web Push (VAPID).** It targets browsers and installed
PWAs:

```
GET    /notifications/push/key          → { enabled, publicKey }   (public)
GET    /notifications/push/status       → { subscribed, devices }
POST   /notifications/push/subscribe    ← browser PushSubscription.toJSON()
DELETE /notifications/push/unsubscribe  { endpoint }
```

### Does this work for your app?

| App type | Works with the current API? |
|---|---|
| Mobile **website** / PWA on Android Chrome | **Yes** |
| PWA on iOS | Only if the user does *Add to Home Screen* — Apple does not deliver push to a normal Safari tab |
| **React Native / Flutter / native Android / native iOS** | **No** |
| Capacitor / Cordova WebView wrapper | **No** — these use the native push plugins, i.e. FCM/APNs |

### Why native apps do not work

A native app has no service worker and no browser `PushSubscription`. It receives push through
**FCM** (Android) and **APNs** (iOS), which use a *device token*, not an endpoint + `p256dh` +
`auth` key triple. The server would be signing VAPID payloads nothing in the app can receive.

### What is needed to support a native app

1. A Firebase project, with an APNs key uploaded for iOS.
2. `firebase-admin` on the backend, plus the service-account JSON as a secret.
3. A `device_tokens` table and an endpoint such as `POST /notifications/push/device` taking
   `{ token, platform: 'ANDROID' | 'IOS', appVersion }`.
4. A send path that fans out to FCM alongside the existing Web Push call.

**None of that exists yet.** The in-app inbox and the `/notifications` socket work in a native
app today; only out-of-app push does not.

---

## 6. Common flows

**Home screen**

```
GET /hero-banner/active
GET /home-shortcuts/active
GET /promo-banners/active
GET /announcements/active
GET /me/continue-playing?limit=12      [player]
GET /game-content/list?badge=HOT       [optional]
```

**Launching a game** — launching is per-provider, there is no unified endpoint:

```
POST /slot/launch      { provider_id, game_symbol, return_url, lang, win_ratio }   Palace slots
POST /oroplay/launch   { vendorCode, gameCode, language, lobbyUrl }                Live casino
GET  /nexus/launch?uuid=<catalogUuid>&lang=en                                      Nexus
GET  /nexus/sportsbook/launch?lang=en                                              Sportsbook
```

All return a URL to open in a WebView.

**Favourites**

```
GET    /me/favourites
POST   /me/favourites     { kind, providerRef, gameCode, gameName, gameImage, providerName }
DELETE /me/favourites     { kind, providerRef, gameCode }
```

A game is identified by the triple `(kind, providerRef, gameCode)` — `kind` is
`SLOT` | `ORO` | `NEXUS`. There is no single game id across providers.

**Promotions**

```
GET /promotion-cms/public?currency=BDT                  signed-out
GET /promotion-cms/me?currency=BDT                      [player]
GET /promotion-cms/public/:id                           detail (+ derived `highlights`)
```

Filter chips use `&category=WELCOME|RELOAD|CASHBACK|VIP|REFER|FREEBIE`.

---

## 7. Known issues to design around

- **Live casino (OroPlay) is failing in production** with `errorCode 401` on token creation.
  `/oroplay/games` and `/oroplay/launch` return 500 until the provider credentials are fixed.
  Handle that as "temporarily unavailable" rather than a crash.
- **OroPlay rate-limits to 1 request per 10s** and the client retries ~7×, so a burst produces
  `API calls quota exceeded`. Do not poll these endpoints.
- **Uploads are capped at ~1 MB** by nginx. Anything larger returns a 413 whose body is an
  nginx HTML page, not JSON — parse defensively.
- OroPlay games are **not in the catalog**, so their name/image may be missing; fall back to the
  game code and a placeholder.
