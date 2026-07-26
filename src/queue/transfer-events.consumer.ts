import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ConsumeMessage } from 'amqplib';
import { Connection, Model } from 'mongoose';
import { LedgerService } from '../ledger/ledger.service';
import {
  Transaction,
  TransactionDocument,
  TransactionStatus,
  TransactionType,
} from '../transactions/schemas/transaction.schema';
import { Transfer, TransferDocument, TransferStatus } from '../wallets/schemas/transfer.schema';
import { Wallet, WalletDocument } from '../wallets/schemas/wallet.schema';
import { RabbitMQService } from './rabbitmq.service';
import { isDuplicateKey } from '../common/helpers/db/duplicate-key-handler';

export interface TransferInitiatedEvent {
  transferId: string;
  fromWalletId: string;
  toWalletId: string;
  idempotencyKey?: string;
  amount: number;
}

@Injectable()
export class TransferEventsConsumer implements OnModuleInit {
  private readonly logger = new Logger(TransferEventsConsumer.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly rabbitMQService: RabbitMQService,
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    @InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>,
    @InjectModel(Transaction.name)
    private readonly transactionModel: Model<TransactionDocument>,
    private readonly ledgerService: LedgerService,
  ) {}

  onModuleInit() {
    const channelWrapper = this.rabbitMQService.getChannelWrapper();
    const queue = this.rabbitMQService.getTransferQueue();

    channelWrapper.addSetup((channel) =>
      channel.consume(queue, (message) => this.handleMessage(message, channel)),
    );
  }

  private async handleMessage(message: ConsumeMessage | null, channel: any) {
    if (!message) {
      return;
    }

    const routingKey = message.fields.routingKey;

    let event: TransferInitiatedEvent;
    try {
      event = JSON.parse(message.content.toString());
    } catch {
      this.logger.error(`[${routingKey}] discarding message: payload is not valid JSON`);
      channel.nack(message, false, false);
      return;
    }

    if (!this.isValidTransferEvent(event)) {
      this.logger.error(`[${routingKey}] discarding invalid event: ${JSON.stringify(event)}`);
      channel.nack(message, false, false);
      return;
    }

    this.logger.log(
      `[${routingKey}] received transfer ${event.transferId}: crediting ${event.amount} to wallet ${event.toWalletId}`,
    );

    try {
      await this.completeTransfer(event);
      channel.ack(message);
    } catch (error) {
      this.logger.error(
        `[${routingKey}] failed to settle transfer ${event.transferId}, dropping (no requeue): ${(error as Error).message}`,
      );
      channel.nack(message, false, false);
    }
  }

  private isValidTransferEvent(event: TransferInitiatedEvent) {
    return (
      !!event &&
      typeof event.transferId === 'string' &&
      typeof event.fromWalletId === 'string' &&
      typeof event.toWalletId === 'string' &&
      typeof event.amount === 'number' &&
      Number.isFinite(event.amount) &&
      event.amount > 0
    );
  }

  private async completeTransfer(event: TransferInitiatedEvent) {
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(
        async () => {
          let transfer = await this.transferModel.findById(event.transferId).session(session);
          if (!transfer) throw new Error(`Transfer ${event.transferId} not found, skipping`);

          const toWallet = await this.walletModel.findOneAndUpdate(
            { _id: event.toWalletId },
            { $inc: { balance: event.amount } },
            { new: true, session },
          );

          if (!toWallet)
            throw new Error(`Destination wallet ${event.toWalletId} not found, skipping`);

          const [creditTransaction] = await this.transactionModel.create(
            [
              {
                walletId: toWallet._id,
                type: TransactionType.TRANSFER_IN,
                amount: event.amount,
                status: TransactionStatus.COMPLETED,
                balanceAfter: toWallet.balance,
                transferId: transfer._id,
                counterpartyWalletId: transfer.fromWalletId,
                reference: `transfer-in:${event.transferId}`,
              },
            ],
            { session },
          );

          await this.ledgerService.recordCredit(
            toWallet._id,
            creditTransaction._id,
            event.amount,
            toWallet.balance,
            session,
          );

          transfer = await this.transferModel.findOneAndUpdate(
            { _id: event.transferId },
            {
              $set: { status: TransferStatus.COMPLETED },
            },
            { new: true, session },
          );

          if (!transfer) throw new Error(`Transfer ${event.transferId} not found, skipping`);
          this.logger.log(
            `Transfer ${transfer._id} settled: credited ${event.amount} to wallet ${toWallet.id} (new balance ${toWallet.balance})`,
          );
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        },
      );
    } catch (error) {
      if (isDuplicateKey(error, ['reference'])) {
        this.logger.warn(`Transfer ${event.transferId} already completed, skipping duplicate`);
        return this.transferModel.findById(event.transferId).lean();
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }
}
