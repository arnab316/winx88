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
      // Facebook appends fbclid to the ad's destination URL. Captured here so
      // the server-side conversion sent at deposit approval — days later, with
      // no browser involved — can still be matched to the ad that produced it.
      fbclid: req.query.fbclid as string | undefined,
    });

    // Stay on the domain the click arrived on. The brand runs on several
    // (winx-88.com, winx88.net, …) and a campaign's creatives are approved
    // against one of them — bouncing a winx88.net visitor to winx-88.com is a
    // cross-domain redirect the ad reviewer never saw, and it drops the
    // first-party cookies (_fbp/_fbc) the landing pixel depends on.
    //
    // Falls back to the configured site only when the host is unreadable.
    const forwardedHost = String(req.headers['x-forwarded-host'] ?? '')
      .split(',')[0]
      .trim();
    const host = forwardedHost || req.headers.host;
    const proto =
      String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() ||
      req.protocol ||
      'https';

    const base = host
      ? `${proto}://${host}`
      : (
          process.env.PUBLIC_SITE_URL ??
          process.env.APP_BASE_URL ??
          'https://winx-88.com'
        ).replace(/\/+$/, '');

    // An unrecognised code still redirects — never 404 a paid click. The click
    // is recorded as unknown and surfaces in the admin unknown-codes feed.
    const path = result.landingPath ?? '/register';

    // Carry the INCOMING query string through to the landing page before adding
    // our own params.
    //
    // Ad platforms attach their own click identifier to the destination URL —
    // Facebook `fbclid`, Google `gclid`, TikTok `ttclid` — and the pixel on the
    // landing page needs it to tie that pageview back to the ad. Building a
    // fresh query string here silently dropped them, which breaks the
    // advertiser's conversion attribution and, later, any server-side
    // Conversions API match. Ours are set last so a caller cannot spoof them.
    const out = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      if (k === 'channel' || k === 'cid') continue; // ours win, see below
      if (Array.isArray(v)) v.forEach((x) => out.append(k, String(x)));
      else if (v != null) out.append(k, String(v));
    }
    out.set('channel', channel ?? '');
    if (result.clickUid) out.set('cid', result.clickUid);
    // The campaign's bound pixel, for the frontend to fire ALONGSIDE ours.
    // Absent when the channel has no pixel configured.
    if (result.pixelId) out.set('pixel', result.pixelId);

    return res.redirect(302, `${base}${path}?${out.toString()}`);
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
      fbclid: dto.fbclid,
      // The browser's own _fbp cookie, if the pixel has already set one. Meta
      // matches noticeably better with it than on fbclid alone.
      fbp: dto.fbp,
    });
    return {
      ok: result.ok,
      cid: result.clickUid ?? null,
      pixel: result.pixelId ?? null,
    };
  }
}
