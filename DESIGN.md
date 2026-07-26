# Design Notes

## 1. What issues did you find?

I went through the write paths, the event flow, and the workers by reading the
code, and I used the failing tests and the integration tests to tell me what the
system was meant to do.

The issues I found and worked on:

- Balances could go negative under load. Withdraw and transfer read the balance,
  checked it, then saved. Two requests at the same time both passed the check.
- The transfer only debited the sender. The credit to the receiver was left to a
  consumer that dropped errors, and the worker meant to catch stuck transfers
  only logged them.
- Retried requests created duplicate effects. The idempotency keys were stored
  but never checked.
- The transfer published its event to RabbitMQ inside the database transaction,
  before the transaction had committed.
- The consumer credited the receiver again if the same message was delivered
  twice.
- Transfers could get stuck. The consumer acked failed messages, so they were
  lost, and nothing retried them.
- Reads served stale balances. No write cleared the Redis cache, and the read
  even returned the cached value over the fresh one from the database.
- The dashboard loaded every transaction into memory, ran one ledger query per
  transaction, then sliced off the last 10. That does not scale.
- The transaction and ledger collections were missing indexes for the queries
  that run against them.
- The wallet had a `version` field that nothing read or wrote.

## 2. What did you prioritize, and why?

I spent most of the time on the money paths: negative balances, finishing the
transfer, idempotency, the outbox, safe redelivery, and stuck transfers. After
that, the cache, then the dashboard and indexes.

The reason is simple. A wrong balance or a double credit is a money problem, and
the things that trigger it (two requests at once, a client retry, a message
delivered twice) happen all the time in production. The stale cache is what a
customer actually sees after a transaction, and it was cheap to fix. The
dashboard and indexes were quick wins once the money paths were solid.

## 3. How did you handle concurrency?

Three places could race. Here is what I did for each.

Two withdrawals or transfers on the same wallet. I replaced the read, check, save
pattern with one atomic update:

    findOneAndUpdate({ _id, balance: { $gte: amount } }, { $inc: { balance: -amount } })

The check and the debit are one operation the database runs on a single document,
so a balance cannot go negative no matter how the requests interleave. The
concurrency integration test fires 10 withdrawals of 20 against a balance of 100
at the same time, and confirms exactly 5 succeed, the balance ends at 0, and it
never drops below 0.

A client retrying the same request. Each transaction and transfer carries an
idempotency key with a unique index. I check for it before doing the work, and if
two requests get past that check at the same time, the second one hits the unique
index, its transaction rolls back, and I return the existing result instead.

A message delivered more than once. The consumer writes the credit transaction
with a fixed key (transfer-in:<transferId>). A repeat delivery hits the unique
index, the whole thing rolls back, and the receiver is not credited twice.

On the version field. It was meant for optimistic locking, where you read the
version and only write if it has not changed. The atomic updates above already
stop the race that optimistic locking guards against, so the field was doing
nothing, and I removed it. Mongoose's built in __v does not help here either,
because it only works through .save(), and every write in this service uses
findOneAndUpdate. Removing the field is safe for existing data. Old documents keep
a version of 0 that Mongoose now ignores, and it can be cleared with a one time
$unset if you want.

## 4. How did you ensure data consistency?

Across the database, the queue, and the cache:

- The balance change, the transaction record, and the ledger entry all commit
  together in one database transaction. The balance on the wallet cannot drift
  away from the ledger.
- The transfer does not write to the database and publish to the queue as two
  separate steps. It writes the event into the outbox in the same transaction,
  and a worker publishes it after the transaction commits. So there is never an
  event for a transfer that did not commit.
- The consumer settles inside its own transaction and is safe to run twice. The
  fixed key stops a double credit.
- A refund does not rewrite the original debit. It adds a new credit transaction
  and ledger entry, so the ledger stays a record you only add to, and it still
  adds up to the balance.
- Every write that changes a balance clears the wallet from the cache, so the
  next read comes from the database.

