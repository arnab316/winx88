import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { TurnoverService } from '../turnover/turnover.service';
import { WalletGateway } from '../wallet/wallet.gateway';

/**
 * NEXUS GGR seamless-wallet callbacks (POST /gold_api).
 *
 * Nexus holds no player money. Every bet and win is this HTTP call, moving real
 * funds and answering with the resulting balance. Two rules follow from that,
 * and both are load-bearing:
 *
 *  1. ALWAYS reply HTTP 200 with the outcome in the body. A 4xx/5xx makes Nexus
 *     treat the call as failed and retry — after we have already taken the
 *     money. Errors are `{ status: 0, msg }`, never thrown.
 *
 *  2. A REPLAYED txn_id must return the ORIGINAL balance with status 1, not an
 *     error. Providers retry on timeout, and the retry has to look identical to
 *     the first call or their ledger and ours diverge. (The OroPlay handler
 *     returns an error here; Palace gets it right. We follow Palace.)
 *
 * The unique index — not the pre-SELECT — is what actually prevents a double
 * debit: two concurrent retries both pass the SELECT, and only the constraint
 * stops the second write.
 *
 * That key is (txn_id, txn_type), NOT txn_id alone. Nexus reuses the coupon id
 * as txn_id and sends the bet as txn_type 'debit' and the settlement later as
 * 'credit' with the SAME id, so a txn_id-only key silently swallows every
 * sportsbook win as a replay.
 */

/** Error strings Nexus documents / expects back. */
const ERR = {
  INTERNAL: 'INTERNAL_ERROR',
  INVALID_AGENT: 'INVALID_AGENT',
  INVALID_USER: 'INVALID_USER',
  INSUFFICIENT: 'INSUFFICIENT_USER_FUNDS',
  INVALID_REQUEST: 'INVALID_REQUEST',
} as const;

/**
 * The buckets Nexus keys its nested transaction object by.
 *
 * Taken from their live provider_list, not the docs — the documentation only
 * shows slot/live/SB/MN, but the account also carries FH (fish hunter,
 * FISHHUNTER). Omitting it would reject every fish-game bet with
 * INVALID_REQUEST, and the player simply could not play.
 */
const GAME_TYPES = ['slot', 'live', 'SB', 'MN', 'FH'] as const;
type GameType = (typeof GAME_TYPES)[number];

export interface NexusReply {
  status: 0 | 1;
  user_balance?: number;
  msg?: string;
}

@Injectable()
export class NexusCallbackService {
  private readonly logger = new Logger(NexusCallbackService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly turnoverService: TurnoverService,
    private readonly walletGateway: WalletGateway,
  ) {}

  private agentCode(): string {
    return this.config.get<string>('NEXUS_AGENT_CODE') ?? '';
  }
  private agentSecret(): string {
    return this.config.get<string>('NEXUS_AGENT_SECRET') ?? '';
  }

  /** Never let a shared secret reach the logs. */
  private mask(v?: string): string {
    const s = String(v ?? '');
    return s.length <= 8 ? '***' : `${s.slice(0, 4)}…${s.slice(-4)}`;
  }

  /**
   * Nexus sends the shared secret in the JSON BODY rather than a header, so
   * this is checked here rather than in a guard. Compared with a length-safe
   * constant-time-ish equality; these are short fixed strings, so the practical
   * risk is low, but there is no reason to leak timing either.
   */
  private authOk(body: any): boolean {
    const code = String(body?.agent_code ?? '');
    const secret = String(body?.agent_secret ?? '');
    const expectedCode = this.agentCode();
    const expectedSecret = this.agentSecret();
    if (!expectedCode || !expectedSecret) {
      this.logger.error('NEXUS_AGENT_CODE / NEXUS_AGENT_SECRET not configured');
      return false;
    }
    return code === expectedCode && secret === expectedSecret;
  }

