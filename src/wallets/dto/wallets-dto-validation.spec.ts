import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateWalletDto } from './create-wallet.dto';
import { DepositDto } from './deposit.dto';
import { TransferDto } from './transfer.dto';
import { WithdrawDto } from './withdraw.dto';

describe('Wallet DTO validation', () => {
  describe('CreateWalletDto', () => {
    it('accepts a valid payload', async () => {
      const dto = plainToInstance(CreateWalletDto, { userId: 'user-1', ownerName: 'Ama Owusu' });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects a missing userId or ownerName', async () => {
      const dto = plainToInstance(CreateWalletDto, { userId: '', ownerName: '' });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.map((e) => e.property)).toEqual(
        expect.arrayContaining(['userId', 'ownerName']),
      );
    });
  });

  describe('DepositDto / WithdrawDto', () => {
    it('accepts a positive amount', async () => {
      expect(await validate(plainToInstance(DepositDto, { amount: 100, currency: 'GHS' }))).toHaveLength(0);
      expect(await validate(plainToInstance(WithdrawDto, { amount: 100, currency: 'GHS' }))).toHaveLength(0);
    });

    it('rejects a zero, negative, or missing amount', async () => {
      for (const payload of [{ amount: 0 }, { amount: -50 }, {}]) {
        expect((await validate(plainToInstance(DepositDto, payload))).length).toBeGreaterThan(0);
        expect((await validate(plainToInstance(WithdrawDto, payload))).length).toBeGreaterThan(0);
      }
    });
  });

  describe('TransferDto', () => {
    const validPayload = {
      fromWalletId: '64b64f2b1c8a1e4f6a2b5c81',
      toWalletId: '64b64f2b1c8a1e4f6a2b5c82',
      amount: 25,
    };

    it('accepts a valid payload with an optional idempotency key', async () => {
      const dto = plainToInstance(TransferDto, { ...validPayload, idempotencyKey: 'retry-1' });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects a non-ObjectId wallet id', async () => {
      const dto = plainToInstance(TransferDto, { ...validPayload, fromWalletId: 'not-an-id' });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'fromWalletId')).toBe(true);
    });

    it('rejects a non-positive amount', async () => {
      const dto = plainToInstance(TransferDto, { ...validPayload, amount: -10 });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'amount')).toBe(true);
    });
  });
});
