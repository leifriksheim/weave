/**
 * Money and trade: shared expenses and settling up, accounts and
 * transactions, things for sale and orders. Amounts are always the `money`
 * fragment, a decimal string and a currency, never a float.
 */
import {
  authored,
  choice,
  count,
  day,
  image,
  many,
  money,
  one,
  own,
  person,
  placeRef,
  text,
  typed,
  words,
  type ImageRef,
  type Money,
  type Place,
} from '../fragments.js';

/**
 * An expense someone paid for a group, and how it splits. Every version is
 * kept, since who changed an amount matters when settling up.
 */
export const expense = typed<Expense>()({
  name: 'std.expense',
  title: 'Expense',
  description: 'Something one person paid for a group, and how it is split.',
  schema: {
    type: 'object',
    properties: {
      title: words(200),
      amount: money(),
      paidBy: person('Who paid'),
      split: {
        type: 'array',
        maxItems: 100,
        description: 'Who owes a share; equal shares when left out',
        items: {
          type: 'object',
          properties: {
            did: person(),
            share: text(32, 'Their part of the amount, a decimal string', 1),
          },
          required: ['did'],
        },
      },
      date: day(),
      note: text(2000),
    },
    required: ['title', 'amount', 'paidBy'],
  },
  history: 'all',
});
export interface Expense {
  readonly title: string;
  readonly amount: Money;
  readonly paidBy: string;
  readonly split?: ReadonlyArray<{ readonly did: string; readonly share?: string }>;
  readonly date?: string;
  readonly note?: string;
}

/** Money paid back between two people. Once written, who and how much stay as they are. */
export const settlement = typed<Settlement>()({
  name: 'std.settlement',
  title: 'Settlement',
  description: 'Money paid back from one person to another.',
  schema: {
    type: 'object',
    properties: {
      from: person('Who paid'),
      to: person('Who was paid'),
      amount: money(),
      date: day(),
      note: text(1000),
    },
    required: ['from', 'to', 'amount'],
  },
  rules: { ...own, fixed: ['from', 'to', 'amount'] },
});
export interface Settlement {
  readonly from: string;
  readonly to: string;
  readonly amount: Money;
  readonly date?: string;
  readonly note?: string;
}

/** A bank account, a card, a wallet: what transactions are `in`. */
export const moneyAccount = typed<MoneyAccount>()({
  name: 'std.money-account',
  title: 'Account',
  description: 'A bank account, card or wallet that transactions are in.',
  schema: {
    type: 'object',
    properties: {
      name: words(200),
      currency: { type: 'string', minLength: 3, maxLength: 3, description: 'ISO 4217' },
      kind: text(32, 'Like "checking", "savings", "credit" or "cash"'),
    },
    required: ['name', 'currency'],
  },
});
export interface MoneyAccount {
  readonly name: string;
  readonly currency: string;
  readonly kind?: string;
}

/** Money in or out of an account: negative amounts are out. */
export const transaction = typed<Transaction>()({
  name: 'std.transaction',
  title: 'Transaction',
  description: 'Money in or out of an account.',
  schema: {
    type: 'object',
    properties: {
      amount: money('Negative for money out'),
      date: day(),
      payee: text(200),
      category: text(100),
      note: text(1000),
      cleared: { type: 'boolean' },
    },
    required: ['amount', 'date'],
  },
  links: { in: one(['std.money-account'], 'The account') },
});
export interface Transaction {
  readonly amount: Money;
  readonly date: string;
  readonly payee?: string;
  readonly category?: string;
  readonly note?: string;
  readonly cleared?: boolean;
}

/** Something for sale, to give away or to lend. */
export const listing = typed<Listing>()({
  name: 'std.listing',
  title: 'Listing',
  description: 'Something for sale, to give away or to lend.',
  schema: {
    type: 'object',
    properties: {
      title: words(300),
      description: text(10000),
      price: money('Left out when it is free'),
      images: { type: 'array', maxItems: 12, items: image() },
      status: choice(['available', 'reserved', 'sold']),
      place: placeRef('Where to pick it up'),
    },
    required: ['title'],
  },
  permissions: ['moderate'],
  rules: authored,
});
export interface Listing {
  readonly title: string;
  readonly description?: string;
  readonly price?: Money;
  readonly images?: ReadonlyArray<ImageRef>;
  readonly status?: 'available' | 'reserved' | 'sold';
  readonly place?: Place;
}

/**
 * An order for listings. Only the buyer changes it; the seller answers with
 * `std.order-update`s, so the two never edit the same record.
 */
export const order = typed<Order>()({
  name: 'std.order',
  title: 'Order',
  description: 'An order for things listed: what, how many, for how much.',
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          properties: { title: words(300), quantity: count(1), price: money('For one') },
          required: ['title', 'quantity'],
        },
      },
      total: money(),
      note: text(2000),
    },
    required: ['items'],
  },
  links: { about: many(['std.listing'], 'The listings ordered') },
  rules: own,
});
export interface Order {
  readonly items: ReadonlyArray<{
    readonly title: string;
    readonly quantity: number;
    readonly price?: Money;
  }>;
  readonly total?: Money;
  readonly note?: string;
}

/** A step in an order's life, from either side: accepted, paid, shipped. */
export const orderUpdate = typed<OrderUpdate>()({
  name: 'std.order-update',
  title: 'Order update',
  description: 'A step in an order: accepted, paid, shipped, delivered, cancelled.',
  schema: {
    type: 'object',
    properties: {
      status: choice(['accepted', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded']),
      note: text(2000),
    },
    required: ['status'],
  },
  links: { about: one(['std.order'], 'The order') },
  rules: own,
});
export interface OrderUpdate {
  readonly status: 'accepted' | 'paid' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';
  readonly note?: string;
}
