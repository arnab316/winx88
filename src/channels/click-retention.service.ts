import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

/**
 * PII retention for marketing click logs.
 *
 * `marketing_clicks.ip` and `.user_agent` are personal data. They are kept
 * short-term for exactly one reason: so inflated or fraudulent click volume
 * from a media buyer can be audited after the fact. Past that window they are
 * pure liability and grow without bound.
 *
 * This scrubs those two columns on rows older than the retention window while
 * KEEPING the rows themselves — the click counts a vendor was invoiced on must
 * never change retroactively. Only the identifying fields are nulled.
 *
 * The vendor API never exposes these columns at any age; this is about what we
 * store, not what we serve.
 *
 * Window is configurable via MARKETING_CLICK_PII_DAYS (default 90).
 */
@Injectable()
export class ClickRetentionService {
  private readonly logger = new Logger(ClickRetentionService.name);

  constructor(private readonly dataSource: DataSource) {}

  private get retentionDays(): number {
    const raw = Number(process.env.MARKETING_CLICK_PII_DAYS);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 90;
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async scrubOldClickPii(): Promise<void> {
    const days = this.retentionDays;
    try {
      // UPDATE ... RETURNING in TypeORM yields [rows, affectedCount]; take the
      // count defensively since the shape differs from a plain SELECT.
      const res = await this.dataSource.query(
        // fbclid / fbc / fbp identify a person to Meta just as an IP does, so
        // they fall under the same retention rule. Meta's match window is 7
        // days — well inside this — so nothing usable is lost.
        `UPDATE marketing_clicks
            SET ip = NULL, user_agent = NULL,
                fbclid = NULL, fbc = NULL, fbp = NULL
          WHERE created_at < NOW() - ($1 || ' days')::interval
            AND (ip IS NOT NULL OR user_agent IS NOT NULL
                 OR fbclid IS NOT NULL OR fbc IS NOT NULL OR fbp IS NOT NULL)`,
        [String(days)],
      );
      const scrubbed = Array.isArray(res) ? (res[1] ?? 0) : 0;
      if (scrubbed) {
        this.logger.log(
          `Scrubbed IP/user-agent from ${scrubbed} marketing click(s) older than ${days} days`,
        );
      }
    } catch (e: any) {
      // Never let a retention sweep take the app down; it retries tomorrow.
      this.logger.error(`Marketing click PII scrub failed: ${e?.message}`);
    }
  }
}
