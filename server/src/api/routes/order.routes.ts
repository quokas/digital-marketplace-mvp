import { Router } from 'express';
import { z } from 'zod';
import { OrderService } from '../../services/order.service';
import { asyncHandler } from '../middlewares/async-handler';

const createOrderSchema = z.object({
    sku: z.string().min(1).max(100),
    idempotency_key: z.string().min(1).max(255).optional(),
});

const uuidSchema = z.string().uuid();

export function createOrderRouter(orderService: OrderService): Router {
    const router = Router();

    router.post(
        '/',
        asyncHandler(async (req, res) => {
            const { sku, idempotency_key } = createOrderSchema.parse(req.body);
            const order = await orderService.createOrder(sku, idempotency_key);
            res.status(201).json(order);
        })
    );

    router.get(
        '/:id',
        asyncHandler(async (req, res) => {
            const id = uuidSchema.parse(req.params.id);
            const order = await orderService.getOrder(id);
            res.json(order);
        })
    );

    router.post(
        '/:id/retry',
        asyncHandler(async (req, res) => {
            const id = uuidSchema.parse(req.params.id);
            const delivery = await orderService.retryDelivery(id);
            res.json(delivery);
        })
    );

    return router;
}
