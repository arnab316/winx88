import { Module } from '@nestjs/common';
import { VipController } from './vip.controller';
import { VipService } from './vip.service';
import { JwtModule } from '@nestjs/jwt';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';

@Module({
   imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '15m' },
    }),
  ],
  controllers: [VipController],
  providers: [VipService, JwtAuthGuard, AdminGuard],
  exports: [VipService],
})
export class VipModule {}
