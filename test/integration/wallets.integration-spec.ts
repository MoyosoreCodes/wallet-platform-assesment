import { INestApplication } from '@nestjs/common';
import { Connection } from 'mongoose';
import { LedgerEntry } from '../../src/ledger/schemas/ledger-entry.schema';
import { createAuthenticatedRequest, createTestApp, getModel, resetDatabase } from './test-utils';

describe('Wallets (integration)', () => {
  let app: INestApplication;
  let connection: Connection;
  let client: Awaited<ReturnType<typeof createAuthenticatedRequest>>;

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
  });

  beforeEach(async () => {
    await resetDatabase(connection);
    client = await createAuthenticatedRequest(app, connection);
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a wallet with a zero balance', async () => {
    const response = await client
      .post('/wallets')
      .send({ userId: 'user-1', ownerName: 'Ama Owusu' })
      .expect(201);

    expect(response.body.balance).toBe(0);
    expect(response.body.ownerName).toBe('Ama Owusu');
  });

  it('deposits funds and persists a matching ledger entry', async () => {
    const wallet = await client
      .post('/wallets')
      .send({ userId: 'user-2', ownerName: 'Kwame Mensah' })
      .expect(201);

    await client.post(`/wallets/${wallet.body._id}/deposit`).send({ amount: 200, currency: 'GHS' }).expect(201);

    const ledgerEntryModel = getModel(app, LedgerEntry.name);
    const ledgerEntries = await ledgerEntryModel.find({ walletId: wallet.body._id }).exec();

    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0].direction).toBe('CREDIT');
    expect(ledgerEntries[0].amount).toBe(200);
  });

  it('rejects a withdrawal larger than the current balance', async () => {
    const wallet = await client
      .post('/wallets')
      .send({ userId: 'user-3', ownerName: 'Efua Asante' })
      .expect(201);

    await client.post(`/wallets/${wallet.body._id}/deposit`).send({ amount: 50, currency: 'GHS' }).expect(201);

    await client.post(`/wallets/${wallet.body._id}/withdraw`).send({ amount: 100, currency: 'GHS' }).expect(400);
  });

  it('rejects malformed wallet creation payloads', async () => {
    await client.post('/wallets').send({ ownerName: 'Missing userId' }).expect(400);
  });
});
