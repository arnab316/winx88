import {
  Controller,
  Post,
  Body,
  Param,
  HttpException,
  HttpStatus,
  ParseIntPipe,
} from '@nestjs/common';
import { GameService } from './game.service';

@Controller('games')
export class GameController {
  constructor(private readonly gameService: GameService) {}

  // 🟢 Place Bet
  @Post('bet')
  async placeBet(@Body() body: any) {
    try {
      const result = await this.gameService.placeBet(body);

      return {
        statusCode: HttpStatus.CREATED,
        message: 'Bet placed successfully',
        data: result,
      };
    } catch (error:any) {
      throw new HttpException(
        {
          statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to place bet',
        },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // 🔵 Settle Round
  @Post('settle/:round_id')
  async settleRound(
    @Param('round_id', ParseIntPipe) round_id: number,
    @Body() body: { result_number: string },
  ) {
    try {
      const result = await this.gameService.settleRound(
        round_id,
        body.result_number,
      );

      return {
        statusCode: HttpStatus.OK,
        message: 'Round settled successfully',
        data: result,
      };
    } catch (error:any) {
      throw new HttpException(
        {
          statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to settle round',
        },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // 🟢 Create Game
  @Post('create')
  async createGame(@Body() body: any) {
    try {
      const result = await this.gameService.createGame(body);

      return {
        statusCode: HttpStatus.CREATED,
        message: 'Game created successfully',
        data: result,
      };
    } catch (error:any) {
      throw new HttpException(
        {
          statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to create game',
        },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // 🟢 Create Round
  @Post('round')
  async createRound(@Body() body: any) {
    try {
      const result = await this.gameService.createRound(body);

      return {
        statusCode: HttpStatus.CREATED,
        message: 'Round created successfully',
        data: result,
      };
    } catch (error:any) {
      throw new HttpException(
        {
          statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to create round',
        },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // 🟡 Add Hot Number
  @Post('hot-number')
  async addHotNumber(@Body() body: any) {
    try {
      const result = await this.gameService.addHotNumber(body);

      return {
        statusCode: HttpStatus.CREATED,
        message: 'Hot number added successfully',
        data: result,
      };
    } catch (error:any) {
      throw new HttpException(
        {
          statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to add hot number',
        },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // 🔴 Publish Result
  @Post('result/:round_id')
  async publishResult(
    @Param('round_id', ParseIntPipe) round_id: number,
    @Body() body: { result_number: string },
  ) {
    try {
      const result = await this.gameService.publishResult(
        round_id,
        body.result_number,
      );

      return {
        statusCode: HttpStatus.OK,
        message: 'Result published successfully',
        data: result,
      };
    } catch (error:any) {
      throw new HttpException(
        {
          statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error?.message || 'Failed to publish result',
        },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}