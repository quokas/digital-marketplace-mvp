import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';

describe('Digital Marketplace High-Concurrency Integration Tests', () => {
    let container: StartedPostgreSqlContainer;
    let pool: Pool;
    let server: http.Server;
    let baseUrl: string;
    const webhookSecret = 'test_super_secret_key_123456';

    before(async () => {
        // 1. Поднимаем чистый PostgreSQL 16 в Docker
        container = await new PostgreSqlContainer('postgres:16-alpine').start();
        const connectionUri = container.getConnectionUri();

        // 2. Прокидываем env до импорта модулей приложения
        process.env.DATABASE_URL = connectionUri;
        process.env.WEBHOOK_SECRET = webhookSecret;
        process.env.NODE_ENV = 'test';

        pool = new Pool({ connectionString: connectionUri });

        // 3. Накатываем schema.sql
        const schemaPath = path.resolve(process.cwd(), 'schema.sql');
        const schemaSql = await fs.readFile(schemaPath, 'utf-8');
        await pool.query(schemaSql);

        // 4. Запускаем Express на случайном свободном порту (port 0)
        const { createApp } = await import('../src/api/app');
        const { app } = createApp(pool);


        await new Promise<void>((resolve) => {
            server = app.listen(0, () => {
                const addr = server.address();
                if (addr && typeof addr === 'object') {
                    baseUrl = `http://127.0.0.1:${addr.port}`;
                }
                resolve();
            });
        });
    });

    after(async () => {
        if (server) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        if (pool) await pool.end();
        if (container) await container.stop();
    });

    function signPayload(payload: object): { raw: string; signature: string } {
        const raw = JSON.stringify(payload);
        const signature = crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
        return { raw, signature };
    }

    it('1. Idempotency & Outbox: 50 duplicate webhooks deliver exactly 1 key and 1 outbox event', async () => {
        // Пополняем пул ключей
        await fetch(`${baseUrl}/api/admin/refill`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sku: 'GAME-PASS-30D',
                keys: Array.from({ length: 10 }, (_, i) => `KEY-IDEMP-${i}`),
            }),
        });

        // Создаём заказ
        const orderRes = await fetch(`${baseUrl}/api/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sku: 'GAME-PASS-30D', idempotency_key: 'idem-order-1' }),
        });
        const order = (await orderRes.json()) as { id: string };

        // Отправляем 50 идентичных вебхуков одновременно
        const { raw, signature } = signPayload({
            event_id: 'evt_duplicate_50',
            order_id: order.id,
            status: 'paid',
        });

        const responses = await Promise.all(
            Array.from({ length: 50 }, () =>
                fetch(`${baseUrl}/webhook/payment`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-signature': signature },
                    body: raw,
                })
            )
        );

        assert.equal(responses.filter((r) => r.status === 200).length, 50);

        // Проверяем, что выдан ровно 1 ключ и создана ровно 1 запись в Outbox
        const keysCount = await pool.query('SELECT COUNT(*)::int AS cnt FROM digital_keys WHERE order_id = $1', [order.id]);
        assert.equal(keysCount.rows[0].cnt, 1);

        const outboxCount = await pool.query(
            "SELECT COUNT(*)::int AS cnt FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'order.delivered'",
            [order.id]
        );
        assert.equal(outboxCount.rows[0].cnt, 1);
    });

    it('2. Fraud protection: 50 different payments for 1 order allow only 1 delivery', async () => {
        const orderRes = await fetch(`${baseUrl}/api/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sku: 'GAME-PASS-30D' }),
        });
        const order = (await orderRes.json()) as { id: string };

        const responses = await Promise.all(
            Array.from({ length: 50 }, (_, i) => {
                const { raw, signature } = signPayload({
                    event_id: `evt_fraud_${i}_${crypto.randomUUID()}`,
                    order_id: order.id,
                    status: 'paid',
                });
                return fetch(`${baseUrl}/webhook/payment`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-signature': signature },
                    body: raw,
                });
            })
        );

        const okCount = responses.filter((r) => r.status === 200).length;
        const conflictCount = responses.filter((r) => r.status === 409).length;

        assert.equal(okCount, 1);
        assert.equal(conflictCount, 49);
    });

    it('3. Promocode race condition: 50 parallel requests apply PROMO3 strictly 3 times', async () => {
        const responses = await Promise.all(
            Array.from({ length: 50 }, () =>
                fetch(`${baseUrl}/api/promocodes/apply`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: 'PROMO3' }),
                })
            )
        );

        const applied = responses.filter((r) => r.status === 200).length;
        const rejected = responses.filter((r) => r.status === 400).length;

        assert.equal(applied, 3);
        assert.equal(rejected, 47);
    });
});
