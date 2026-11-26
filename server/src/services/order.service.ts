import { DeliveryResult, Order } from '../domain/entities';
import {
    InvalidOrderStateError,
    OrderAlreadyProcessedError,
    OrderNotFoundError,
} from '../domain/errors';
import { QueryExecutor, TransactionManager } from '../infrastructure/db/transaction';
import { KeyRepository } from '../repositories/key.repository';
import { OrderRepository } from '../repositories/order.repository';
import { OutboxRepository } from '../repositories/outbox.repository';
import { WebhookRepository } from '../repositories/webhook.repository';

export class OrderService {
    constructor(
        private readonly txManager: TransactionManager,
        private readonly orderRepo: OrderRepository,
        private readonly keyRepo: KeyRepository,
        private readonly webhookRepo: WebhookRepository,
        private readonly outboxRepo: OutboxRepository
    ) { }

    async createOrder(sku: string, idempotencyKey?: string): Promise<Order> {
        return this.orderRepo.create(sku, idempotencyKey);
    }

    async getOrder(orderId: string): Promise<Order> {
        const order = await this.orderRepo.findById(orderId);
        if (!order) {
            throw new OrderNotFoundError(orderId);
        }
        return order;
    }

    async processPaymentWebhook(params: {
        eventId: string;
        orderId: string;
        status: 'paid' | 'failed' | 'pending';
    }): Promise<{ duplicate: boolean; delivery?: DeliveryResult }> {
        if (params.status !== 'paid') {
            return { duplicate: false };
        }

        return this.txManager.runInTransaction(async (tx) => {
            const isNewEvent = await this.webhookRepo.registerEvent(tx, params.eventId, params.orderId);
            if (!isNewEvent) {
                return { duplicate: true };
            }

            const order = await this.orderRepo.findByIdForUpdate(tx, params.orderId);
            if (!order) {
                throw new OrderNotFoundError(params.orderId);
            }

            if (order.status !== 'created') {
                throw new OrderAlreadyProcessedError(order.id, order.status);
            }

            await this.orderRepo.updateStatus(tx, order.id, 'paid');
            const delivery = await this.assignKeyInTx(tx, order.id, order.sku);

            return { duplicate: false, delivery };
        });
    }

    async retryDelivery(orderId: string): Promise<DeliveryResult> {
        return this.txManager.runInTransaction(async (tx) => {
            const order = await this.orderRepo.findByIdForUpdate(tx, orderId);
            if (!order) {
                throw new OrderNotFoundError(orderId);
            }

            if (order.status !== 'out_of_stock') {
                throw new InvalidOrderStateError(`Cannot retry order in status: ${order.status}`);
            }

            return this.assignKeyInTx(tx, order.id, order.sku);
        });
    }

    private async assignKeyInTx(tx: QueryExecutor, orderId: string, sku: string): Promise<DeliveryResult> {
        const secretKey = await this.keyRepo.claimAvailableKey(tx, sku, orderId);

        if (!secretKey) {
            await this.orderRepo.updateStatus(tx, orderId, 'out_of_stock');
            await this.outboxRepo.enqueue(tx, {
                aggregateType: 'order',
                aggregateId: orderId,
                eventType: 'order.out_of_stock',
                payload: { orderId, sku },
            });
            return { status: 'out_of_stock', key: null };
        }

        await this.orderRepo.updateStatus(tx, orderId, 'delivered');
        await this.outboxRepo.enqueue(tx, {
            aggregateType: 'order',
            aggregateId: orderId,
            eventType: 'order.delivered',
            payload: { orderId, sku, deliveredAt: new Date().toISOString() },
        });

        return { status: 'delivered', key: secretKey };
    }
}

