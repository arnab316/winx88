import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import { winstonConfig } from './logger/logger.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cookieParser = require('cookie-parser');
 
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: WinstonModule.createLogger(winstonConfig),
  });

  // Behind a reverse proxy (nginx) / Docker / Cloudflare, the TCP peer is the
  // proxy (127.0.0.1, 172.17.0.1), not the visitor. Trusting the proxy makes
  // Express derive req.ip from the X-Forwarded-For chain (the real client IP).
  // `true` trusts all hops — fine when the app is only reachable via the proxy.
  // If the origin is also directly reachable, scope this to the proxy subnet
  // instead so clients can't spoof X-Forwarded-For.
  app.set('trust proxy', true);

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
  const allowedOrigins = (process.env.CORS_ORIGINS ?? 'https://winx-88.com,https://www.winx-88.com,https://test.safurion.online', 'https://winx88.net')
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