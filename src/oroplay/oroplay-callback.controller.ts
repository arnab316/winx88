import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OroplayCallbackService } from './oroplay-callback.service';
import type {
  BalanceRequestDto,
  TransactionRequestDto,
  BatchTransactionsRequestDto,
} from './dto/callback.dto';
import { OROPLAY_ERROR } from './dto/callback.dto';

/**
 * INBOUND: OroPlay calls these endpoints during gameplay.
 *
 * Auth: Basic {base64(clientId:clientSecret)}
 *
 * Response shape OroPlay expects:
 *   { success: true, message: <balance>, errorCode: 0 }
 *
 * IMPORTANT: We always return HTTP 200. Errors go in the `errorCode` field.
 * Throwing 4xx/5xx would cause OroPlay to retry the same transaction and
 * possibly double-charge the player.
 */
@Controller('api')
export class OroplayCallbackController {
  private readonly logger = new Logger(OroplayCallbackController.name);

  constructor(
    private readonly cb: OroplayCallbackService,
    private readonly config: ConfigService,
  ) {}

  private verifyBasicAuth(authHeader?: string): boolean {
    if (!authHeader?.startsWith('Basic ')) return false;
    const clientId = this.config.get<string>('OROPLAY_CLIENT_ID');
    const clientSecret = this.config.get<string>('OROPLAY_CLIENT_SECRET');
    if (!clientId || !clientSecret) return false;

    const expected = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const provided = authHeader.slice(6).trim();

    // constant-time-ish compare
    if (provided.length !== expected.length) return false;
    let result = 0;
    for (let i = 0; i < provided.length; i++) {
      result |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return result === 0;
  }

  // ─── POST /oroplay/callback/balance ───────────────────────────────────
  @HttpCode(200)
  @Post('balance')
  async balance(
    @Headers('authorization') auth: string,
    @Body() body: BalanceRequestDto,
  ) {
    if (!this.verifyBasicAuth(auth)) {
      this.logger.warn(`Rejected balance callback — bad Basic auth`);
      return {
        success: false,
        message: 'Unauthorized',
        errorCode: OROPLAY_ERROR.UNAUTHORIZED,
      };
    }

    this.logger.log(`Callback balance: userCode=${body?.userCode}`);

    try {
      return await this.cb.getBalance(body);
    } catch (err: any) {
      this.logger.error(`Balance callback error: ${err.message}`, err.stack);
      return {
        success: false,
        message: 'Server error',
        errorCode: OROPLAY_ERROR.UNKNOWN_SERVER_ERROR,
      };
    }
  }

  // ─── POST /oroplay/callback/transaction ───────────────────────────────
  @HttpCode(200)
  @Post('transaction')
  async transaction(
    @Headers('authorization') auth: string,
    @Body() body: TransactionRequestDto,
  ) {
    if (!this.verifyBasicAuth(auth)) {
      this.logger.warn(`Rejected transaction callback — bad Basic auth`);
      return {
        success: false,
        message: 'Unauthorized',
        errorCode: OROPLAY_ERROR.UNAUTHORIZED,
      };
    }

    this.logger.log(
      `Callback transaction: user=${body?.userCode} txCode=${body?.transactionCode} amount=${body?.amount}`,
    );

    try {
      return await this.cb.handleTransaction(body);
    } catch (err: any) {
      this.logger.error(`Transaction callback error: ${err.message}`, err.stack);
      return {
        success: false,
        message: 'Server error',
        errorCode: OROPLAY_ERROR.UNKNOWN_SERVER_ERROR,
      };
    }
  }

  // ─── POST /oroplay/callbackbatch-transactions ────────────────────────
  @HttpCode(200)
  @Post('batch-transactions')
  async batchTransactions(
    @Headers('authorization') auth: string,
    @Body() body: BatchTransactionsRequestDto,
  ) {
    if (!this.verifyBasicAuth(auth)) {
      this.logger.warn(`Rejected batch callback — bad Basic auth`);
      return {
        success: false,
        message: 'Unauthorized',
        errorCode: OROPLAY_ERROR.UNAUTHORIZED,
      };
    }

    this.logger.log(
      `Callback batch: user=${body?.userCode} count=${body?.transactions?.length}`,
    );

    try {
      return await this.cb.handleBatchTransactions(body);
    } catch (err: any) {
      this.logger.error(`Batch callback error: ${err.message}`, err.stack);
      return {
        success: false,
        message: 'Server error',
        errorCode: OROPLAY_ERROR.UNKNOWN_SERVER_ERROR,
      };
    }
  }
}
