import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { LedgerService } from '../ledger/ledger.service';
import { LedgerEntry } from '../ledger/schemas/ledger-entry.schema';
import { OutboxService } from '../outbox/outbox.service';
import { RabbitMQService } from '../queue/rabbitmq.service';
import { RedisService } from '../redis/redis.service';
import { Transaction, TransactionStatus, TransactionType } from '../transactions/schemas/transaction.schema';
import { TransactionsService } from '../transactions/transactions.service';
import { Transfer, TransferStatus } from './schemas/transfer.schema';
import { Wallet } from './schemas/wallet.schema';
import { WalletsService } from './wallets.service';

describe('WalletsService', () => {
  let service: WalletsService;
  let walletModel: any;
  let transferModel: any;
  let transactionModel: any;
  let ledgerEntryModel: any;
  let transactionsService: any;
  let ledgerService: any;
  let outboxService: any;
  let rabbitMQService: any;
  let redisService: any;

  const mockSession = {
    withTransaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
    endSession: jest.fn(),
    abortTransaction: jest.fn(),
  };

  beforeEach(async () => {
    walletModel = {
      create: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };
    transferModel = {
      create: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };
    transactionModel = {
      create: jest.fn(),
      find: jest.fn(),
    };
    ledgerEntryModel = {
      find: jest.fn(),
    };
    transactionsService = { create: jest.fn(), findByReference: jest.fn() };
    ledgerService = { recordCredit: jest.fn(), recordDebit: jest.fn() };
    outboxService = { enqueue: jest.fn() };
    rabbitMQService = { publish: jest.fn() };
    redisService = {
      getCachedWallet: jest.fn(),
      cacheWallet: jest.fn(),
      invalidateWallets: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletsService,
        {
          provide: getConnectionToken(),
          useValue: { startSession: jest.fn().mockResolvedValue(mockSession) },
        },
        { provide: getModelToken(Wallet.name), useValue: walletModel },
        { provide: getModelToken(Transfer.name), useValue: transferModel },
        { provide: getModelToken(Transaction.name), useValue: transactionModel },
        { provide: getModelToken(LedgerEntry.name), useValue: ledgerEntryModel },
        { provide: TransactionsService, useValue: transactionsService },
        { provide: LedgerService, useValue: ledgerService },
        { provide: OutboxService, useValue: outboxService },
        { provide: RabbitMQService, useValue: rabbitMQService },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get(WalletsService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createWallet', () => {
    it('creates a wallet with a zero opening balance and enqueues a wallet.created event', async () => {
      const created = {
        _id: new Types.ObjectId(),
        userId: 'user-1',
        ownerName: 'Ama Owusu',
        balance: 0,
      };
      walletModel.create.mockResolvedValue([created]);

      const result = await service.createWallet({ userId: 'user-1', ownerName: 'Ama Owusu' });

      expect(walletModel.create).toHaveBeenCalledWith(
        [expect.objectContaining({ userId: 'user-1', balance: 0 })],
        expect.objectContaining({ session: mockSession }),
      );
      expect(outboxService.enqueue).toHaveBeenCalledWith(
        'wallet.created',
        expect.objectContaining({ walletId: created._id.toString() }),
        mockSession,
      );
      expect(result).toBe(created);
    });
  });

  describe('getWallet', () => {
    it('caches the wallet from Mongo on a cache miss', async () => {
      const plain = { id: 'w1', _id: 'w1', balance: 250 };
      const wallet = { ...plain, toObject: () => plain };
      redisService.getCachedWallet.mockResolvedValue(null);
      walletModel.findById.mockResolvedValue(wallet);

      const result = await service.getWallet('w1');

      expect(redisService.cacheWallet).toHaveBeenCalledWith('w1', plain);
      expect(result).toBe(plain);
    });

    it('returns the cached wallet without hitting Mongo on a cache hit', async () => {
      const cached = { id: 'w1', _id: 'w1', balance: 250 };
      redisService.getCachedWallet.mockResolvedValue(cached);

      const result = await service.getWallet('w1');

      expect(walletModel.findById).not.toHaveBeenCalled();
      expect(redisService.cacheWallet).not.toHaveBeenCalled();
      expect(result).toBe(cached);
    });

    it('throws NotFoundException when the wallet does not exist', async () => {
      redisService.getCachedWallet.mockResolvedValue(null);
      walletModel.findById.mockResolvedValue(null);

      await expect(service.getWallet('missing-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('deposit', () => {
    it('increments the balance atomically and records a ledger credit', async () => {
      const walletId = new Types.ObjectId().toString();
      const updatedWallet = { id: walletId, _id: walletId, balance: 150 };
      walletModel.findOneAndUpdate.mockResolvedValue(updatedWallet);
      const transaction = { _id: new Types.ObjectId() };
      transactionsService.create.mockResolvedValue(transaction);
      const depositDto = { amount: 50, currency: 'GHS' };

      const result = await service.deposit(walletId, depositDto);

      expect(walletModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: walletId, currency: depositDto.currency }),
        { $inc: { balance: depositDto.amount } },
        { new: true, session: mockSession },
      );

      expect(transactionsService.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: TransactionType.DEPOSIT, amount: depositDto.amount }),
        mockSession,
      );

      expect(ledgerService.recordCredit).toHaveBeenCalledWith(
        updatedWallet._id,
        transaction._id,
        depositDto.amount,
        updatedWallet.balance,
        mockSession,
      );
      expect(result).toBe(updatedWallet);
      expect(redisService.invalidateWallets).toHaveBeenCalledWith(walletId);
    });

    it('throws NotFoundException when the wallet does not exist', async () => {
      walletModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(service.deposit('missing-id', { amount: 10, currency: 'GHS' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the original wallet when retried with a duplicate reference', async () => {
      const walletId = new Types.ObjectId().toString();
      const existingWallet = { id: walletId, _id: walletId, balance: 150 };
      walletModel.findOneAndUpdate.mockResolvedValue({ id: walletId, _id: walletId, balance: 200 });
      transactionsService.create.mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key'), {
          code: 11000,
          keyPattern: { reference: 1 },
        }),
      );
      walletModel.findById.mockResolvedValue(existingWallet);

      const result = await service.deposit(walletId, {
        amount: 50,
        currency: 'GHS',
        reference: 'dup-ref',
      });

      expect(walletModel.findById).toHaveBeenCalledWith(walletId);
      expect(result).toBe(existingWallet);
      expect(redisService.invalidateWallets).not.toHaveBeenCalled();
    });

    it('re-throws a non-duplicate error instead of swallowing it', async () => {
      const walletId = new Types.ObjectId().toString();
      walletModel.findOneAndUpdate.mockResolvedValue({ id: walletId, _id: walletId, balance: 200 });
      transactionsService.create.mockRejectedValue(new Error('unexpected write failure'));

      await expect(
        service.deposit(walletId, { amount: 50, currency: 'GHS', reference: 'ref-1' }),
      ).rejects.toThrow('unexpected write failure');
      expect(walletModel.findById).not.toHaveBeenCalled();
    });

    it('returns the existing wallet without re-applying when a completed transaction exists for the reference', async () => {
      const walletId = new Types.ObjectId().toString();
      const existingWallet = { id: walletId, _id: walletId, balance: 150 };
      transactionsService.findByReference.mockResolvedValue({ status: TransactionStatus.COMPLETED });
      walletModel.findById.mockResolvedValue(existingWallet);

      const result = await service.deposit(walletId, {
        amount: 50,
        currency: 'GHS',
        reference: 'seen-ref',
      });

      expect(walletModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(transactionsService.create).not.toHaveBeenCalled();
      expect(result).toBe(existingWallet);
    });

    it('does not short-circuit when the existing transaction for the reference is not completed', async () => {
      const walletId = new Types.ObjectId().toString();
      const updatedWallet = { id: walletId, _id: walletId, balance: 150 };
      transactionsService.findByReference.mockResolvedValue({ status: TransactionStatus.PENDING });
      walletModel.findOneAndUpdate.mockResolvedValue(updatedWallet);
      transactionsService.create.mockResolvedValue({ _id: new Types.ObjectId() });

      const result = await service.deposit(walletId, {
        amount: 50,
        currency: 'GHS',
        reference: 'pending-ref',
      });

      expect(walletModel.findOneAndUpdate).toHaveBeenCalled();
      expect(result).toBe(updatedWallet);
    });
  });

  describe('withdraw', () => {
    it('debits the wallet when the balance is sufficient', async () => {
      const walletId = new Types.ObjectId().toString();
      const updatedWallet = { id: walletId, _id: walletId, balance: 60 };
      walletModel.findOneAndUpdate.mockResolvedValue(updatedWallet);
      const transaction = { _id: new Types.ObjectId() };
      transactionsService.create.mockResolvedValue(transaction);
      const withdrawDto = { amount: 40, currency: 'GHS' };

      const result = await service.withdraw(walletId, withdrawDto);

      expect(walletModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: walletId,
          currency: withdrawDto.currency,
          balance: { $gte: withdrawDto.amount },
        }),
        { $inc: { balance: -withdrawDto.amount } },
        { new: true, session: mockSession },
      );

      expect(transactionsService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: TransactionType.WITHDRAWAL,
          amount: withdrawDto.amount,
          balanceAfter: updatedWallet.balance,
        }),
        mockSession,
      );

      expect(ledgerService.recordDebit).toHaveBeenCalledWith(
        updatedWallet._id,
        transaction._id,
        withdrawDto.amount,
        updatedWallet.balance,
        mockSession,
      );
      expect(result).toBe(updatedWallet);
      expect(redisService.invalidateWallets).toHaveBeenCalledWith(walletId);
    });

    it('rejects a withdrawal larger than the current balance', async () => {
      walletModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(service.withdraw('w1', { amount: 40, currency: 'GHS' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a withdrawal from a missing or underfunded wallet with a bad request', async () => {
      walletModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(service.withdraw('missing-id', { amount: 10, currency: 'GHS' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('records the debit only once when the same withdrawal is retried with the same reference', async () => {
      const walletId = new Types.ObjectId().toString();
      const debitedWallet = { id: walletId, _id: walletId, balance: 60 };
      walletModel.findOneAndUpdate.mockResolvedValue(debitedWallet);
      transactionsService.create
        .mockResolvedValueOnce({ _id: new Types.ObjectId() })
        .mockRejectedValueOnce(
          Object.assign(new Error('E11000 duplicate key'), {
            code: 11000,
            keyPattern: { reference: 1 },
          }),
        );
      walletModel.findById.mockResolvedValue(debitedWallet);

      const dto = { amount: 40, currency: 'GHS', reference: 'retry-ref' };
      await service.withdraw(walletId, dto);
      const retry = await service.withdraw(walletId, dto);

      expect(transactionsService.create).toHaveBeenCalledTimes(2);
      expect(ledgerService.recordDebit).toHaveBeenCalledTimes(1);
      expect(retry).toBe(debitedWallet);
    });

    it('returns the existing wallet without re-applying when a completed transaction exists for the reference', async () => {
      const walletId = new Types.ObjectId().toString();
      const existingWallet = { id: walletId, _id: walletId, balance: 60 };
      transactionsService.findByReference.mockResolvedValue({ status: TransactionStatus.COMPLETED });
      walletModel.findById.mockResolvedValue(existingWallet);

      const result = await service.withdraw(walletId, {
        amount: 40,
        currency: 'GHS',
        reference: 'seen-ref',
      });

      expect(walletModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(transactionsService.create).not.toHaveBeenCalled();
      expect(result).toBe(existingWallet);
    });
  });

  describe('transfer', () => {
    const fromId = new Types.ObjectId();
    const toId = new Types.ObjectId();

    function mockWallets(fromBalance: number) {
      const fromWallet = { _id: fromId, balance: fromBalance, currency: 'GHS' };
      const toWallet = { _id: toId, balance: 0, currency: 'GHS' };
      walletModel.findById.mockImplementation((id: unknown) => ({
        session: jest
          .fn()
          .mockResolvedValue(
            String(id) === String(fromId)
              ? fromWallet
              : String(id) === String(toId)
                ? toWallet
                : null,
          ),
      }));
      return { fromWallet, toWallet };
    }

    it('rejects transfers between the same wallet', async () => {
      await expect(
        service.transfer({
          fromWalletId: fromId.toString(),
          toWalletId: fromId.toString(),
          amount: 10,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when either wallet is missing', async () => {
      walletModel.findById.mockReturnValue({ session: jest.fn().mockResolvedValue(null) });

      await expect(
        service.transfer({
          fromWalletId: fromId.toString(),
          toWalletId: toId.toString(),
          amount: 10,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects a transfer larger than the sender balance', async () => {
      mockWallets(5);
      transferModel.create.mockResolvedValue([{ _id: new Types.ObjectId() }]);
      walletModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(
        service.transfer({
          fromWalletId: fromId.toString(),
          toWalletId: toId.toString(),
          amount: 10,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('debits the sender atomically, records the ledger entry, and stages a transfer.initiated outbox event', async () => {
      mockWallets(100);
      const createdTransfer = { _id: new Types.ObjectId(), status: 'PENDING' };
      transferModel.create.mockResolvedValue([createdTransfer]);
      const from = { _id: fromId, balance: 70, currency: 'GHS' };
      walletModel.findOneAndUpdate.mockResolvedValue(from);
      const debitTransaction = { _id: new Types.ObjectId() };
      transactionModel.create.mockResolvedValue([debitTransaction]);

      const result = await service.transfer({
        fromWalletId: fromId.toString(),
        toWalletId: toId.toString(),
        amount: 30,
      });

      expect(walletModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: fromId.toString(), balance: { $gte: 30 } },
        { $inc: { balance: -30 } },
        expect.objectContaining({ new: true, session: mockSession }),
      );
      expect(transactionModel.create).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            type: TransactionType.TRANSFER_OUT,
            amount: 30,
            balanceAfter: 70,
            reference: `transfer-out:${createdTransfer._id.toString()}`,
          }),
        ],
        { session: mockSession },
      );
      expect(ledgerService.recordDebit).toHaveBeenCalledWith(
        from._id,
        debitTransaction._id,
        30,
        70,
        mockSession,
      );
      expect(outboxService.enqueue).toHaveBeenCalledWith(
        'transfer.initiated',
        expect.objectContaining({ transferId: createdTransfer._id.toString(), amount: 30 }),
        mockSession,
      );
      expect(rabbitMQService.publish).not.toHaveBeenCalled();
      expect(result).toBe(createdTransfer);
      expect(redisService.invalidateWallets).toHaveBeenCalledWith(fromId.toString());
    });

    it('does not create a second transfer when retried with the same idempotency key', async () => {
      mockWallets(100);
      const createdTransfer = { _id: new Types.ObjectId(), status: 'PENDING' };
      transferModel.create.mockResolvedValue([createdTransfer]);
      transactionModel.create.mockResolvedValue([{ _id: new Types.ObjectId() }]);

      const dto = {
        fromWalletId: fromId.toString(),
        toWalletId: toId.toString(),
        amount: 30,
        idempotencyKey: 'retry-key-1',
      };

      await service.transfer(dto);
      await service.transfer(dto);

      expect(transferModel.create).toHaveBeenCalledTimes(1);
    });

    it('ends the Mongo session even when the transaction fails partway through', async () => {
      mockWallets(100);
      const createdTransfer = { _id: new Types.ObjectId(), status: 'PENDING' };
      transferModel.create.mockResolvedValue([createdTransfer]);
      walletModel.findOneAndUpdate.mockResolvedValue({ _id: fromId, balance: 70, currency: 'GHS' });
      transactionModel.create.mockRejectedValue(new Error('write conflict'));

      await expect(
        service.transfer({
          fromWalletId: fromId.toString(),
          toWalletId: toId.toString(),
          amount: 30,
        }),
      ).rejects.toThrow('write conflict');

      expect(mockSession.endSession).toHaveBeenCalled();
      expect(outboxService.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('retryTransfer', () => {
    it('increments retryCount and stages a transfer.retry outbox event in the same transaction', async () => {
      const transferId = new Types.ObjectId();
      const fromWalletId = new Types.ObjectId();
      const toWalletId = new Types.ObjectId();
      transferModel.findOneAndUpdate.mockResolvedValue({
        _id: transferId,
        fromWalletId,
        toWalletId,
        amount: 30,
        idempotencyKey: 'key-1',
      });

      await service.retryTransfer(transferId.toString());

      expect(transferModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: transferId.toString() },
        { $inc: { retryCount: 1 } },
        expect.objectContaining({ new: true, session: mockSession }),
      );
      expect(outboxService.enqueue).toHaveBeenCalledWith(
        'transfer.retry',
        {
          transferId: transferId.toString(),
          fromWalletId: fromWalletId.toString(),
          toWalletId: toWalletId.toString(),
          amount: 30,
          idempotencyKey: 'key-1',
        },
        mockSession,
      );
      expect(mockSession.endSession).toHaveBeenCalled();
    });

    it('throws NotFoundException and stages nothing when the transfer no longer exists', async () => {
      transferModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(service.retryTransfer('missing-id')).rejects.toThrow(NotFoundException);
      expect(outboxService.enqueue).not.toHaveBeenCalled();
      expect(mockSession.endSession).toHaveBeenCalled();
    });
  });

  describe('refund', () => {
    const transferId = new Types.ObjectId();
    const fromWalletId = new Types.ObjectId();
    const toWalletId = new Types.ObjectId();

    it('claims the transfer, restores the sender balance, and appends a reversal transaction + ledger credit', async () => {
      transferModel.findOneAndUpdate.mockResolvedValue({
        _id: transferId,
        fromWalletId,
        toWalletId,
        amount: 30,
      });
      const fromWallet = { id: fromWalletId.toString(), _id: fromWalletId, balance: 100 };
      walletModel.findOneAndUpdate.mockResolvedValue(fromWallet);
      const reversal = { _id: new Types.ObjectId() };
      transactionsService.create.mockResolvedValue(reversal);

      await service.refund(transferId.toString());

      expect(transferModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: transferId.toString(), status: TransferStatus.PENDING },
        { $set: { status: TransferStatus.REFUNDED } },
        expect.objectContaining({ new: true, session: mockSession }),
      );
      expect(walletModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: fromWalletId },
        { $inc: { balance: 30 } },
        expect.objectContaining({ new: true, session: mockSession }),
      );
      expect(transactionsService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: fromWallet.id,
          type: TransactionType.TRANSFER_IN,
          amount: 30,
          balanceAfter: 100,
          reference: `refund:${transferId.toString()}`,
        }),
        mockSession,
      );
      expect(ledgerService.recordCredit).toHaveBeenCalledWith(
        fromWallet._id,
        reversal._id,
        30,
        100,
        mockSession,
      );
      expect(mockSession.endSession).toHaveBeenCalled();
      expect(redisService.invalidateWallets).toHaveBeenCalledWith(fromWallet.id);
    });

    it('is an idempotent no-op when the transfer is no longer PENDING', async () => {
      transferModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(service.refund(transferId.toString())).resolves.toBeUndefined();

      expect(walletModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(transactionsService.create).not.toHaveBeenCalled();
      expect(ledgerService.recordCredit).not.toHaveBeenCalled();
      expect(redisService.invalidateWallets).not.toHaveBeenCalled();
      expect(mockSession.endSession).toHaveBeenCalled();
    });

    it('throws NotFoundException and records nothing when the sender wallet is missing', async () => {
      transferModel.findOneAndUpdate.mockResolvedValue({
        _id: transferId,
        fromWalletId,
        toWalletId,
        amount: 30,
      });
      walletModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(service.refund(transferId.toString())).rejects.toThrow(NotFoundException);
      expect(transactionsService.create).not.toHaveBeenCalled();
      expect(ledgerService.recordCredit).not.toHaveBeenCalled();
    });
  });
});
