import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private readonly ttlSeconds: number;

  constructor(private readonly configService: ConfigService) {
    this.client = new Redis({
      host: this.configService.get<string>('redis.host'),
      port: this.configService.get<number>('redis.port'),
      lazyConnect: false,
    });
    this.ttlSeconds = this.configService.getOrThrow<number>('redis.ttlSeconds');

    this.client.on('error', (err) => this.logger.error(`Redis error: ${err.message}`));
  }

  private walletKey(walletId: string): string {
    return `wallet:${walletId}`;
  }

  async getCachedWallet(walletId: string): Promise<Record<string, unknown> | null> {
    const value = await this.client.get(this.walletKey(walletId));
    return value === null ? null : JSON.parse(value);
  }

  async cacheWallet(walletId: string, wallet: object): Promise<void> {
    await this.client.set(this.walletKey(walletId), JSON.stringify(wallet), 'EX', this.ttlSeconds);
  }

  async invalidateWallet(walletId: string): Promise<void> {
    await this.client.del(this.walletKey(walletId));
  }

  async invalidateWallets(...walletIds: string[]): Promise<void> {
    await Promise.all(
      walletIds.map((walletId) =>
        this.invalidateWallet(walletId).catch((error: Error) =>
          this.logger.warn(`Failed to invalidate cached wallet ${walletId}: ${error.message}`),
        ),
      ),
    );
  }

  getClient(): Redis {
    return this.client;
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
