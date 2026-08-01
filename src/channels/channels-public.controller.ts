import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ChannelsService } from './channels.service';
import { TrackClickDto } from './dto/channels.dto';

/**
 * Public, unauthenticated marketing tracking links.
 *
 *   GET  /c/:channel  → records a click and 302-redirects to the landing page
 *                       with ?channel=<code>&cid=<clickUid>
 *   POST /c/track     → beacon for the case where traffic lands on any page
 *                       with ?channel=<code> instead of going through /c/:code
 *
 * `?channel` is the MEDIA-BUYER attribution param, distinct from the affiliate
 * `?aff` and the refer-a-friend `?ref`. The frontend persists it (first touch
 * wins) and forwards it to POST /auth/register as `channel` + `cid`.
 *
 * Tracking is best-effort throughout: a logging failure must never cost a click
 * we have already paid for.
 */
@Controller('c')
export class ChannelsPublicController {
  constructor(private readonly channels: ChannelsService) {}

  @Get(':channel')
  async track(
    @Param('channel') channel: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const result = await this.channels.recordChannelClick(channel, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      referer: req.headers['referer'] ?? req.headers['referrer'],
      landingPath: req.originalUrl,
      subId: (req.query.sub ?? req.query.sub_id) as string | undefined,
      source: 'REDIRECT',
    });

    const base = (
      process.env.PUBLIC_SITE_URL ??
      process.env.APP_BASE_URL ??
      'https://winx-88.com'
    ).replace(/\/+$/, '');

    // An unrecognised code still redirects — never 404 a paid click. The click
    // is recorded as unknown and surfaces in the admin unknown-codes feed.
    const path = result.landingPath ?? '/register';
    const cid = result.clickUid ? `&cid=${encodeURIComponent(result.clickUid)}` : '';

    return res.redirect(
      302,
      `${base}${path}?channel=${encodeURIComponent(channel ?? '')}${cid}`,
    );
  }

  /**
   * Called by the frontend when it sees ?channel= on a page the visitor reached
   * without passing through /c/:code (e.g. the homepage or a promo page).
   * Returns the click id so the signup can be tied back to this click.
   */
  // Throttled per IP — this one is callable in a loop from JS. The GET redirect
  // above is deliberately NOT throttled: a 429 there would cost a click that
  // has already been paid for, and inflated clicks are better handled by
  // auditing (ip/user_agent are stored) than by dropping real visitors.
  @Post('track')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @HttpCode(200)
  async beacon(@Body() dto: TrackClickDto, @Req() req: Request) {
    const result = await this.channels.recordChannelClick(dto.channel, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      referer: dto.referer ?? req.headers['referer'] ?? req.headers['referrer'],
      landingPath: dto.landingPath,
      subId: dto.subId,
      source: 'PARAM',
    });
    return { ok: result.ok, cid: result.clickUid ?? null };
  }
}
