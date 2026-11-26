import { Order, OrderStatus } from '../domain/entities';
import { IdempotencyConflictError } from '../domain/errors';
import { QueryExecutor } from '../infrastructure/db/transaction';

export class OrderRepository {
    constructor(private readonly defaultExecutor: QueryExecutor) { }

    async create(sku: string, idempotencyKey?: string): Promise<Order> {
        if (!idempotencyKey) {
            const res = await this.defaultExecutor.query<Order>(
                `INSERT INTO orders (sku) VALUES ($1) RETURNING id, sku, status, created_at AS "createdAt"`,
                [sku]
            );
            const created = res.rows[0];
            if (!created) throw new Error('Failed to create order');
            return created;
        }

        const insertRes = await this.defaultExecutor.query<Order>(
            `INSERT INTO orders (sku, idempotency_key)
       VALUES ($1, $2)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, sku, status, created_at AS "createdAt"`,
            [sku, idempotencyKey]
        );

        if (insertRes.rows[0]) {
            return insertRes.rows[0];
        }

        const existingRes = await this.defaultExecutor.query<Order>(
            `SELECT id, sku, status, created_at AS "createdAt" FROM orders WHERE idempotency_key = $1`,
            [idempotencyKey]
        );

        const existing = existingRes.rows[0];
        if (!existing) {
            throw new Error('Idempotent order not found after conflict');
        }

        if (existing.sku !== sku) {
            throw new IdempotencyConflictError();
        }

        return existing;
    }

    async findById(id: string): Promise<Order | null> {
        const res = await this.defaultExecutor.query<Order>(
            `SELECT o.id, o.sku, o.status, o.created_at AS "createdAt", dk.secret_key AS key
       FROM orders o
       LEFT JOIN digital_keys dk ON dk.order_id = o.id
       WHERE o.id = $1`,
            [id]
        );
        return res.rows[0] ?? null;
    }

    async findByIdForUpdate(tx: QueryExecutor, id: string): Promise<Order | null> {
        const res = await tx.query<Order>(
            `SELECT id, sku, status, created_at AS "createdAt" FROM orders WHERE id = $1 FOR UPDATE`,
            [id]
        );
        return res.rows[0] ?? null;
    }

    async updateStatus(tx: QueryExecutor, id: string, status: OrderStatus): Promise<void> {
        await tx.query(
            `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
            [status, id]
        );
    }

    async findRecent(limit = 10): Promise<Order[]> {
        const res = await this.defaultExecutor.query<Order>(
            `SELECT o.id, o.sku, o.status, o.created_at AS "createdAt", dk.secret_key AS key
       FROM orders o
       LEFT JOIN digital_keys dk ON dk.order_id = o.id
       ORDER BY o.created_at DESC
       LIMIT $1`,
            [limit]
        );
        return res.rows;
    }
}
