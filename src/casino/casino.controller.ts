import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CasinoService } from './casino.service';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { SlotGameCallbackDTO } from './dto/slotgamecallback.dto';
import { SportsCallbackDTO } from './dto/sportscallback.dto';
import { OroPlayBalanceDTO, OroPlayTransactionDTO, OroPlayBatchTransactionsDTO } from './dto/oroplay.dto';
import { GetMiniBalanceDTO, MiniBetWinDTO, MiniDepositDTO, MiniWithdrawDTO } from './dto/minicallback.dto';

@Controller('sports')
export class CasinoController {
  constructor(private readonly casinoService: CasinoService) {}

  @Get('live-vendors')
  async getLiveVendors() {
    return await this.casinoService.getLiveVendors();
  }

  @Get('games')
  async getCasinoGames(
    @Req() req: any,
    @Query() query: any,
    @Query('isMobile') isMobileQuery?: string,
  ) {
    const isMobile = isMobileQuery ?? (req.headers['user-agent']?.match(/Mobi|Android|iPhone/i) ? 'true' : 'false');
    const userPayload = req.user; // Might be undefined if guest, handle in service
    return await this.casinoService.getCasinoGames(query, userPayload, isMobile);
  }

  @UseGuards(JwtAuthGuard)
  @Get('auth-games')
  async getAuthGames(
    @Req() req: any,
    @Query() query: any,
    @Query('isMobile') isMobileQuery?: string,
  ) {
    const isMobile = isMobileQuery ?? (req.headers['user-agent']?.match(/Mobi|Android|iPhone/i) ? 'true' : 'false');
    const userPayload = req.user;
    return await this.casinoService.getAuthGames(query, userPayload, isMobile);
  }

  @UseGuards(JwtAuthGuard)
  @Get('games/:id')
  async getGameUrl(
    @Req() req: any,
    @Param('id') uuid: string,
    @Query() query: any,
    @Query('isMobile') isMobileQuery?: string,
  ) {
    const isMobile = isMobileQuery ?? (req.headers['user-agent']?.match(/Mobi|Android|iPhone/i) ? 'true' : 'false');
    const userPayload = req.user;
    return await this.casinoService.getGameUrl(uuid, query, userPayload, isMobile);
  }

  @UseGuards(JwtAuthGuard)
  @Get('logs')
  async getLogs(@Req() req: any, @Query() query: any) {
    const userPayload = req.user;
    return await this.casinoService.getLogs(query, userPayload);
  }

  @UseGuards(JwtAuthGuard)
  @Get('sports-link') // renamed to sports-link to avoid clash with prefix 'sports'
  async getSportsLink(
    @Req() req: any,
    @Query() query: any,
    @Query('isMobile') isMobileQuery?: string,
    @Query('language') language?: string,
  ) {
    const isMobile = isMobileQuery ?? (req.headers['user-agent']?.match(/Mobi|Android|iPhone/i) ? 'true' : 'false');
    const userPayload = req.user;
    return await this.casinoService.getSportsLink(query, userPayload, isMobile, language);
  }

  @Post('slotgameCallback')
  @HttpCode(200)
  async slotgameCallback(@Req() request: any, @Body() params: SlotGameCallbackDTO) {
    const response = await this.casinoService.consumeSlotGameCallback(
      params.command,
      params.data,
      params.timestamp,
      params.check,
      request.headers['callback-token'] as string,  
    );
    return response;
  }

  @Post('sportsCallback')
  @HttpCode(200)
  async sportsCallback(@Req() request: any, @Body() params: SportsCallbackDTO) {
    const response = await this.casinoService.consumeSportsCallback(
      params.command,
      params.data,
      params.key,
      request.headers['callback-token'] as string,  
    );
    return response;
  }

  @Post('api/balance')
  @HttpCode(200)
  async oroPlayBalance(@Req() request: any, @Body() params: OroPlayBalanceDTO) {
    const authHeader = request.headers['authorization'] as string;
    if (!this.casinoService.validateOroPlayBasicAuth(authHeader)) {
      return { success: false, message: 0, errorCode: 401 };
    }
    return await this.casinoService.handleOroPlayBalance(params.userCode);
  }

  @Post('api/transaction')
  @HttpCode(200)
  async oroPlayTransaction(@Req() request: any, @Body() params: OroPlayTransactionDTO) {
    const authHeader = request.headers['authorization'] as string;
    if (!this.casinoService.validateOroPlayBasicAuth(authHeader)) {
      return { success: false, message: 0, errorCode: 401 };
    }
    return await this.casinoService.handleOroPlayTransaction(
      params.userCode,
      params.vendorCode,
      params.gameCode,
      params.historyId,
      params.roundId,
      params.gameType,
      params.transactionCode,
      params.isFinished,
      params.isCanceled,
      params.amount,
      params.detail || '',
      params.createdAt || '',
    );
  }

  @Post('api/batch-transactions')
  @HttpCode(200)
  async oroPlayBatchTransactions(@Req() request: any, @Body() params: OroPlayBatchTransactionsDTO) {
    const authHeader = request.headers['authorization'] as string;
    if (!this.casinoService.validateOroPlayBasicAuth(authHeader)) {
      return { success: false, message: 0, errorCode: 401 };
    }
    return await this.casinoService.handleOroPlayBatchTransactions(
      params.userCode,
      params.transactions,
    );
  }

  @Post('GetBalance')
  @HttpCode(200)
  async getBalance(@Body() reqData: GetMiniBalanceDTO) {
    return await this.casinoService.consumeMiniGameCallback_GetBalance(reqData);
  }

  @Post('BetWin')
  @HttpCode(200)
  async betWin(@Body() reqData: MiniBetWinDTO) {
    return await this.casinoService.consumeMiniGameCallback_BetWin(reqData);
  }

  @Post('Withdraw')
  @HttpCode(200)
  async withdraw(@Body() reqData: MiniWithdrawDTO) {
    return await this.casinoService.consumeMiniGameCallback_Withdraw(reqData);
  }

  @Post('Deposit')
  @HttpCode(200)
  async deposit(@Body() reqData: MiniDepositDTO) {
    return await this.casinoService.consumeMiniGameCallback_Deposit(reqData);
  }

  @Post('updateSlotGames')
  async updateSlotGames() {
    return await this.casinoService.updateSlotGames();
  }

  @Post('updateLiveCasinoGames')
  async updateLiveCasinoGames() {
    return await this.casinoService.updateLiveCasinoGames();
  }
}
