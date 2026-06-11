import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery, ApiHeader } from '@nestjs/swagger';
import { SportsService } from './sports.service';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { SportsCallbackDTO } from './dto/sportscallback.dto';
// import { GetMiniBalanceDTO, MiniBetWinDTO, MiniDepositDTO, MiniWithdrawDTO } from './dto/minicallback.dto'; // MINI GAME — disabled

@ApiTags('sports')
@Controller('sports')
export class SportsController {
  constructor(private readonly sportsService: SportsService) {}

  @Get('live-vendors')
  @ApiOperation({ summary: 'Get list of active live casino vendors' })
  @ApiResponse({ status: 200, description: 'List of vendor names', example: ['Evolution', 'Pragmatic Play', 'Ezugi'] })
  async getLiveVendors() {
    return await this.sportsService.getLiveVendors();
  }

  @Get('games')
  @ApiOperation({ summary: 'Get list of casino/slots games with pagination and filters' })
  @ApiQuery({ name: 'isMobile', required: false, example: 'false' })
  @ApiQuery({ name: 'search', required: false, example: 'Roulette' })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of games',
    example: {
      items: [
        {
          uuid: 'bg25rouletteus',
          name: 'American Roulette',
          image: 'https://miniback.betjoyful.com/api/public/images/minigames/rouletteus.png',
          type: 'instant',
          provider: 'BGaming',
          game_symbol: 'bg25rouletteus',
          is_mobile: 1,
          is_new: false,
        },
      ],
      total: 1,
    },
  })
  async getCasinoGames(
    @Req() req: any,
    @Query() query: any,
    @Query('isMobile') isMobileQuery?: string,
  ) {
    const isMobile = isMobileQuery ?? (req.headers['user-agent']?.match(/Mobi|Android|iPhone/i) ? 'true' : 'false');
    const userPayload = req.user;
    return await this.sportsService.getCasinoGames(query, userPayload, isMobile);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('auth-games')
  @ApiOperation({ summary: 'Get games specific to authenticated user (favorites/recents)' })
  @ApiResponse({ status: 200, description: 'List of user games', example: { items: [], total: 0 } })
  async getAuthGames(
    @Req() req: any,
    @Query() query: any,
    @Query('isMobile') isMobileQuery?: string,
  ) {
    const isMobile = isMobileQuery ?? (req.headers['user-agent']?.match(/Mobi|Android|iPhone/i) ? 'true' : 'false');
    const userPayload = req.user;
    return await this.sportsService.getAuthGames(query, userPayload, isMobile);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('games/:id')
  @ApiOperation({ summary: 'Launch a game and get redirect / iframe URL' })
  @ApiQuery({ name: 'searchType', required: true, example: 'real', description: 'real or demo' })
  @ApiResponse({ status: 200, description: 'Game redirect URL', example: { url: 'https://game-launch-url-example.com/start' } })
  async getGameUrl(
    @Req() req: any,
    @Param('id') uuid: string,
    @Query() query: any,
    @Query('isMobile') isMobileQuery?: string,
  ) {
    const isMobile = isMobileQuery ?? (req.headers['user-agent']?.match(/Mobi|Android|iPhone/i) ? 'true' : 'false');
    const userPayload = req.user;
    return await this.sportsService.getGameUrl(uuid, query, userPayload, isMobile);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('logs')
  @ApiOperation({ summary: 'Get bet/transaction logs of authenticated user' })
  @ApiResponse({
    status: 200,
    description: 'Paginated logs list',
    example: {
      items: [
        {
          id: 1,
          user_id: 12,
          game_name: 'American Roulette',
          action: 'bet',
          amount: 50.00,
          created_at: '2026-06-10T16:21:00Z',
        },
      ],
      total: 1,
    },
  })
  async getLogs(@Req() req: any, @Query() query: any) {
    const userPayload = req.user;
    return await this.sportsService.getLogs(query, userPayload);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('sports-link')
  @ApiOperation({ summary: 'Get sportsbook dashboard launch link' })
  @ApiResponse({ status: 200, description: 'Sportsbook dashboard redirect link', example: 'https://sportsbook.needforspeedau.com/dashboard/start?token=xyz' })
  async getSportsLink(
    @Req() req: any,
    @Query() query: any,
    @Query('isMobile') isMobileQuery?: string,
    @Query('language') language?: string,
  ) {
    const isMobile = isMobileQuery ?? (req.headers['user-agent']?.match(/Mobi|Android|iPhone/i) ? 'true' : 'false');
    const userPayload = req.user;
    const url = await this.sportsService.getSportsLink(query, userPayload, isMobile, language);
    return { url };
  }

  @Post('sportsCallback')
  @HttpCode(200)
  @ApiOperation({ summary: 'Callback for sportsbook actions' })
  @ApiHeader({ name: 'authorization', required: false, example: 'Bearer sports-callback-token' })
  @ApiHeader({ name: 'callback-token', required: false, example: 'sports-callback-token' })
  @ApiResponse({ status: 200, description: 'Callback response', example: { code: 0, message: 'OK', data: { name: 'testuser', balance: 450.00 } } })
  async sportsCallback(@Req() request: any, @Body() params: SportsCallbackDTO) {
    // Provider sends the callback token as "Authorization: Bearer <token>".
    // Some docs also mention a "Callback-Token" header, so accept either.
    const authHeader = (request.headers['authorization'] as string) ?? '';
    const bearerToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : '';
    const callbackToken =
      bearerToken || ((request.headers['callback-token'] as string) ?? '');

    const response = await this.sportsService.consumeSportsCallback(
      params.command,
      params.data,
      params.key ?? '',
      callbackToken,
    );
    return response;
  }

  // ── MINI GAME callbacks disabled ──────────────────────────────────────────
  // @Post('GetBalance')
  // @HttpCode(200)
  // @ApiOperation({ summary: 'Mini-game callback: get balance' })
  // @ApiResponse({ status: 200, description: 'Mini-game balance response', example: { status: 'ok', data: { balance: 1000.00 } } })
  // async getBalance(@Body() reqData: GetMiniBalanceDTO) {
  //   if (!this.sportsService.validateMiniCallbackSign(reqData.sign)) {
  //     return { status: 'error', message: 'Invalid sign' };
  //   }
  //   return await this.sportsService.consumeMiniGameCallback_GetBalance(reqData);
  // }

  // @Post('BetWin')
  // @HttpCode(200)
  // @ApiOperation({ summary: 'Mini-game callback: process bet and win atomically' })
  // @ApiResponse({ status: 200, description: 'Mini-game bet/win response', example: { status: 'ok', data: { balance: 1050.00 } } })
  // async betWin(@Body() reqData: MiniBetWinDTO) {
  //   if (!this.sportsService.validateMiniCallbackSign(reqData.sign)) {
  //     return { status: 'error', message: 'Invalid sign' };
  //   }
  //   return await this.sportsService.consumeMiniGameCallback_BetWin(reqData);
  // }

  // @Post('Withdraw')
  // @HttpCode(200)
  // @ApiOperation({ summary: 'Mini-game callback: withdraw (debit) funds for bet' })
  // @ApiResponse({ status: 200, description: 'Mini-game withdraw response', example: { status: 'ok', data: { balance: 950.00 } } })
  // async withdraw(@Body() reqData: MiniWithdrawDTO) {
  //   if (!this.sportsService.validateMiniCallbackSign(reqData.sign)) {
  //     return { status: 'error', message: 'Invalid sign' };
  //   }
  //   return await this.sportsService.consumeMiniGameCallback_Withdraw(reqData);
  // }

  // @Post('Deposit')
  // @HttpCode(200)
  // @ApiOperation({ summary: 'Mini-game callback: deposit (credit) funds for win' })
  // @ApiResponse({ status: 200, description: 'Mini-game deposit response', example: { status: 'ok', data: { balance: 1075.00 } } })
  // async deposit(@Body() reqData: MiniDepositDTO) {
  //   if (!this.sportsService.validateMiniCallbackSign(reqData.sign)) {
  //     return { status: 'error', message: 'Invalid sign' };
  //   }
  //   return await this.sportsService.consumeMiniGameCallback_Deposit(reqData);
  // }
  // ── end MINI GAME ──────────────────────────────────────────────────────────

  @UseGuards(AdminGuard)
  @ApiBearerAuth()
  @Post('updateSlotGames')
  @ApiOperation({ summary: 'Sync slots catalogs from Palace Casino API' })
  @ApiResponse({ status: 200, description: 'Sync complete message', example: { msg: 'all games updated. Total: 154' } })
  async updateSlotGames() {
    return await this.sportsService.updateSlotGames();
  }

  @UseGuards(AdminGuard)
  @ApiBearerAuth()
  @Post('updateLiveCasinoGames')
  @ApiOperation({ summary: 'Sync live games catalogs from OroPlay API' })
  @ApiResponse({ status: 200, description: 'Sync complete message', example: { msg: 'all games updated. Total: 85 games from 5 vendors' } })
  async updateLiveCasinoGames() {
    return await this.sportsService.updateLiveCasinoGames();
  }
}
