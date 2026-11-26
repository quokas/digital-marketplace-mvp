import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { OrderService } from '../../services/order.service';
import { PromoService } from '../../services/promo.service';
import { StoreService } from '../../services/store.service';
import { asyncHandler } from '../middlewares/async-handler';

const refillSchema = z.object({
    sku: z.string().min(1).max(100),
    keys: z.array(z.string().min(1)).min(1),
});

const promoSchema = z.object({
    code: z.string().min(1).max(50),
});

const mockPaySchema = z.object({
    order_id: z.string().uuid(),
});

export function createStoreRouter(
    storeService: StoreService,
    promoService: PromoService,
    orderService: OrderService
): Router {
    const router = Router();

    router.get(
        '/store/state',
        asyncHandler(async (_req, res) => {
            const state = await storeService.getState();
            res.json(state);
        })
    );

    router.post(
        '/promocodes/apply',
        asyncHandler(async (req, res) => {
            const { code } = promoSchema.parse(req.body);
            const promo = await promoService.apply(code);
            res.json({ success: true, promo });
        })
    );

    router.post(
        '/admin/refill',
        asyncHandler(async (req, res) => {
            const { sku, keys } = refillSchema.parse(req.body);
            const inserted = await storeService.refillKeys(sku, keys);
            res.json({ success: true, inserted });
        })
    );

    router.post(
        '/admin/reset-promo',
        asyncHandler(async (req, res) => {
            const { code } = promoSchema.parse(req.body);
            await promoService.reset(code);
            res.json({ success: true });
        })
    );

    // Mock-шлюз доступен только вне production и вызывает сервис напрямую без лишнего HTTP-запроса
    if (env.NODE_ENV !== 'production') {
        router.post(
            '/mock-gateway/pay',
            asyncHandler(async (req, res) => {
                const { order_id } = mockPaySchema.parse(req.body);
                const result = await orderService.processPaymentWebhook({
                    eventId: `evt_ui_${crypto.randomUUID()}`,
                    orderId: order_id,
                    status: 'paid',
                });

                res.status(200).json({
                    ok: true,
                    status: result.delivery?.status ?? 'already_processed',
                });
            })
        );
    }

    return router;
}
