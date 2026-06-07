# Announcements API

Marquee announcements — a single line of admin-set text shown in the frontend
scrolling banner.

Base URL: `{{baseUrl}}`

---

## Public

### GET `/announcements/active`
Active marquee lines for the frontend (newest first). No auth.

**Response `200`**
```json
[
  { "id": 1, "message": "🎉 10% Bonus on first deposit via Bkash!" },
  { "id": 2, "message": "🔥 New 5D Jackpot is live" }
]
```

---

## Admin
All admin routes require `Authorization: Bearer <admin token>`.

### GET `/announcements/admin`
List all announcements (active + inactive).

**Response `200`**
```json
[
  {
    "id": 1,
    "message": "🎉 10% Bonus on first deposit via Bkash!",
    "is_active": true,
    "created_at": "2026-06-07T10:00:00.000Z",
    "updated_at": "2026-06-07T10:00:00.000Z"
  }
]
```

### POST `/announcements/admin`
Create a new line.

**Body**
| Field | Type | Required | Notes |
|---|---|---|---|
| `message` | string | yes | 1–500 chars |
| `isActive` | boolean | no | default `true` |

```json
{
  "message": "🎉 10% Bonus on first deposit via Bkash! New 5D Jackpot live",
  "isActive": true
}
```

**Response `201`**
```json
{
  "id": 3,
  "message": "🎉 10% Bonus on first deposit via Bkash! New 5D Jackpot live",
  "is_active": true,
  "created_at": "2026-06-07T11:00:00.000Z",
  "updated_at": "2026-06-07T11:00:00.000Z"
}
```

### PATCH `/announcements/admin/:id`
Update the text and/or toggle active state. Send only the fields you want to change.

**Body**
| Field | Type | Required | Notes |
|---|---|---|---|
| `message` | string | no | 1–500 chars |
| `isActive` | boolean | no | `false` hides it from the marquee |

```json
{
  "message": "Updated announcement text",
  "isActive": false
}
```

**Response `200`**
```json
{
  "id": 3,
  "message": "Updated announcement text",
  "is_active": false,
  "created_at": "2026-06-07T11:00:00.000Z",
  "updated_at": "2026-06-07T11:05:00.000Z"
}
```

**Errors**
- `400` — no fields provided to update
- `404` — announcement not found

### DELETE `/announcements/admin/:id`
Remove a line permanently.

**Response `200`**
```json
{ "message": "Announcement deleted", "id": 3 }
```

**Errors**
- `404` — announcement not found

---

## Summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/announcements/active` | Public | Active lines for the marquee |
| GET | `/announcements/admin` | Admin | List all (active + inactive) |
| POST | `/announcements/admin` | Admin | Create a line |
| PATCH | `/announcements/admin/:id` | Admin | Update text / toggle active |
| DELETE | `/announcements/admin/:id` | Admin | Delete a line |
