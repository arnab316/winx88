import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NexusCallbackService, NexusReply } from './nexus-callback.service';

/**
 * Nexus GGR seamless wallet endpoint.
 *
 *   POST /gold_api
 *
 * There is no global route prefix (main.ts never calls setGlobalPrefix), so
 * this resolves at the site root exactly as Nexus requires.
 *
 * NO GUARD, by protocol: Nexus authenticates with agent_code / agent_secret
 * inside the JSON body, which the service validates. A guard would have to
 * reach into the body to do the same job.
 *
 * ALWAYS HTTP 200. Success and failure both live in the response body. Any
 * non-2xx makes Nexus mark the call failed and retry — potentially after we
 * have already moved the money — so the service is written never to throw.
 */
@Controller('gold_api')
export class NexusCallbackController {
  constructor(private readonly nexus: NexusCallbackService) {}

  /**
   * `@Body() body: any` is deliberate. The global ValidationPipe runs with
   * `whitelist: true`, which strips any property not declared on a DTO — and
   * Nexus nests the bet under a key NAMED BY game_type ("slot" | "live" | "SB"
   * | "MN"). A typed DTO would silently discard it and we would process an
   * empty transaction. AuthController takes its body the same way.
   */
  @Post()
  @HttpCode(200)
  async handle(@Body() body: any, @Req() req: Request): Promise<NexusReply> {
    return this.nexus.handle(body, req.ip);
  }
}
