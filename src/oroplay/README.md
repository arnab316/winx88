# OroPlay Integration

This module integrates **OroPlay** (live casino, slot, and mini-game aggregator) with your backend. It follows the same pattern as the existing `palace-casino/` module but adapts to OroPlay's API conventions.

---

## Quick Setup

### 1. Add env vars to `.env`

```env
# OroPlay outbound (you → OroPlay)
OROPLAY_API_ENDPOINT=https://api-endpoint.oroplay.com/api/v2
OROPLAY_CLIENT_ID=your-client-id-here
OROPLAY_CLIENT_SECRET=your-client-secret-here
```

> The same `clientId` + `clientSecret` are used by OroPlay to call **you** via Basic Auth — no separate inbound secret.

### 2. Run the migration

```bash
psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f src/oroplay/migrations/001_oroplay.sql
```

### 3. Register the module in `app.module.ts`

```typescript
import { OroplayModule } from './oroplay/oroplay.module';

@Module({
  imports: [
    // ... existing modules
    OroplayModule,
  ],
})
export class AppModule {}
```

### 4. Tell OroPlay your callback URLs

Provide these to OroPlay support during onboarding:

```
POST https://your-domain.com/oroplay/balance
POST https://your-domain.com/oroplay/transaction
POST https://your-domain.com/oroplay/batch-transactions
```

Also give them your **server IPs** for whitelisting.

---

## Frontend API

All under `/oroplay/*` and protected by `JwtAuthGuard`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/oroplay/vendors` | List vendors (Pragmatic, Habanero, etc.) |
| `POST` | `/oroplay/games` | List games for a vendor `{ vendorCode, language }` |
| `POST` | `/oroplay/game-detail` | Single game info `{ vendorCode, gameCode }` |
| `POST` | `/oroplay/launch` | Get iframe URL `{ vendorCode, gameCode, language?, lobbyUrl?, theme? }` |
| `GET` | `/oroplay/history?startDate=...&limit=...` | Betting history (rate-limited 1/sec) |

---

## Architectural notes

### Token caching is mandatory

OroPlay's `POST /auth/createtoken` is **rate-limited to 5 requests per 30 seconds**, and exceeding the limit can result in account blocking. `OroplayTokenCache` handles this — it caches the token in memory and refreshes 60 seconds before expiry. It also deduplicates concurrent refresh requests using an in-flight Promise.

### userCode = username

Unlike Palace Casino (which returns a numeric `user_code`), OroPlay lets **you** choose the userCode. We pass the player's `username` as the userCode for simplicity. Result: no mapping table needed — we just flag `users.oroplay_registered = TRUE` after first `createUser` call.

### Lazy user creation

OroPlay user creation happens on the first game launch (`ensureOroplayUser` in `OroplayController`), not at registration. This matches the existing Palace pattern. If you want eager creation, hook `oroplay.createUser(username)` into `AuthService.register()` after `commitTransaction()`.

### Idempotency

Every transaction's `transactionCode` is enforced UNIQUE in `oroplay_transactions`. If OroPlay retries the same transaction, we return `errorCode=6 DUPLICATE_TRANSACTION` so they stop. We also check `roundId` for finished rounds and return `errorCode=7 INVALID_TRANSACTION` if a new tx comes in after the round closed.

### Why HTTP 200 always?

Both `OroplayCallbackController` and `OroplayClient` always return HTTP 200 from callback endpoints. Errors are signaled in the JSON `errorCode` field. If we returned 4xx/5xx, OroPlay would retry indefinitely — potentially double-charging the player.

---

## File map

```
src/oroplay/
├── oroplay.module.ts                  — Nest module registration
├── oroplay.client.ts                  — Outbound API client (you → OroPlay)
├── oroplay.controller.ts              — Frontend-facing endpoints (JWT-protected)
├── oroplay-callback.controller.ts     — Inbound callbacks (Basic Auth verified)
├── oroplay-callback.service.ts        — Wallet update + idempotency logic
├── token-cache.service.ts             — Caches createToken response
├── dto/
│   ├── outbound.dto.ts                — OroPlay request/response shapes
│   └── callback.dto.ts                — Inbound DTOs + OROPLAY_ERROR codes
└── migrations/
    └── 001_oroplay.sql                — DB schema
```

---

## Error code reference

| Code | Constant | When we return it |
|---|---|---|
| 0 | `NO_ERROR` | Successful transaction |
| 2 | `USER_DOES_NOT_EXIST` | username not found in our `users` table |
| 4 | `INSUFFICIENT_USER_BALANCE` | Wallet balance would go negative |
| 6 | `DUPLICATE_TRANSACTION` | `transactionCode` already seen |
| 7 | `INVALID_TRANSACTION` | Round was already finished |
| 400 | `BAD_REQUEST` | Missing required fields |
| 401 | `UNAUTHORIZED` | Bad Basic Auth header |
| 500 | `UNKNOWN_SERVER_ERROR` | Unexpected exception |

---

## Comparison vs Palace Casino

| Aspect | Palace Casino | OroPlay |
|---|---|---|
| Auth | Static `Bearer SLOT_API_TOKEN` | Dynamic via `createToken`, refreshed |
| Response shape | `{ code, message, data }` | `{ success, message, errorCode }` |
| User identifier | Numeric `user_code` returned by provider | String `userCode` chosen by you (= username) |
| Mapping table | `palace_user_mapping` | None — flag on users table |
| Callback URL | Single endpoint w/ `command` field | Multiple endpoints (`/balance`, `/transaction`) |
| Callback auth | `Callback-Token` header | HTTP Basic Auth |
| Callback response | `{ result, status, data }` | `{ success, message, errorCode }` |
| Idempotency key | `trans_guid` | `transactionCode` |
