import { StoreState } from '../domain/entities';
import { KeyRepository } from '../repositories/key.repository';
import { OrderRepository } from '../repositories/order.repository';
import { OutboxRepository } from '../repositories/outbox.repository';
import { PromoRepository } from '../repositories/promo.repository';

export class StoreService {
    constructor(
        private readonly keyRepo: KeyRepository,
        private readonly promoRepo: PromoRepository,
        private readonly orderRepo: OrderRepository,
        private readonly outboxRepo: OutboxRepository
    ) { }

    async refillKeys(sku: string, keys: string[]): Promise<number> {
        return this.keyRepo.bulkInsert(sku, keys);
    }

    async getState(): Promise<StoreState> {
        const [stock, promocodes, orders, outbox] = await Promise.all([
            this.keyRepo.getAvailableStock(),
            this.promoRepo.findAll(),
            this.orderRepo.findRecent(10),
            this.outboxRepo.findRecent(5),
        ]);
        return { stock, promocodes, orders, outbox };
    }
}
