import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [UserController],
  providers: [UserService, JwtAuthGuard],
  exports: [JwtAuthGuard],

})
export class UserModule {}
