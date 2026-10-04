// src/notification/notification.relay.ts
import {
  Injectable, Logger, OnModuleInit, OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Queue, Worker, JobsOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';

import { NotificationService } from './notification.service';

export const NOTIFICATION_QUEUE = 'notifications';

/**
 * Moves committed outbox rows onto the queue, and drains the queue.
 *
 * Two halves, deliberately separate:
 *
 *   relay   polls `notification_outbox` for PENDING rows and enqueues them
 *   worker  consumes jobs and asks NotificationService to deliver
 *
 * The relay is what closes the gap the outbox exists to close. Because rows are
 * committed by the caller's transaction before this ever sees them, a crash at
 * any point after COMMIT is harmless — the row is still PENDING and gets picked
 * up on the next tick.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes it safe to run more than one instance:
 * two relays polling at once take disjoint batches instead of fighting over the
 * same rows.
 *
 * If Redis is not configured the relay degrades to delivering inline. That
 * keeps local development working without Redis, and means a Redis outage
 * slows notifications rather than losing them.
 */
@Injectable()
export class NotificationRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationRelay.name);

  private queue: Queue | null = null;
  private worker: Worker | null = null;
  // BullMQ v6 wants a real client rather than plain options. Queue and Worker
  // each get their own — a Worker blocks on its connection, so sharing one
  // would stall the Queue's commands.
  private queueConn: Redis | null = null;
  private workerConn: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /** How many outbox rows to claim per tick. */
  private static readonly BATCH = 100;
  private static readonly TICK_MS = 1000;
  private static readonly MAX_ATTEMPTS = 5;
  /** A row QUEUED longer than this is assumed orphaned and retried. */
  private static readonly STALE_QUEUED_MIN = 5;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly notifications: NotificationService,
  ) {}

  async onModuleInit() {
    const host = this.config.get<string>('REDIS_HOST');

    if (host) {
      const opts = {
        host,
        port: Number(this.config.get<string>('REDIS_PORT') ?? 6379),
        password: this.config.get<string>('REDIS_PASSWORD') || undefined,
        // BullMQ requires this — a Worker blocks on commands and must not
        // inherit the per-request retry cap ioredis defaults to.
        maxRetriesPerRequest: null,
      };

      this.queueConn = new IORedis(opts);
      this.workerConn = new IORedis(opts);

      this.queue = new Queue(NOTIFICATION_QUEUE, { connection: this.queueConn });

      this.worker = new Worker(
        NOTIFICATION_QUEUE,
        async (job) => this.handle(Number(job.data.outboxId)),
        { connection: this.workerConn, concurrency: 10 },
      );

      this.worker.on('failed', (job, err) => {
        this.logger.error(
          `job ${job?.id} outbox=${job?.data?.outboxId} failed: ${err?.message}`,
        );
      });

      this.logger.log('Notification queue online (BullMQ)');
    } else {
      this.logger.warn(
        'REDIS_HOST not set — notifications will be delivered inline, without a queue',
      );
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, NotificationRelay.TICK_MS);
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.worker?.close();
    await this.queue?.close();
    this.queueConn?.disconnect();
    this.workerConn?.disconnect();
  }

  /** Claim a batch of due rows and hand them on. */
  private async tick() {
    if (this.running) return; // never overlap ticks
    this.running = true;

    const qr = this.dataSource.createQueryRunner();
    try {
      // Rescue anything stranded in QUEUED. A row is marked QUEUED before the
      // job is accepted, so a crash — or a rejected enqueue — in that gap would
      // otherwise leave it there forever with nothing to pick it up.
      await this.dataSource.query(
        `UPDATE notification_outbox
            SET status = 'PENDING'
          WHERE status = 'QUEUED'
            AND queued_at < NOW() - make_interval(mins => $1)`,
        [NotificationRelay.STALE_QUEUED_MIN],
      );

      await qr.connect();
      await qr.startTransaction();

      // SKIP LOCKED lets several instances poll concurrently without
      // duplicating work or blocking each other.
      const rows = await qr.query(
        `SELECT id FROM notification_outbox
          WHERE status = 'PENDING' AND available_at <= NOW()
          ORDER BY available_at ASC, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [NotificationRelay.BATCH],
      );

      if (!rows.length) {
        await qr.commitTransaction();
        return;
      }

      const ids = rows.map((r: any) => Number(r.id));
      await qr.query(
        `UPDATE notification_outbox
            SET status = 'QUEUED', queued_at = NOW()
          WHERE id = ANY($1::bigint[])`,
        [ids],
      );
      await qr.commitTransaction();

      for (const id of ids) {
        try {
          if (this.queue) {
            const opts: JobsOptions = {
              // A retried enqueue for the same row collapses onto one job.
              // NOTE: BullMQ rejects ':' in a custom id — it breaks its own
              // Redis key structure — so this uses a hyphen.
              jobId: `outbox-${id}`,
              attempts: NotificationRelay.MAX_ATTEMPTS,
              backoff: { type: 'exponential', delay: 2000 },
              removeOnComplete: 1000,
              removeOnFail: 5000,
            };
            await this.queue.add('deliver', { outboxId: id }, opts);
          } else {
            // No Redis: deliver inline rather than stall.
            await this.handle(id);
          }
        } catch (e: any) {
          // The row is already QUEUED at this point. Put it back so the next
          // tick retries it — otherwise a failed enqueue strands it forever.
          this.logger.error(
            `enqueue failed for outbox ${id}: ${e?.message ?? e}`,
          );
          await this.dataSource.query(
            `UPDATE notification_outbox
                SET status = 'PENDING', last_error = $2,
                    available_at = NOW() + interval '10 seconds'
              WHERE id = $1 AND status = 'QUEUED'`,
            [id, String(e?.message ?? e).slice(0, 500)],
          );
        }
      }
    } catch (e: any) {
      this.logger.error(`relay tick failed: ${e?.message || e?.name || String(e)}`);
      try { await qr.rollbackTransaction(); } catch { /* already closed */ }
    } finally {
      this.running = false;
      await qr.release();
    }
  }

  /**
   * Deliver one outbox row and record the outcome.
   *
   * Throws on failure so BullMQ applies its backoff; the row is only returned
   * to PENDING once the attempts are exhausted, so nothing is silently dropped.
   */
  private async handle(outboxId: number) {
    try {
      const status = await this.notifications.deliver(outboxId);

      // Throw BEFORE recording, so the catch below owns the whole failure
      // path. Writing the row here as well would count the attempt twice.
      if (status === 'FAILED') {
        throw new Error(`delivery reported FAILED for outbox ${outboxId}`);
      }

      await this.dataSource.query(
        `UPDATE notification_outbox
            SET status = $2, processed_at = NOW(), attempts = attempts + 1
          WHERE id = $1`,
        [outboxId, status],
      );
    } catch (e: any) {
      const [row] = await this.dataSource.query(
        `UPDATE notification_outbox
            SET attempts = attempts + 1,
                last_error = $2,
                status = CASE
                  WHEN attempts + 1 >= $3 THEN 'FAILED'
                  ELSE 'PENDING'
                END,
                -- back off before the relay picks it up again
                available_at = NOW() + make_interval(secs => LEAST(300, POWER(2, attempts + 1)::int))
          WHERE id = $1
          RETURNING status, attempts`,
        [outboxId, String(e?.message ?? e).slice(0, 500), NotificationRelay.MAX_ATTEMPTS],
      );
      const r = Array.isArray(row) ? row[0] : row;
      this.logger.warn(
        `outbox ${outboxId} attempt ${r?.attempts} → ${r?.status}: ${e?.message}`,
      );
      throw e;
    }
  }
}
