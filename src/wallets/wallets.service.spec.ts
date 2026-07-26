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
import { Transfer } from './schemas/transfer.schema';
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
      getCachedBalance: jest.fn(),
      setCachedBalance: jest.fn(),
      invalidateBalance: jest.fn(),
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
    it('seeds the cache from Mongo on a cache miss', async () => {
      const wallet = {
        id: 'w1',
        _id: 'w1',
        balance: 250,
        toObject: () => ({ id: 'w1', balance: 250 }),
      };
      walletModel.findById.mockResolvedValue(wallet);
      redisService.getCachedBalance.mockResolvedValue(null);

      const result = await service.getWallet('w1');

      expect(redisService.setCachedBalance).toHaveBeenCalledWith('w1', 250);
      expect(result).toBe(wallet);
    });

    it('returns the cached balance instead of re-reading Mongo on a cache hit', async () => {
      const wallet = {
        id: 'w1',
        _id: 'w1',
        balance: 250,
        toObject: () => ({ id: 'w1', balance: 250 }),
      };
      walletModel.findById.mockResolvedValue(wallet);
      redisService.getCachedBalance.mockResolvedValue(99);

      const result = await service.getWallet('w1');

      expect(redisService.setCachedBalance).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ balance: 99 }));
    });

    it('throws NotFoundException when the wallet does not exist', async () => {
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
    });

    it('rejects a withdrawal larger than the current balance', async () => {
      walletModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(service.withdraw('w1', { amount: 40, currency: 'GHS' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when the wallet does not exist', async () => {
      walletModel.findById.mockResolvedValue(null);

      await expect(service.withdraw('missing-id', { amount: 10, currency: 'GHS' })).rejects.toThrow(
        NotFoundException,
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
      const fromWallet = { _id: fromId, balance: fromBalance, save: jest.fn() };
      const toWallet = { _id: toId, balance: 0 };
      walletModel.findById.mockImplementation((id: unknown) => {
        if (String(id) === String(fromId)) return Promise.resolve(fromWallet);
        if (String(id) === String(toId)) return Promise.resolve(toWallet);
        return Promise.resolve(null);
      });
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
      walletModel.findById.mockResolvedValue(null);

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

      await expect(
        service.transfer({
          fromWalletId: fromId.toString(),
          toWalletId: toId.toString(),
          amount: 10,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('debits the sender, records a ledger entry, and publishes a transfer.initiated event', async () => {
      const { fromWallet } = mockWallets(100);
      const createdTransfer = { _id: new Types.ObjectId(), status: 'PENDING' };
      transferModel.create.mockResolvedValue([createdTransfer]);
      const debitTransaction = { _id: new Types.ObjectId() };
      transactionModel.create.mockResolvedValue([debitTransaction]);

      const result = await service.transfer({
        fromWalletId: fromId.toString(),
        toWalletId: toId.toString(),
        amount: 30,
      });

      expect(fromWallet.balance).toBe(70);
      expect(ledgerService.recordDebit).toHaveBeenCalledWith(
        fromWallet._id,
        debitTransaction._id,
        30,
        70,
        mockSession,
      );
      expect(rabbitMQService.publish).toHaveBeenCalledWith(
        'transfer.initiated',
        expect.objectContaining({ transferId: createdTransfer._id.toString(), amount: 30 }),
      );
      expect(result).toBe(createdTransfer);
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
      transactionModel.create.mockRejectedValue(new Error('write conflict'));

      await expect(
        service.transfer({
          fromWalletId: fromId.toString(),
          toWalletId: toId.toString(),
          amount: 30,
        }),
      ).rejects.toThrow('write conflict');

      expect(mockSession.endSession).toHaveBeenCalled();
      expect(rabbitMQService.publish).not.toHaveBeenCalled();
    });
  });
});
