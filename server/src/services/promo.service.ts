import { Promocode } from '../domain/entities';
import { PromoUnavailableError } from '../domain/errors';
import { PromoRepository } from '../repositories/promo.repository';

export class PromoService {
  constructor(private readonly promoRepo: PromoRepository) {}

  async apply(code: string): Promise<Promocode> {
    const updated = await this.promoRepo.incrementUsageAtomic(code);
    if (!updated) {
      throw new PromoUnavailableError(code);
    }
    return updated;
  }

  async reset(code: string): Promise<void> {
    await this.promoRepo.resetUsage(code);
  }
}
