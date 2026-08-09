# WinX88 Partner Reporting API

For media buyers running paid traffic to WinX88. Gives you per-campaign clicks,
registrations, first-time deposits (FTDs) and deposit totals.

**Base URL:** `https://safurion.online`

> Tracking links and API calls both go to this host — it is the platform API.
> Links pointing at `winx-88.com/c/...` will NOT register clicks; that domain
> serves the player website, not the API.

---

## 1. What you receive from us

| Item | Example | Notes |
|---|---|---|
| Tracking link (one per campaign) | `https://safurion.online/c/fb_bd_q3` | Point your ad's destination URL here |
| API key | `mk_FjPuftDN.xxxxxxxxxxxxxxxxxxxxxxxxx` | Shown once. Store it securely — it cannot be recovered |

Campaign codes are created by us on request. Tell us the codes you want before
launch and we will register them and send the links back.

---

## 2. Tracking links

Set your ad destination to:

```
https://safurion.online/c/<campaign_code>
```

We record the click and redirect the visitor to the registration page. You may
append `?sub=<value>` to pass an ad-set or creative id through:

```
https://safurion.online/c/fb_bd_q3?sub=adset_77
```

**Do not modify the link beyond `sub`.** Rewriting or shortening it through a
third-party redirector can strip the click id and break attribution for that
visitor.

If a campaign code has not been registered with us, the visitor is still
redirected normally (we never break a paid click) but the click will not appear
in your report until we register the code. Registering it later does **not**
recover earlier clicks, so confirm your codes are live before you scale spend.

---

## 3. Authentication

Send your key in the `x-api-key` header on every request:

```
x-api-key: mk_FjPuftDN.xxxxxxxxxxxxxxxxxxxxxxxxx
```

All failures return `401 Unauthorized` with the same body. We do not
distinguish between an unknown key, a wrong key and a revoked key.

```json
{ "message": "Invalid API key", "error": "Unauthorized", "statusCode": 401 }
```

Your key only ever returns your own campaigns. There is no parameter that can
widen its scope.

**Rate limit:** 60 requests per minute per key. Exceeding it returns `429`.

---

## 4. `GET /partner/channels`

Lists your campaigns and their tracking links.

```bash
curl -H "x-api-key: $KEY" https://safurion.online/partner/channels
```

```json
{
  "success": true,
  "data": [
    {
      "code": "fb_bd_q3",
      "name": "Facebook BD Q3",
      "platform": "FACEBOOK",
      "isActive": true,
      "createdAt": "2026-08-01T17:12:39.389Z",
      "trackingUrl": "https://safurion.online/c/fb_bd_q3"
    }
  ]
}
```

---

## 5. `GET /partner/stats`

The main report.

### Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `dateFrom` | `YYYY-MM-DD` | unbounded | Inclusive |
| `dateTo` | `YYYY-MM-DD` | unbounded | **Inclusive** — `dateTo=2026-08-01` includes all of 1 Aug |
| `channel` | string | all your campaigns | Restrict to one campaign code |
| `granularity` | `total` \| `day` | `total` | `day` returns one row per campaign per day |

For `granularity=day`, `dateFrom` and `dateTo` are **required** and the range
may not exceed **92 days**. Wider ranges return `400`.

### Example

```bash
curl -H "x-api-key: $KEY" \
  "https://safurion.online/partner/stats?dateFrom=2026-08-01&dateTo=2026-08-31&granularity=day"
```

```json
{
  "success": true,
  "granularity": "day",
  "dateFrom": "2026-08-01",
  "dateTo": "2026-08-31",
  "trackingSince": "2026-08-01T17:12:53.342Z",
  "data": [
    {
      "channel": "fb_bd_q3",
      "channelName": "Facebook BD Q3",
      "platform": "FACEBOOK",
      "date": "2026-08-01",
      "clicks": 1420,
      "registrations": 63,
      "ftds": 11,
      "ftdAmount": 12400,
      "depositCount": 98,
      "depositTotal": 214500
    }
  ]
}
```

### Field definitions

| Field | Definition |
|---|---|
| `clicks` | Hits on your tracking link, counted by click date |
| `registrations` | Accounts created that were attributed to the campaign, counted by **registration date** |
| `ftds` | Players whose **first-ever** approved deposit fell in the period |
| `ftdAmount` | Sum of those first deposits (BDT) |
| `depositCount` | All approved deposits by attributed players in the period |
| `depositTotal` | Sum of those deposits (BDT) |
| `trackingSince` | Timestamp of your first recorded click. Ranges before this return zeros |

---

## 6. Counting rules — please read before reconciling

These are the rules the numbers are produced under. They are not negotiable
after the fact, so raise anything you disagree with before launch.

**A deposit is only counted once approved.** Pending and rejected deposits never
appear. An approved deposit is counted on its approval date, not its request
date.

**`ftds` counts a player's first-ever approved deposit, not their first deposit
in the window.** A player who deposited in August and again in September counts
as an FTD in August only. This means `ftds` will normally be lower than
`depositCount`, and `ftdAmount` lower than `depositTotal`. That is correct.

**Registrations are counted by registration date, not click date.** A visitor
who clicks on 1 August and registers on 5 August appears in the 1 August click
count and the 5 August registration count. There is **no lookback window** and
we do not reallocate registrations back to the click date.

**First touch wins.** If a player arrives through campaign A and later through
campaign B before registering, they are attributed to A permanently. Attribution
is never rewritten.

**No historical data.** Tracking begins at go-live. Any period before
`trackingSince` legitimately returns zeros.

**Expect our numbers to be lower than your ad platform's**, typically by 10-30%.
Ad platforms count modelled and view-through conversions; we count only what
actually reached our servers. Visitors who block scripts, bounce before the page
loads, or arrive through a link rewriter may be missing from our figures.

---

## 7. Errors

| Code | Meaning |
|---|---|
| `400` | Bad parameters — e.g. `granularity=day` over more than 92 days, or missing dates |
| `401` | Missing, invalid, expired or revoked API key |
| `429` | Rate limit exceeded (60/min) |

---

## 8. Key handling

- The key is shown **once** at issuance and stored by us only as a hash. If it
  is lost we cannot recover it — we issue a new one.
- To rotate: we issue a new key, you switch over, then we revoke the old one.
  Both work during the overlap.
- Report a suspected leak immediately and we will revoke on the spot.
- The key grants **read access to your own campaign statistics only**. It cannot
  read player data, other vendors' campaigns, or anything else.

---

## 9. What we do not expose

The API returns aggregates only. It will never return player usernames, user
ids, phone numbers, email addresses, IP addresses or device information, in any
endpoint or parameter combination. If your reporting needs player-level data,
that is a commercial and data-protection conversation, not an API change.
