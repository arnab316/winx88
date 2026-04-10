import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Twilio from 'twilio';

@Controller('twilio')
export class TwilioController {
  constructor(private configService: ConfigService) {}

  @Get('test-twilio')
  async testTwilio() {
    const client = Twilio(
      this.configService.get<string>('TWILIO_ACCOUNT_SID'),
      this.configService.get<string>('TWILIO_AUTH_TOKEN'),
    );

    const message = await client.messages.create({
      body: 'Hello from NestJS 🚀',
      from: this.configService.get<string>('TWILIO_PHONE_NUMBER'),
      to: '+91XXXXXXXXXX', // your number
    });

    return {
      success: true,
      sid: message.sid,
    };
  }
}