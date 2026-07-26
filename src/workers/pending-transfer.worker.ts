import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Transfer, TransferDocument, TransferStatus } from '../wallets/schemas/transfer.schema';
import { WalletsService } from '../wallets/wallets.service';

@Injectable()
export class PendingTransferWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingTransferWorker.name);
  private timer: NodeJS.Timeout;
  private running = false;
  private maxRetryCount: number;

  constructor(
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    private readonly configService: ConfigService,
    private readonly walletService: WalletsService,
  ) {}

  onModuleInit() {
    const intervalMs = this.configService.getOrThrow<number>(
      'workers.pendingTransferSweepIntervalMs',
    );
    this.maxRetryCount = this.configService.getOrThrow<number>(
      'workers.pendingTransferMaxRetryCount',
    );
    this.timer = setInterval(() => this.sweep(), intervalMs);
  }

  private async sweep() {
    if (this.running) return;

    this.running = true;

    try {
      const timeoutMs = this.configService.getOrThrow<number>('workers.pendingTransferTimeoutMs');
      const cutoff = new Date(Date.now() - timeoutMs);

      const stale = await this.transferModel
        .find({ status: TransferStatus.PENDING, createdAt: { $lt: cutoff } })
        .limit(50)
        .exec();

      if (stale.length > 0)
        this.logger.warn(`Found ${stale.length} transfer(s) pending past the timeout window`);

      for (const transfer of stale) {
        try {
          if ((transfer.retryCount ?? 0) >= this.maxRetryCount) {
            await this.walletService.refund(transfer.id);
            continue;
          }

          await this.walletService.retryTransfer(transfer.id);
        } catch (error) {
          this.logger.error(
            `Failed to resolve stale transfer ${transfer.id}: ${(error as Error).message}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Pending transfer sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }
}
