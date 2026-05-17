import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PalaceCallbackService } from './palace-callback.service';

/**
 * INBOUND: Palace Casino calls this endpoint for every game event.
 *
 * Single URL — they include `command` in the body to indicate the action:
 *   authenticate | balance | bet | win | cancel | status
 *
 * Required header: Callback-Token (must match SLOT_CALLBACK_TOKEN env var)
 *
 * Response shape Palace expects:
 *   { result: 0, status: "OK", data: { balance: 12000 } }
 *
 * Note: We always return HTTP 200. Errors go in the `result` field.
 * If we threw 401/500, Palace would retry forever.
 */
@Controller('slot/callback')
export class PalaceCallbackController {
  private readonly logger = new Logger(PalaceCallbackController.name);

  constructor(
    private readonly cb: PalaceCallbackService,
    private readonly config: ConfigService,
  ) {}
 @HttpCode(200)
  @Post()
  async handle(
    @Headers('callback-token') token: string,
    @Body() body: any,
  ) {
    // 1️⃣ Verify shared secret. Anyone hitting this without the token is rejected.
    const expected = this.config.get<string>('SLOT_CALLBACK_TOKEN');
    if (!expected || token !== expected) {
      this.logger.warn(`Rejected callback — bad token (got: ${token?.slice(0, 8)}...)`);
      return { result: 1001, status: 'Unauthorized', data: {} };
    }

    const { command, data, check } = body ?? {};
    if (!command) {
      return { result: 1, status: 'Missing command', data: {} };
    }

    this.logger.log(`Callback received: command=${command} account=${data?.account}`);

    try {
      switch (command) {
        case 'authenticate':
          return await this.cb.authenticate(data, check);
        case 'balance':
          return await this.cb.balance(data, check);
        case 'bet':
          return await this.cb.bet(data, check);
        case 'win':
          return await this.cb.win(data, check);
        case 'cancel':
          return await this.cb.cancel(data, check);
        case 'status':
          return await this.cb.status(data, check);
        default:
          return { result: 1, status: `Unknown command: ${command}`, data: {} };
      }
    } catch (err: any) {
      this.logger.error(
        `Callback error [${command}]: ${err.message}`,
        err.stack,
      );
      return {
        result: err.code ?? 1,
        status: err.message ?? 'Internal error',
        data: {},
      };
    }
  }
}
