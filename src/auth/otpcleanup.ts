import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

@Injectable()
export class OtpCleanupService {
  constructor(private dataSource: DataSource) {}

  // runs every 5 minutes
  @Cron(CronExpression.EVERY_5_MINUTES)
  async cleanExpiredOtps() {
    try {
      const result = await this.dataSource.query(
        `DELETE FROM user_otps 
         WHERE expires_at < NOW() 
         AND is_used = false`
      );

      console.log('Expired UNUSED OTPs cleaned');
    } catch (error) {
      console.error('OTP cleanup failed:', error);
    }
  }
}