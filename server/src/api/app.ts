import express, { Express } from 'express';
import { Pool } from 'pg';
import { TransactionManager } from '../infrastructure/db/transaction';
import { KeyRepository } from '../repositories/key.repository';
import { OrderRepository } from '../repositories/order.repository';
import { OutboxRepository } from '../repositories/outbox.repository';
import { PromoRepository } from '../repositories/promo.repository';
import { WebhookRepository } from '../repositories/webhook.repository';
import { OrderService } from '../services/order.service';
import { PromoService } from '../services/promo.service';
import { StoreService } from '../services/store.service';
import { OutboxWorker } from '../workers/outbox.worker';
import { errorHandler } from './middlewares/error-handler';
import { requestIdMiddleware } from './middlewares/request-id';
import { RequestWithRawBody } from './middlewares/verify-hmac';
import { createOrderRouter } from './routes/order.routes';
import { createStoreRouter } from './routes/store.routes';
import { createWebhookRouter } from './routes/webhook.routes';

export interface AppContext {
    app: Express;
    outboxWorker: OutboxWorker;
}

export function createApp(pool: Pool): AppContext {
    const app = express();

    app.use(requestIdMiddleware);
    app.use(express.static('public'));
    app.use(
        express.json({
            verify: (req: RequestWithRawBody, _res, buf) => {
                req.rawBody = buf;
            },
        })
    );

    // Healthchecks для оркестраторов (Kubernetes / Docker)
    app.get('/health/live', (_req, res) => {
        res.status(200).json({ status: 'ok' });
    });

    app.get('/health/ready', async (_req, res) => {
        try {
            await pool.query('SELECT 1');
            res.status(200).json({ status: 'ready', db: 'connected' });
        } catch {
            res.status(503).json({ status: 'unavailable', db: 'disconnected' });
        }
    });

    // Infrastructure & Repositories
    const txManager = new TransactionManager(pool);
    const orderRepo = new OrderRepository(pool);
    const keyRepo = new KeyRepository(pool);
    const webhookRepo = new WebhookRepository();
    const promoRepo = new PromoRepository(pool);
    const outboxRepo = new OutboxRepository(pool);

    // Services & Workers
    const orderService = new OrderService(txManager, orderRepo, keyRepo, webhookRepo, outboxRepo);
    const promoService = new PromoService(promoRepo);
    const storeService = new StoreService(keyRepo, promoRepo, orderRepo, outboxRepo);
    const outboxWorker = new OutboxWorker(txManager, outboxRepo);

    // Routes
    app.use('/api/orders', createOrderRouter(orderService));
    app.use('/webhook', createWebhookRouter(orderService));
    app.use('/api', createStoreRouter(storeService, promoService, orderService));

    // Global Error Handler
    app.use(errorHandler);

    return { app, outboxWorker };
}

