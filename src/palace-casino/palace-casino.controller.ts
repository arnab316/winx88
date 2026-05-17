import {
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { PalaceCasinoClient } from './palace-casino.client';
import {
  LaunchGameDto,
  GameListDto,
  TransferDto,
} from './dto/outbound.dto';

/**
 * Frontend-facing endpoints. Your mobile / web app hits these — they
 * translate to Palace API calls and handle the user_code mapping.
 *
 * All routes require JWT auth (the user must be logged in to your platform).
 */
@Controller('slot')
export class PalaceCasinoController {
  private readonly logger = new Logger(PalaceCasinoController.name);

  constructor(
    private readonly palace: PalaceCasinoClient,
    private readonly dataSource: DataSource,

  ) { }

  // ─── Game catalog ──────────────────────────────────────────────────────
  @Get('providers')
  async providers(@Query('lang') lang?: string) {
    try {
      const list = await this.palace.providerList(lang ? Number(lang) : 1);
      this.logger.log(`Fetched ${list} providers from Palace`);
      return list;
    } catch (err: any) {
      this.logger.error(`Error fetching providers: ${JSON.stringify(err)}`);
      throw err;
    }
  }

  @Post('games')
  async games(@Body() body: GameListDto) {
    return this.palace.gameList(body.provider_id, body.lang ?? 1);
  }

  // ─── Launch game ───────────────────────────────────────────────────────
  /**
   * 1. Look up (or create) the player's user_code on Palace
   * 2. Generate the game URL
   * 3. Return URL to frontend, which loads it in an iframe / webview
   */
  @UseGuards(JwtAuthGuard)
  @Post('launch')
  async launch(@Req() req: any, @Body() body: LaunchGameDto) {
    console.log('Launch body received:', body);
    const userId = req.user.sub;
    const palaceUserCode = await this.ensurePalaceUser(userId);

    const result = await this.palace.generateGameUrl({
      user_code: palaceUserCode,
      provider_id: body.provider_id,
      game_symbol: body.game_symbol,
      return_url: body.return_url,
      lang: body.lang ?? 1,
      win_ratio: body.win_ratio ?? 0,
    });

    return {
      status: 'success',
      code: 200,
      data: { game_url: result.data.game_url },
    };
  }

  // ─── Wallet operations (only used in Transfer mode) ────────────────────
  /**
   * Move funds FROM player's main wallet INTO Palace.
   * Use this when player wants to "load" their slots wallet before playing.
   *
   * If you use Seamless / Callback mode (the default Palace integration),
   * you don't need this — bet/win callbacks handle the wallet directly.
   */
  @UseGuards(JwtAuthGuard)
  @Post('wallet/deposit')
  async depositToPalace(@Req() req: any, @Body() body: TransferDto) {
    const userId = req.user.sub;
    const palaceUserCode = await this.ensurePalaceUser(userId);

    const q = this.dataSource.createQueryRunner();
    try {
      await q.connect();
      await q.startTransaction();

      // Lock & check our wallet
      const wallet = await q.query(
        `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      if (!wallet.length || Number(wallet[0].balance) < body.amount) {
        await q.rollbackTransaction();
        return { status: 'error', code: 400, message: 'Insufficient balance' };
      }

      // Debit our wallet first
      await q.query(
        `UPDATE wallets SET balance = balance - $1 WHERE user_id = $2`,
        [body.amount, userId],
      );

      // Push to Palace
      const result = await this.palace.deposit(palaceUserCode, body.amount);

      await q.commitTransaction();
      return { status: 'success', code: 200, data: result.data };
    } catch (err: any) {
      await q.rollbackTransaction();
      this.logger.error(`Deposit to Palace failed: ${err.message}`);
      throw err;
    } finally {
      await q.release();
    }
  }

  /** Pull all funds from Palace back to player's main wallet. */
  @UseGuards(JwtAuthGuard)
  @Post('wallet/withdraw-all')
  async withdrawAllFromPalace(@Req() req: any) {
    const userId = req.user.sub;
    const palaceUserCode = await this.ensurePalaceUser(userId);

    const result: any = await this.palace.withdrawAll(palaceUserCode);
    const withdrawnAmount = Number(result?.data?.amount ?? 0);

    if (withdrawnAmount > 0) {
      await this.dataSource.query(
        `UPDATE wallets SET balance = balance + $1 WHERE user_id = $2`,
        [withdrawnAmount, userId],
      );
    }

    return { status: 'success', code: 200, data: result.data };
  }
 
  // ─── Transaction history ───────────────────────────────────────────────
  @Get('transactions')
  @UseGuards(JwtAuthGuard)
  async transactions(@Req() req: any) {
    const userId = req.user.sub;
    const rows = await this.dataSource.query(
      `SELECT trans_guid, round_id, game_code, type, amount, balance_after,
              is_cancelled, created_at
       FROM slot_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [userId],
    );
    return { status: 'success', code: 200, data: rows };
  }

  // ─── Internal helpers ──────────────────────────────────────────────────
  /**
   * Returns Palace's user_code for this user. Creates the mapping on
   * first call (and creates the user on Palace's side).
   */
  private async ensurePalaceUser(userId: number): Promise<number> {
    const mapping = await this.dataSource.query(
      `SELECT palace_user_code FROM palace_user_mapping WHERE user_id = $1`,
      [userId],
    );
    if (mapping.length) return Number(mapping[0].palace_user_code);

    const user = await this.dataSource.query(
      `SELECT username FROM users WHERE id = $1`,
      [userId],
    );
    if (!user.length) throw new Error('User not found');

    const created = await this.palace.createUser(user[0].username);
    const palaceCode = created.data.user_code;

    await this.dataSource.query(
      `INSERT INTO palace_user_mapping (user_id, palace_user_code) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, palaceCode],
    );
    return palaceCode;
  }
}
