import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import { winstonConfig } from './logger/logger.module';
 
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cookieParser = require('cookie-parser');

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: WinstonModule.createLogger(winstonConfig),
  });

  app.use(cookieParser());

app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,                          // strip unknown props
      forbidNonWhitelisted: false,
      transform: true,                          // turn plain objects into DTO instances
      transformOptions: {
        enableImplicitConversion: true,         // ← THE KEY ONE for query coercion
      },
    }),
  );
 app.enableCors({
  origin: [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:4173',
    'http://15.207.97.72:5173',
    'http://15.207.97.72:4173',
    'https://winx-88.com',
    'https://www.winx-88.com',
    'https://test.safurion.online',
    'https://winx-88.pages.dev'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  credentials: true,
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Accept',
    'Origin',
    'X-Requested-With',
  ],
});

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();