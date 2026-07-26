import { INestApplication } from '@nestjs/common';
import { Connection } from 'mongoose';
import { LedgerEntry } from '../../src/ledger/schemas/ledger-entry.schema';
import { Transaction } from '../../src/transactions/schemas/transaction.schema';
import { Wallet } from '../../src/wallets/schemas/wallet.schema';
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

  it('invalidates the cached balance after a deposit so reads reflect the new balance', async () => {
    const wallet = await client
      .post('/wallets')
      .send({ userId: 'cache-user', ownerName: 'Nana Yaa' })
      .expect(201);
    const id = wallet.body._id;

    await client.post(`/wallets/${id}/deposit`).send({ amount: 100, currency: 'GHS' }).expect(201);

    const firstRead = await client.get(`/wallets/${id}`).expect(200);
    expect(firstRead.body.balance).toBe(100);

    await client.post(`/wallets/${id}/deposit`).send({ amount: 50, currency: 'GHS' }).expect(201);

    const dbWallet = await getModel(app, Wallet.name).findById(id);
    expect(dbWallet?.balance).toBe(150);

    const secondRead = await client.get(`/wallets/${id}`).expect(200);
    expect(secondRead.body.balance).toBe(dbWallet?.balance);
  });

  it('summarizes the wallet and paginates its transactions and ledger entries', async () => {
    const walletModel = getModel(app, Wallet.name);
    const transactionModel = getModel(app, Transaction.name);
    const ledgerEntryModel = getModel(app, LedgerEntry.name);

    const wallet = await client
      .post('/wallets')
      .send({ userId: 'dash-user', ownerName: 'Adwoa Mensah' })
      .expect(201);
    const id = wallet.body._id;

    await client.post(`/wallets/${id}/deposit`).send({ amount: 100, currency: 'GHS' }).expect(201);
    await client.post(`/wallets/${id}/deposit`).send({ amount: 50, currency: 'GHS' }).expect(201);
    await client.post(`/wallets/${id}/withdraw`).send({ amount: 30, currency: 'GHS' }).expect(201);

    const dbWallet = await walletModel.findById(id);
    const dbTransactions = await transactionModel.find({ walletId: id }).exec();
    const dbLedger = await ledgerEntryModel.find({ walletId: id }).exec();
    expect(dbWallet?.balance).toBe(120);
    expect(dbTransactions).toHaveLength(3);
    expect(dbLedger).toHaveLength(3);

    const summary = await client.get(`/wallets/${id}/summary`).expect(200);
    expect(summary.body.wallet.balance).toBe(dbWallet?.balance);
    expect(summary.body.totalDeposited).toBe(150);
    expect(summary.body.totalWithdrawn).toBe(30);
    expect(summary.body.transactionCount).toBe(dbTransactions.length);

    const transactions = await client.get(`/wallets/${id}/transactions?page=1&limit=2`).expect(200);
    expect(transactions.body.data).toHaveLength(2);
    expect(transactions.body.meta.total).toBe(dbTransactions.length);
    expect(transactions.body.meta.totalPages).toBe(2);
    expect(transactions.body.meta.hasNextPage).toBe(true);
    expect(transactions.body.meta.hasPreviousPage).toBe(false);

    const ledger = await client.get(`/wallets/${id}/ledger-entries`).expect(200);
    expect(ledger.body.data).toHaveLength(dbLedger.length);
    expect(ledger.body.meta.total).toBe(dbLedger.length);
  });

  it('rejects a malformed wallet id with a 400', async () => {
    await client.get('/wallets/not-a-valid-id/summary').expect(400);
  });
});
