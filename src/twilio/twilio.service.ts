import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Twilio from 'twilio';

@Injectable()
export class TwilioService {
  private client: Twilio.Twilio;
  private fromNumber: string;

  constructor(private config: ConfigService) {
    this.client = Twilio(
         this.config.get('TWILIO_ACCOUNT_SID'),    
    this.config.get('TWILIO_AUTH_TOKEN'),     
    );
  this.fromNumber = this.config.get('TWILIO_WHATSAPP_FROM')!;
  }

  async sendWhatsAppOtp(phoneNumber: string, otp: string): Promise<void> {
    await this.client.messages.create({
      from: this.fromNumber,
      to: `whatsapp:${phoneNumber}`,
      body: `*${otp}* is your winx88 verification code. For your security, do not share this code.`,
    });
  }
}