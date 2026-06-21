import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AffiliateService } from './affiliate.service';

/**
 * Public, unauthenticated affiliate tracking link.
 *
 *   GET /r/:code  → records a click (best-effort) and 302-redirects the visitor
 *                   to the public site's registration landing with ?aff=<code>.
 *
 * `?aff` is the AFFILIATE attribution param (distinct from the refer-a-friend
 * `?ref`). The frontend forwards it to POST /auth/register as `aff_code`, which
 * records the downline edge in `referrals` only — the two systems stay separate.
 *
 * This is the link `AffiliateRevShareService.getMyLink` hands to affiliates, so
 * every share/click flows through here and lands in `affiliate_clicks`. The
 * redirect never waits on tracking — a logging failure must not block the user.
 */
@Controller('r')
export class AffiliatePublicController {
  constructor(private readonly affiliate: AffiliateService) {}

  @Get(':code')
  async track(
    @Param('code') code: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.affiliate.recordClick(code, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      referer: req.headers['referer'] ?? req.headers['referrer'],
      landingPath: req.originalUrl,
    });

    const base = process.env.PUBLIC_SITE_URL ?? 'https://winx-88.com';
    return res.redirect(302, `${base}/?aff=${encodeURIComponent(code ?? '')}`);
  }
}
