import { TransactionManager } from '../infrastructure/db/transaction';
import { logger } from '../infrastructure/logger/logger';
import { OutboxRepository } from '../repositories/outbox.repository';

export class OutboxWorker {
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private isStopped = false;

  constructor(
    private readonly txManager: TransactionManager,
    private readonly outboxRepo: OutboxRepository,
    private readonly pollIntervalMs = 2_000
  ) {}

  start(): void {
    logger.info({ pollIntervalMs: this.pollIntervalMs }, 'Outbox worker started');
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.isProcessing) {
      await new Promise((r) => setTimeout(r, 100));
    }
    logger.info('Outbox worker stopped cleanly');
  }

  private async tick(): Promise<void> {
    if (this.isProcessing || this.isStopped) return;
    this.isProcessing = true;

    try {
      await this.txManager.runInTransaction(async (tx) => {
        const events = await this.outboxRepo.claimBatch(tx, 10);
        for (const event of events) {
          try {
            logger.info(
              { eventId: event.id, eventType: event.event_type, aggregateId: event.aggregate_id },
              'Dispatching outbox event'
            );
            await this.outboxRepo.markProcessed(tx, event.id);
          } catch (err) {
            logger.error({ err, eventId: event.id }, 'Failed to dispatch outbox event');
            await this.outboxRepo.markFailedOrRetry(tx, event.id, event.attempts);
          }
        }
      });
    } catch (err) {
      logger.error({ err }, 'Outbox worker tick failed');
    } finally {
      this.isProcessing = false;
    }
  }
}
