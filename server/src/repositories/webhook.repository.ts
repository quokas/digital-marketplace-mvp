import { QueryExecutor } from '../infrastructure/db/transaction';

export class WebhookRepository {
    /** Возвращает true, если событие новое; false — если дубль */
    async registerEvent(tx: QueryExecutor, eventId: string, orderId: string): Promise<boolean> {
        const res = await tx.query(
            `INSERT INTO processed_webhooks (event_id, order_id)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
            [eventId, orderId]
        );
        return (res.rowCount ?? 0) > 0;
    }
}
