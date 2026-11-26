import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export interface QueryExecutor {
    query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export class TransactionManager {
    constructor(private readonly pool: Pool) { }

    async runInTransaction<T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T> {
        const client: PoolClient = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
}
