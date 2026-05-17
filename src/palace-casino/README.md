# Palace Casino Integration

Drop-in NestJS module for integrating Palace Casino's slot game API.

## What's in the box

```
palace-casino/
├── palace-casino.module.ts        ← Wire this into AppModule
├── palace-casino.client.ts        ← OUTBOUND: HTTP client calling Palace
├── palace-casino.controller.ts    ← Frontend-facing endpoints (JWT-protected)
├── callback.controller.ts         ← INBOUND: receives Palace callbacks
├── palace-callback.service.ts     ← Wallet logic (bet/win/cancel/etc.)
├── dto/
│   ├── outbound.dto.ts
│   └── callback.dto.ts
└── migrations/
    └── 001_palace_casino.sql      ← Run this on your DB first
```

---

## Installation (5 steps)

### 1. Copy the folder into your project
```
cp -r palace-casino/  ~/your-project/src/
```

### 2. Install dependencies
```bash
npm install @nestjs/axios axios
```

### 3. Run the migration
```bash
psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f src/palace-casino/migrations/001_palace_casino.sql
```

### 4. Add env vars to `.env`
```env
# OUTBOUND — you call Palace
SLOT_API_ENDPOINT=https://api.palacecasino.com
SLOT_API_TOKEN=ask-palace-for-this-bearer-token

# INBOUND — Palace calls you
SLOT_CALLBACK_TOKEN=any-long-random-string-share-with-palace
```

### 5. Register the module in `src/app.module.ts`
```typescript
import { PalaceCasinoModule } from './palace-casino/palace-casino.module';

@Module({
  imports: [
    // ... your existing modules
    AuthModule,            // ← must be BEFORE PalaceCasinoModule
    PalaceCasinoModule,
  ],
})
export class AppModule {}
```

---

## Endpoints exposed

### Frontend → Your backend (JWT required)

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/slot/providers` | — | List slot providers (Pragmatic Play, CQ9, ...) |
| POST | `/slot/games` | `{ provider_id }` | List games for a provider |
| POST | `/slot/launch` | `{ provider_id, game_symbol, return_url }` | Get iframe URL for game |
| POST | `/slot/wallet/deposit` | `{ amount }` | Transfer-mode: load funds to slot wallet |
| POST | `/slot/wallet/withdraw-all` | — | Transfer-mode: pull all funds back |
| GET | `/slot/transactions` | — | Player's slot history (last 100) |

### Palace → Your backend (Callback-Token required)

| Method | Path | command values |
|---|---|---|
| POST | `/slot/callback` | `authenticate`, `balance`, `bet`, `win`, `cancel`, `status` |

---

## How it works (game launch flow)

```
1. Player taps "Play Sweet Bonanza" in your app
   ↓
2. App → POST /slot/launch { provider_id:1, game_symbol:"vs20fruitsw", return_url:"..." }
   ↓
3. Your backend:
   - Looks up palace_user_code (creates one on first play)
   - Calls Palace /v4/game/game-url
   - Returns the game URL
   ↓
4. App loads game URL in WebView/iframe
   ↓
5. Player spins. Palace's game server:
   - POSTs to your /slot/callback with command=bet
   - Your backend deducts from wallet, returns new balance
   - If player wins, POSTs command=win
   - Your backend credits wallet, returns new balance
```

---

## Critical things to get right

1. **Callback-Token verification** — already enforced in `callback.controller.ts`.
2. **Idempotency** — every callback handler checks `trans_guid` before applying changes. Palace WILL retry on timeout.
3. **Row locks** — bet/win uses `SELECT ... FOR UPDATE` on `wallets` to prevent race conditions.
4. **Always return HTTP 200** — even on errors. Use the `result` field to signal errors. If you 500, Palace retries forever.
5. **Reply in <3 seconds** — Palace times out after a few seconds.
6. **Public HTTPS** — localhost won't work. For testing use `ngrok http 4000`.

---

## Open questions to ask Palace before going live

1. **Withdraw URL** — their Postman shows `POST /v4/wallet/deposit` for both deposit AND withdraw. Confirm the real withdraw path. (We assume `/v4/wallet/withdraw` in `palace-casino.client.ts:withdraw()`.)
2. **Full result code table** — they reference codes 0, 1, 1001 but don't publish the full list.
3. **Bonus call config endpoint** — they have a typo `/call_cionfig`. Confirm correct path.
4. **`type` field enum** — we know `1=bet, 2=win, 16=cancel`. Get the rest.
5. **`account` field semantics** — we assume it equals your `users.username`. Confirm.
6. **Callback URL registration** — give them: `https://your-domain.com/slot/callback`

---

## Testing locally with ngrok

```bash
# Terminal 1 — run your backend
npm run start:dev

# Terminal 2 — expose to internet
ngrok http 4000
# copy the https URL: https://abc123.ngrok.io

# Give Palace: https://abc123.ngrok.io/slot/callback
```

Then send a test callback yourself:
```bash
curl -X POST https://abc123.ngrok.io/slot/callback \
  -H "Callback-Token: $SLOT_CALLBACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "command": "balance",
    "data": { "account": "your-test-username" },
    "timestamp": "1700000000",
    "check": "21,22"
  }'
```

Expected response:
```json
{ "result": 0, "status": "OK", "data": { "balance": 0 } }
```