There are two small gaps, both read only. Between a write committing and the cache
being cleared, a read can return the old cached wallet for a moment. And the cache
clear is best effort, so if Redis is down the old value stays until the TTL runs
out. Neither one can make the database itself wrong.

## 5. Trade-offs

- Atomic updates instead of optimistic locking. Simpler, no retry loop, and it is
  why I dropped the version field.
- Clearing the cache instead of updating it on a write. Clearing is safe when two
  writes land close together. Writing the new value in can land out of order and
  leave a stale number.
- Caching the whole wallet instead of just the balance. A read hit now skips the
  database completely. The cost is that any change to the wallet has to clear the
  cache, which is fine here because the balance is the only field that changes.
- Using the outbox for transfers adds a small delay, since the relay runs on an
  interval, in exchange for not losing events and not doing a dual write.
- Recovering stuck transfers with the sweeper instead of a dead letter queue. The
  pending transfers in the database are the truth, so the sweeper re-sends them up
  to a limit, then refunds. Fewer moving parts, and it is safe because the
  consumer is idempotent.
- Requiring a currency on deposit and withdraw. This is a breaking change to the
  API, kept on purpose so a caller cannot deposit in the wrong currency by
  accident.

## 6. Remaining technical debt

These are the rough edges in what I built, not a wishlist.

- On a real failure (not a duplicate), the consumer drops the message and leaves
  recovery to the sweeper. There is no dead letter queue, so a message that keeps
  failing is not parked anywhere for someone to look at.
- The outbox relay does not lock the rows it is about to publish. With one
  instance this is fine. With two instances running, both could publish the same
  event. The idempotent consumer stops that from causing damage, but it is still
  wasteful.
- A refund on a transfer that already failed returns the failed record instead of
  trying again. This is on purpose, a fresh attempt should use a new key, but it
  is worth calling out.
- There is a short window where a read can serve a stale cached balance, described
  in section 4.

Two of the known issues I did not get to:

- One of the background workers grows its memory over time. It looks like it adds
  an event listener on each run and never removes the old one, so the count keeps
  climbing. I did not confirm the exact spot or fix it.
- Logs are hard to correlate. There is no shared id running through the log lines
  for a single request or event, so tracing one incident across the api, the
  worker, and the consumer has to be done by hand.

## 7. What would you improve with another day?

I would redesign the outbox into a proper event log.

Right now the outbox is thin. An event is either pending or published. There is no
retry, no backoff, and no record of why something failed. I would turn it into one
collection that owns the whole life of an event, with these changes:

- Give each event a status (pending, processing, completed, failed, exhausted), an
  attempt count and a max, the last error, and a full attempt history.
- Have the relay claim an event with a single atomic findOneAndUpdate that also
  sets a lease (a lockedUntil timestamp). That is the row lock the current relay
  is missing, so two instances never grab the same event.
- On a failure, back off with a growing delay and some jitter, and set a
  nextRetryAt, so a failing event is retried later instead of in a tight loop.
- When an event runs out of attempts, move it to exhausted. That is the dead
  letter, kept in the database where it can be listed and retried by hand from an
  admin endpoint, instead of vanishing.

This would replace both the outbox relay and the pending transfer sweeper with one
piece, and it would give the failure handling and the visibility the current setup
does not have.

I would also cache the dashboard queries. Right now the summary, transactions, and
ledger endpoints hit the database on every read. I would cache each result under
the wallet id, so repeat reads for the same wallet return the cached data. Any
write to that wallet, its transactions, or its ledger would clear those cached
results, the same way the wallet cache is cleared on a write today.

## 8. Assumptions

- A wallet holds one currency. A transfer between wallets of different currencies
  is rejected, there is no conversion.
- Mongo runs as a replica set, which the transactions depend on.
- A caller that needs a retry to be safe sends an idempotency key. Without one,
  only the atomic checks protect them.
- The cache TTL (1 hour) is an acceptable ceiling for how long a stale value can
  live if the cache clear does not run.
- One API instance is the normal case. The money paths are safe with more than
  one, but the outbox relay would double publish until it locks rows, as noted in
  section 7.
