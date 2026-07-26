import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { LedgerService } from '../ledger/ledger.service';
import { Transaction, TransactionType } from '../transactions/schemas/transaction.schema';
import { Transfer, TransferStatus } from '../wallets/schemas/transfer.schema';
import { Wallet } from '../wallets/schemas/wallet.schema';
import { RabbitMQService } from './rabbitmq.service';
import { TransferEventsConsumer } from './transfer-events.consumer';

describe('TransferEventsConsumer', () => {
  let consumer: TransferEventsConsumer;
  let transferModel: any;
  let walletModel: any;
  let transactionModel: any;
  let ledgerService: any;

  const mockSession = {
    withTransaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
    endSession: jest.fn(),
  };

  beforeEach(async () => {
    transferModel = { findById: jest.fn(), findOneAndUpdate: jest.fn() };
    walletModel = { findOneAndUpdate: jest.fn() };
    transactionModel = { create: jest.fn() };
    ledgerService = { recordCredit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransferEventsConsumer,
        {
          provide: getConnectionToken(),
          useValue: { startSession: jest.fn().mockResolvedValue(mockSession) },
        },
        {
          provide: RabbitMQService,
          useValue: { getChannelWrapper: jest.fn(), getTransferQueue: jest.fn() },
        },
        { provide: getModelToken(Transfer.name), useValue: transferModel },
        { provide: getModelToken(Wallet.name), useValue: walletModel },
        { provide: getModelToken(Transaction.name), useValue: transactionModel },
        { provide: LedgerService, useValue: ledgerService },
      ],
    }).compile();

    consumer = module.get(TransferEventsConsumer);
  });

  afterEach(() => jest.clearAllMocks());

  it('credits the destination, records the TRANSFER_IN with a deterministic reference, and completes the transfer', async () => {
    const transferId = new Types.ObjectId();
    const transfer = { _id: transferId, id: 'transfer-1', fromWalletId: new Types.ObjectId() };
    const toWallet = { _id: new Types.ObjectId(), id: 'wallet-2', balance: 125 };
    transferModel.findById.mockReturnValue({ session: jest.fn().mockResolvedValue(transfer) });
    walletModel.findOneAndUpdate.mockResolvedValue(toWallet);
    const creditTransaction = { _id: new Types.ObjectId() };
    transactionModel.create.mockResolvedValue([creditTransaction]);
    transferModel.findOneAndUpdate.mockResolvedValue({
      ...transfer,
      status: TransferStatus.COMPLETED,
    });

    const event = {
      transferId: transferId.toString(),
      fromWalletId: 'wallet-1',
      toWalletId: toWallet._id.toString(),
      amount: 25,
    };
    await (consumer as any).completeTransfer(event);

    expect(walletModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: event.toWalletId },
      { $inc: { balance: 25 } },
      expect.objectContaining({ new: true, session: mockSession }),
    );
    expect(transactionModel.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          type: TransactionType.TRANSFER_IN,
          amount: 25,
          balanceAfter: 125,
          reference: `transfer-in:${event.transferId}`,
        }),
      ],
      { session: mockSession },
    );
    expect(ledgerService.recordCredit).toHaveBeenCalledWith(
      toWallet._id,
      creditTransaction._id,
      25,
      125,
      mockSession,
    );
    expect(transferModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: event.transferId },
      { $set: { status: TransferStatus.COMPLETED } },
      expect.objectContaining({ new: true, session: mockSession }),
    );
    expect(mockSession.endSession).toHaveBeenCalled();
  });

  it('returns the existing transfer without re-crediting on a duplicate reference redelivery', async () => {
    const transferId = new Types.ObjectId();
    const transfer = { _id: transferId, fromWalletId: new Types.ObjectId() };
    const leanTransfer = { _id: transferId, status: TransferStatus.COMPLETED };
    transferModel.findById.mockReturnValue({
      session: jest.fn().mockResolvedValue(transfer),
      lean: jest.fn().mockResolvedValue(leanTransfer),
    });
    walletModel.findOneAndUpdate.mockResolvedValue({ _id: new Types.ObjectId(), balance: 125 });
    transactionModel.create.mockRejectedValue(
      Object.assign(new Error('E11000 duplicate key'), {
        code: 11000,
        keyPattern: { reference: 1 },
      }),
    );

    const result = await (consumer as any).completeTransfer({
      transferId: transferId.toString(),
      fromWalletId: 'wallet-1',
      toWalletId: 'wallet-2',
      amount: 25,
    });

    expect(result).toBe(leanTransfer);
    expect(ledgerService.recordCredit).not.toHaveBeenCalled();
    expect(transferModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mockSession.endSession).toHaveBeenCalled();
  });

  it('rethrows a non-duplicate error', async () => {
    const transferId = new Types.ObjectId();
    transferModel.findById.mockReturnValue({
      session: jest.fn().mockResolvedValue({ _id: transferId, fromWalletId: new Types.ObjectId() }),
    });
    walletModel.findOneAndUpdate.mockResolvedValue({ _id: new Types.ObjectId(), balance: 125 });
    transactionModel.create.mockRejectedValue(new Error('write failure'));

    await expect(
      (consumer as any).completeTransfer({
        transferId: transferId.toString(),
        fromWalletId: 'wallet-1',
        toWalletId: 'wallet-2',
        amount: 25,
      }),
    ).rejects.toThrow('write failure');
    expect(mockSession.endSession).toHaveBeenCalled();
  });

  it('throws when the transfer no longer exists', async () => {
    transferModel.findById.mockReturnValue({ session: jest.fn().mockResolvedValue(null) });

    await expect(
      (consumer as any).completeTransfer({
        transferId: 'missing',
        fromWalletId: 'wallet-1',
        toWalletId: 'wallet-2',
        amount: 25,
      }),
    ).rejects.toThrow();
    expect(walletModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
