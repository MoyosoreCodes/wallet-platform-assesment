import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, ClientSession } from 'mongoose';
import { LedgerEntry, LedgerEntryDocument } from '../ledger/schemas/ledger-entry.schema';
import { LedgerService } from '../ledger/ledger.service';
import { OutboxService } from '../outbox/outbox.service';
import { RabbitMQService } from '../queue/rabbitmq.service';
import { RedisService } from '../redis/redis.service';
import { TransactionsService } from '../transactions/transactions.service';
import {
  Transaction,
  TransactionDocument,
  TransactionStatus,
  TransactionType,
} from '../transactions/schemas/transaction.schema';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { DepositDto } from './dto/deposit.dto';
import { TransferDto } from './dto/transfer.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { Transfer, TransferDocument, TransferStatus } from './schemas/transfer.schema';
import { Wallet, WalletDocument } from './schemas/wallet.schema';
import { isDuplicateKey } from '../common/helpers/db/duplicate-key-handler';

@Injectable()
export class WalletsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>,
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    @InjectModel(Transaction.name) private readonly transactionModel: Model<TransactionDocument>,
    @InjectModel(LedgerEntry.name) private readonly ledgerEntryModel: Model<LedgerEntryDocument>,
    private readonly transactionsService: TransactionsService,
    private readonly ledgerService: LedgerService,
    private readonly outboxService: OutboxService,
    private readonly rabbitMQService: RabbitMQService,
    private readonly redisService: RedisService,
  ) {}

  async createWallet(dto: CreateWalletDto) {
    const session = await this.connection.startSession();
    let wallet!: WalletDocument;

    try {
      await session.withTransaction(async () => {
        [wallet] = await this.walletModel.create(
          [
            {
              userId: dto.userId,
              ownerName: dto.ownerName,
              currency: dto.currency ?? 'GHS',
              balance: 0,
            },
          ],
          { session },
        );

        await this.outboxService.enqueue(
          'wallet.created',
          {
            walletId: wallet._id.toString(),
            userId: wallet.userId,
            currency: wallet.currency,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    return wallet;
  }

  async getWallet(id: string) {
    const wallet = await this.walletModel.findById(id);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${id} not found`);
    }

    const cachedBalance = await this.redisService.getCachedBalance(id);
    if (cachedBalance !== null) {
      return { ...wallet.toObject(), balance: cachedBalance };
    }

    await this.redisService.setCachedBalance(id, wallet.balance);
    return wallet;
  }

  async deposit(id: string, dto: DepositDto, session?: ClientSession) {
    const externalSession = Boolean(session);

    if (!session || (session !== undefined && !session.inTransaction()))
      session = await this.connection.startSession();

    if (dto.reference) {
      const existingTransaction = await this.transactionsService.findByReference(dto.reference);
      if (existingTransaction && existingTransaction.status == TransactionStatus.COMPLETED)
        return this.walletModel.findById(id);
    }

    let wallet;

    try {
      await session.withTransaction(
        async () => {
          wallet = await this.walletModel.findOneAndUpdate(
            { _id: id, currency: dto.currency },
            { $inc: { balance: dto.amount } },
            { new: true, session },
          );

          if (!wallet) throw new NotFoundException(`Wallet ${id} not found`);

          const transaction = await this.transactionsService.create(
            {
              walletId: wallet.id,
              type: TransactionType.DEPOSIT,
              amount: dto.amount,
              balanceAfter: wallet.balance,
              reference: dto.reference,
            },
            session,
          );

          await this.ledgerService.recordCredit(
            wallet._id,
            transaction._id,
            dto.amount,
            wallet.balance,
            session,
          );
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        },
      );
    } catch (error) {
      if (dto.reference && isDuplicateKey(error, ['reference']))
        return this.walletModel.findById(id);
      throw error;
    } finally {
      if (!externalSession) await session.endSession();
    }

    return wallet;
  }

  async withdraw(id: string, dto: WithdrawDto, session?: ClientSession) {
    const externalSession = Boolean(session);

    if (!session || (session !== undefined && !session.inTransaction()))
      session = await this.connection.startSession();

    if (dto.reference) {
      const existingTransaction = await this.transactionsService.findByReference(dto.reference);
      if (existingTransaction && existingTransaction.status == TransactionStatus.COMPLETED)
        return this.walletModel.findById(id);
    }

    let wallet;

    try {
      await session.withTransaction(
        async () => {
          wallet = await this.walletModel.findOneAndUpdate(
            { _id: id, currency: dto.currency, balance: { $gte: dto.amount } },
            { $inc: { balance: -dto.amount } },
            { new: true, session },
          );

          if (!wallet)
            throw new NotFoundException(`Wallet ${id} not found or insufficient balance`);

          const transaction = await this.transactionsService.create(
            {
              walletId: wallet.id,
              type: TransactionType.WITHDRAWAL,
              amount: dto.amount,
              balanceAfter: wallet.balance,
              reference: dto.reference,
            },
            session,
          );

          await this.ledgerService.recordDebit(
            wallet._id,
            transaction._id,
            dto.amount,
            wallet.balance,
            session,
          );
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        },
      );
    } catch (error) {
      if (dto.reference && isDuplicateKey(error, ['reference']))
        return this.walletModel.findById(id);
      throw error;
    } finally {
      if (!externalSession) await session.endSession();
    }

    return wallet;
  }

  async transfer(dto: TransferDto) {
    if (dto.fromWalletId === dto.toWalletId)
      throw new BadRequestException('Cannot transfer to the same wallet');

    if (dto.idempotencyKey) {
      // ? handle failed transfers
      const existingTransfer = await this.transferModel
        .findOne({
          idempotencyKey: dto.idempotencyKey,
          // status: {
          //   $in: [TransferStatus.PENDING, TransferStatus.COMPLETED],
          // },
        })
        .lean();

      if (existingTransfer) return existingTransfer;
    }

    const session = await this.connection.startSession();
    let transfer!: TransferDocument;

    try {
      await session.withTransaction(
        async () => {
          const toWallet = await this.walletModel.findById(dto.toWalletId).session(session);
          if (!toWallet) throw new NotFoundException('Destination wallet not found');

          const fromWallet = await this.walletModel.findById(dto.fromWalletId).session(session);
          if (!fromWallet) throw new NotFoundException('Source wallet not found');

          if (fromWallet.currency.trim().toLowerCase() != toWallet.currency.trim().toLowerCase())
            throw new BadRequestException('Cannot transfer to wallets with different currencies');

          [transfer] = await this.transferModel.create(
            [
              {
                fromWalletId: dto.fromWalletId,
                toWalletId: dto.toWalletId,
                amount: dto.amount,
                status: TransferStatus.PENDING,
                idempotencyKey: dto.idempotencyKey,
              },
            ],
            { session },
          );

          const from = await this.walletModel.findOneAndUpdate(
            { _id: dto.fromWalletId, balance: { $gte: dto.amount } },
            { $inc: { balance: -dto.amount } },
            { new: true, session },
          );

          if (!from)
            throw new NotFoundException(
              `Source wallet ${dto.fromWalletId} not found or insufficient balance`,
            );

          const [debitTransaction] = await this.transactionModel.create(
            [
              {
                walletId: from._id,
                type: TransactionType.TRANSFER_OUT,
                amount: dto.amount,
                status: TransactionStatus.COMPLETED,
                balanceAfter: from.balance,
                transferId: transfer._id,
                counterpartyWalletId: dto.toWalletId,
                reference: `transfer-out:${transfer._id.toString()}`,
              },
            ],
            { session },
          );

          await this.ledgerService.recordDebit(
            from._id,
            debitTransaction._id,
            dto.amount,
            from.balance,
            session,
          );

          // replaced with outbox
          // await this.rabbitMQService.publish('transfer.initiated', {
          //   transferId: transfer._id.toString(),
          //   fromWalletId: from._id.toString(),
          //   toWalletId: dto.toWalletId,
          //   amount: dto.amount,
          // });
          await this.outboxService.enqueue(
            'transfer.initiated',
            {
              transferId: transfer._id.toString(),
              fromWalletId: from._id.toString(),
              toWalletId: dto.toWalletId,
              amount: dto.amount,
              idempotencyKey: dto.idempotencyKey,
            },
            session,
          );
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        },
      );
    } catch (error) {
      if (
        dto.idempotencyKey &&
        (isDuplicateKey(error, ['idempotencyKey']) || isDuplicateKey(error, ['reference']))
      )
        return this.transferModel
          .findOne({
            idempotencyKey: dto.idempotencyKey,
          })
          .lean();

      throw error;
    } finally {
      await session.endSession();
    }

    return transfer;
  }

  async getDashboard(id: string) {
    const wallet = await this.walletModel.findById(id);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${id} not found`);
    }

    const transactions = await this.transactionModel
      .find({ walletId: id })
      .sort({ createdAt: -1 })
      .exec();

    let totalDeposited = 0;
    let totalWithdrawn = 0;
    const recentActivity: Array<{
      transaction: TransactionDocument;
      entries: LedgerEntryDocument[];
    }> = [];

    for (const txn of transactions) {
      const entries = await this.ledgerEntryModel.find({ transactionId: txn._id }).exec();

      if (txn.type === TransactionType.DEPOSIT || txn.type === TransactionType.TRANSFER_IN) {
        totalDeposited += txn.amount;
      } else {
        totalWithdrawn += txn.amount;
      }

      recentActivity.push({ transaction: txn, entries });
    }

    return {
      wallet,
      totalDeposited,
      totalWithdrawn,
      transactionCount: transactions.length,
      recentActivity: recentActivity.slice(0, 10),
    };
  }
}