  /**
   * One-line identity for a callback, repeated on the `→` and `←` lines so a
   * request and its reply can be grepped together out of a busy pm2 log.
   */
  private tag(body: any): string {
    const method = String(body?.method ?? '-');
    const gameType = String(body?.game_type ?? '');
    const g = gameType ? body?.[gameType] : undefined;
    const parts = [
      `method=${method}`,
      `user=${body?.user_code ?? '-'}`,
      gameType ? `type=${gameType}` : null,
      g?.provider_code ? `provider=${g.provider_code}` : null,
      g?.txn_type ? `txn_type=${g.txn_type}` : null,
      g?.txn_id ? `txn=${g.txn_id}` : null,
      g?.round_id ? `round=${g.round_id}` : null,
      g?.bet_money != null ? `bet=${g.bet_money}` : null,
      g?.win_money != null ? `win=${g.win_money}` : null,
    ].filter(Boolean);
    return parts.join(' ');
  }

  /** Body dump for the log, minus the shared secret, capped so one giant SB payload can't flood the file. */
  private safeBody(body: any): string {
    try {
      const { agent_secret, agent_code, ...rest } = body ?? {};
      const s = JSON.stringify(rest);
      return s.length > 4000 ? `${s.slice(0, 4000)}…[truncated ${s.length} chars]` : s;
    } catch {
      return '[unserialisable body]';
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ENTRY POINT — /gold_api dispatches on `method`
  //
  // Wraps the dispatch in a request/reply trace. Every hit produces a `→` line
  // and a matching `→`/`←` pair, because the failure mode we cannot otherwise
  // see is the one where the player gets "An error occurred" in the sportsbook
  // UI: that is Nexus reacting to a `status: 0` we sent, and without the `←`
  // line there is no record of which msg went back — or whether Nexus reached
  // us at all.
  //
  // Set NEXUS_LOG_BODY=1 to also dump the full payload (secrets stripped).
  // Leave it off in steady state; SB payloads are large.
  // ═════════════════════════════════════════════════════════════
  async handle(body: any, sourceIp?: string): Promise<NexusReply> {
    const startedAt = Date.now();
    const tag = this.tag(body);

    this.logger.log(`[Nexus] → ${tag} ip=${sourceIp ?? '-'}`);
    if (String(process.env.NEXUS_LOG_BODY ?? '') === '1') {
      this.logger.log(`[Nexus] → body ${this.safeBody(body)}`);
    }

    const reply = await this.dispatch(body, sourceIp);

    const ms = Date.now() - startedAt;
    if (reply.status === 1) {
      this.logger.log(`[Nexus] ← OK ${tag} balance=${reply.user_balance ?? '-'} ${ms}ms`);
    } else {
      // WARN, not debug: this is the line that explains a failed bet.
      this.logger.warn(`[Nexus] ← FAIL ${tag} msg="${reply.msg ?? '-'}" ${ms}ms`);
    }
    return reply;
  }

  private async dispatch(body: any, sourceIp?: string): Promise<NexusReply> {
    try {
      if (!this.authOk(body)) {
        // Logged with the source IP: this endpoint is unauthenticated at the
        // HTTP layer and moves real money, so failed auth attempts are the
        // first signal that someone has found it.
        this.logger.warn(
          `[Nexus] rejected: bad agent credentials from ip=${sourceIp ?? '-'} ` +
            `(code=${this.mask(body?.agent_code)} secret=${this.mask(body?.agent_secret)})`,
        );
        return { status: 0, msg: ERR.INVALID_AGENT };
      }

      switch (String(body?.method ?? '')) {
        case 'user_balance':
          return await this.userBalance(body);
        case 'transaction':
          return await this.transaction(body);
        default:
          this.logger.warn(`[Nexus] unknown method "${body?.method}"`);
          return { status: 0, msg: ERR.INVALID_REQUEST };
      }
    } catch (e: any) {
      // Nothing may escape: an exception would become a 500 and trigger a retry
      // of a transaction we may already have applied.
      this.logger.error(`[Nexus] unhandled: ${e?.message}`, e?.stack);
      return { status: 0, msg: ERR.INTERNAL };
    }
  }

  // ═════════════════════════════════════════════════════════════
  // user_balance
  // ═════════════════════════════════════════════════════════════
  private async userBalance(body: any): Promise<NexusReply> {
    const userCode = String(body?.user_code ?? '').trim();
    if (!userCode) {
      this.logger.warn('[Nexus] user_balance: body carried no user_code');
      return { status: 0, msg: ERR.INVALID_USER };
    }

    const rows = await this.dataSource.query(
      `SELECT w.balance
         FROM users u JOIN wallets w ON w.user_id = u.id
        WHERE u.username = $1
        LIMIT 1`,
      [userCode],
    );
    if (!rows.length) {
      this.logger.warn(`[Nexus] user_balance: unknown user_code "${userCode}"`);
      return { status: 0, user_balance: 0, msg: ERR.INVALID_USER };
    }
    return { status: 1, user_balance: this.money(rows[0].balance) };
  }

  /** Two decimals, and never a float artefact like 99.99999999999999. */
  private money(v: any): number {
    return Math.round(parseFloat(String(v ?? 0)) * 100) / 100;
  }

  // ═════════════════════════════════════════════════════════════
  // transaction
  // ═════════════════════════════════════════════════════════════
  private async transaction(body: any): Promise<NexusReply> {
    const userCode = String(body?.user_code ?? '').trim();
    const gameType = String(body?.game_type ?? '') as GameType;

    if (!userCode) {
      this.logger.warn('[Nexus] transaction: body carried no user_code');
      return { status: 0, msg: ERR.INVALID_USER };
    }
    if (!GAME_TYPES.includes(gameType)) {
      // Every new Nexus product lands here first — the fix is to add the key to
      // GAME_TYPES, so log the value we actually received.
      this.logger.warn(
        `[Nexus] unsupported game_type "${gameType}" (known: ${GAME_TYPES.join('|')})`,
      );
      return { status: 0, msg: ERR.INVALID_REQUEST };
    }

    // The bet lives under a key NAMED BY game_type — "slot", "live", "SB", "MN".
    const g = body?.[gameType];
    if (!g || typeof g !== 'object') {
      this.logger.warn(`[Nexus] game_type="${gameType}" but no matching object in body`);
      return { status: 0, msg: ERR.INVALID_REQUEST };
    }

    const txnId = String(g.txn_id ?? '').trim();
    // Nexus reuses the COUPON id as txn_id and separates the legs with
    // txn_type ('debit' = bet, 'credit' = settlement). The dedup key is the
    // PAIR — on txn_id alone every settlement looks like a replay of its own
    // bet and the player is never paid. Normalised to match the unique index
    // uq_nexus_txn_id_kind, which is on lower(COALESCE(txn_type,'')).
    const txnKind = String(g.txn_type ?? '').trim().toLowerCase();
    if (!txnId) {
      this.logger.warn(
        `[Nexus] transaction: ${gameType} object has no txn_id — ${this.safeBody(body)}`,
      );
      return { status: 0, msg: ERR.INVALID_REQUEST };
    }

    const bet = this.money(g.bet_money);
    const win = this.money(g.win_money);
    // Signed net movement. debit_credit carries both legs in one call, so the
    // wallet moves once by the difference rather than twice.
    const amount = Math.round((win - bet) * 100) / 100;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      // ── Replay? Answer with the balance we recorded the first time. ──
      const prior = await qr.query(
        `SELECT balance_after FROM nexus_transactions
          WHERE txn_id = $1 AND lower(COALESCE(txn_type, '')) = $2
          LIMIT 1`,
        [txnId, txnKind],
      );
      if (prior.length) {
        await qr.rollbackTransaction();
        this.logger.log(
          `[Nexus] duplicate txn_id=${txnId} kind=${txnKind || '-'} — replaying stored balance`,
        );
        return { status: 1, user_balance: this.money(prior[0].balance_after) };
      }

      // ── Lock the wallet BEFORE reading it. Without the lock two concurrent
      //    bets both read the old balance and the second write erases the first.
      const userRows = await qr.query(
        `SELECT u.id AS user_id, w.balance
           FROM users u JOIN wallets w ON w.user_id = u.id
          WHERE u.username = $1
          FOR UPDATE OF w`,
        [userCode],
      );
      if (!userRows.length) {
        await qr.rollbackTransaction();
        this.logger.warn(`[Nexus] transaction: unknown user_code "${userCode}"`);
        return { status: 0, msg: ERR.INVALID_USER };
      }

      const userId = Number(userRows[0].user_id);
      const before = this.money(userRows[0].balance);
      const after = Math.round((before + amount) * 100) / 100;

      if (after < 0) {
        await qr.rollbackTransaction();
        this.logger.warn(
          `[Nexus] insufficient funds user=${userCode} balance=${before} needs=${-amount}`,
        );
        return { status: 0, user_balance: before, msg: ERR.INSUFFICIENT };
      }

      await qr.query(`UPDATE wallets SET balance = $1, updated_at = NOW() WHERE user_id = $2`, [
        after,
        userId,
      ]);

      let rowId: number;
      try {
        const inserted = await qr.query(
          `INSERT INTO nexus_transactions
             (txn_id, round_id, user_id, user_code, game_type, provider_code, game_code,
              type, txn_type, bet_money, win_money, amount,
              balance_before, balance_after, raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING id`,
          [
            txnId,
            g.round_id != null ? String(g.round_id) : null,
            userId,
            userCode,
            gameType,
            g.provider_code ?? null,
            g.game_code ?? null,
            g.type ?? null,
            g.txn_type ?? null,
            bet,
            win,
            amount,
            before,
            after,
            JSON.stringify(g),
          ],
        );
        rowId = Number(inserted[0].id);
      } catch (e: any) {
        // 23505 = the unique index fired, i.e. a concurrent retry inserted the
        // same txn_id between our SELECT and this INSERT. The other request
        // owns the money movement; roll ours back and echo its balance.
        if (e?.code === '23505') {
          await qr.rollbackTransaction();
          const [row] = await this.dataSource.query(
            `SELECT balance_after FROM nexus_transactions
              WHERE txn_id = $1 AND lower(COALESCE(txn_type, '')) = $2
              LIMIT 1`,
            [txnId, txnKind],
          );
          this.logger.log(
            `[Nexus] race on txn_id=${txnId} kind=${txnKind || '-'} — returning winner's balance`,
          );
          return { status: 1, user_balance: this.money(row?.balance_after ?? before) };
        }
        throw e;
      }

      // Cash-history entry, so Nexus play shows alongside every other provider.
      const userData = { user_id: userId, username: userCode };
      if (bet > 0) {
        await qr.query(
          `INSERT INTO user_cash_logs
             (user_id, user_data, amount, before_balance, after_balance, t_type, type)
           VALUES ($1,$2,$3,$4,$5,'Casino','CasinoBet')`,
          [userId, JSON.stringify(userData), bet, before, after],
        );
      }
      if (win > 0) {
        await qr.query(
          `INSERT INTO user_cash_logs
             (user_id, user_data, amount, before_balance, after_balance, t_type, type)
           VALUES ($1,$2,$3,$4,$5,'Casino','CasinoWin')`,
          [userId, JSON.stringify(userData), win, before, after],
        );
      }

      // Turnover counts the STAKE only — a payout never contributes. Runs in
      // this transaction so it is atomic with the wallet move, and no-ops when
      // the player has no active requirement.
      if (bet > 0) {
        await this.turnoverService.contributeFromSettledBet(qr, userId, rowId, bet);
      }

      await qr.commitTransaction();

      // After commit, and never allowed to fail the call.
      this.walletGateway
        .pushBalanceUpdate(userId)
        .catch((e) => this.logger.warn(`[Nexus] WS push failed user=${userId}: ${e?.message}`));

      // `nexus_transactions.id` is on the line so a pm2 entry can be taken
      // straight to the stored row (and its `raw` payload) when a bet is disputed.
      this.logger.log(
        `[Nexus] WROTE nexus_transactions#${rowId} ${gameType}/${g.provider_code ?? '-'} ` +
          `${g.txn_type ?? '-'} user=${userCode} bet=${bet} win=${win} ` +
          `${before} → ${after} txn=${txnId} round=${g.round_id ?? '-'}`,
      );
      return { status: 1, user_balance: after };
    } catch (e: any) {
      await qr.rollbackTransaction().catch(() => undefined);
      this.logger.error(`[Nexus] transaction failed txn=${txnId}: ${e?.message}`, e?.stack);
      return { status: 0, msg: ERR.INTERNAL };
    } finally {
      await qr.release();
    }
  }
}
