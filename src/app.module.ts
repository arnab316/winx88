import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletModule } from './wallet/wallet.module';
import { UserModule } from './user/user.module';
import { GameModule } from './game/game.module';

@Module({
  imports: [
     ConfigModule.forRoot({ isGlobal: true }), // load .env globally
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST')!,
        port: configService.get<number>('DB_PORT')!,
        username: configService.get<string>('DB_USER')!,
        password: configService.get<string>('DB_PASS')!,
        database: configService.get<string>('DB_NAME')!,
        autoLoadEntities: true,
        synchronize: true, // dev only
      }),
    }),
    AuthModule,
    WalletModule,
    UserModule,
    GameModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
