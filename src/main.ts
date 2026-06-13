import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import { winstonConfig } from './logger/logger.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cookieParser = require('cookie-parser');
 
async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: WinstonModule.createLogger(winstonConfig),
  });

  app.use(cookieParser());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('WinX88 API Documentation')
    .setDescription('The complete API documentation for WinX88 platform, including Sportsbook, Casino, and Mini-Games with dummy data/examples.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api-docs', app, document);

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
  const allowedOrigins = (process.env.CORS_ORIGINS ?? 'https://winx-88.com,https://www.winx-88.com,https://test.safurion.online')
    .split(',')
    .map(o => o.trim());
  console.log("origins", allowedOrigins);
  app.enableCors({
    // origin: true, // allow all origins temporarily
    origin: (origin, callback) => {

  if (!origin || allowedOrigins.includes(origin)) {
    return callback(null, true);
  }

  console.log('BLOCKED ORIGIN =>', origin);
  return callback(new Error(`CORS blocked: ${origin}`), false);
},

    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'Origin',
      'X-Requested-With',
      'x-device-fingerprint'
    ],
  });

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();