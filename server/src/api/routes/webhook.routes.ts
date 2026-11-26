import { Router } from 'express';
import { z } from 'zod';
import { OrderService } from '../../services/order.service';
import { asyncHandler } from '../middlewares/async-handler';
import { verifyWebhookSignature } from '../middlewares/verify-hmac';

const webhookSchema = z.object({
    event_id: z.string().min(1).max(255),
    order_id: z.string().uuid(),
    status: z.enum(['paid', 'failed', 'pending']),
});

export function createWebhookRouter(orderService: OrderService): Router {
    const router = Router();

    router.post(
        '/payment',
        verifyWebhookSignature,
        asyncHandler(async (req, res) => {
            const { event_id, order_id, status } = webhookSchema.parse(req.body);
            const result = await orderService.processPaymentWebhook({
                eventId: event_id,
                orderId: order_id,
                status,
            });

            if (result.duplicate) {
                res.status(200).send('OK (Duplicate event)');
                return;
            }

            if (!result.delivery) {
                res.sendStatus(200);
                return;
            }

            res.status(200).json({ ok: true, status: result.delivery.status });
        })
    );

    return router;
}
