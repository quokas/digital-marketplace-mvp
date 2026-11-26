import { QueryExecutor } from '../infrastructure/db/transaction';

export interface OutboxEvent {
    id: string;
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    attempts: number;
}

export interface OutboxSummary {
    id: string;
    event_type: string;
    aggregate_id: string;
    status: 'pending' | 'processed' | 'failed';
    attempts: number;
    created_at: Date;
}

export class OutboxRepository {
    constructor(private readonly defaultExecutor: QueryExecutor) { }

    async enqueue(
        tx: QueryExecutor,
        params: {
            aggregateType: string;
            aggregateId: string;
            eventType: string;
            payload: Record<string, unknown>;
        }
    ): Promise<void> {
        await tx.query(
            `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
            [params.aggregateType, params.aggregateId, params.eventType, JSON.stringify(params.payload)]
        );
    }

    async claimBatch(tx: QueryExecutor, batchSize = 10): Promise<OutboxEvent[]> {
        const res = await tx.query<OutboxEvent>(
            `SELECT id, aggregate_type, aggregate_id, event_type, payload, attempts
       FROM outbox_events
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
            [batchSize]
        );
        return res.rows;
    }

    async markProcessed(tx: QueryExecutor, id: string): Promise<void> {
        await tx.query(
            `UPDATE outbox_events
       SET status = 'processed', processed_at = NOW()
       WHERE id = $1`,
            [id]
        );
    }

    async markFailedOrRetry(tx: QueryExecutor, id: string, attempts: number, maxAttempts = 5): Promise<void> {
        const nextStatus = attempts + 1 >= maxAttempts ? 'failed' : 'pending';
        await tx.query(
            `UPDATE outbox_events
       SET attempts = attempts + 1, status = $1
       WHERE id = $2`,
            [nextStatus, id]
        );
    }

    async findRecent(limit = 5): Promise<OutboxSummary[]> {
        const res = await this.defaultExecutor.query<OutboxSummary>(
            `SELECT id, event_type, aggregate_id, status, attempts, created_at
       FROM outbox_events
       ORDER BY created_at DESC
       LIMIT $1`,
            [limit]
        );
        return res.rows;
    }
}
