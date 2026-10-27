import type { Ledger } from '../shop/types.js';
import { formatCents, toCents } from './money.js';

export type Verdict = 'allow' | 'deny' | 'review';

export interface Decision {
  verdict: Verdict;
  rule: string;
  reason: string;
}

export interface Policy {
  /** Tools the agent may call without a human, subject to the rules below. */
  allowedTools: string[];
  /** Tools that always wait for a human, whatever their arguments. */
  reviewTools: string[];
  currency: 'USD';
  /** Origin that PayPal return/cancel redirects must stay on. */
  shopOrigin: string;
  taxPercent: number;
  shippingCents: number;
  maxOrderTotalCents: number;
  autoRefundLimitCents: number;
  refundWindowDays: number;
  sessionRefundBudgetCents: number;
  maxMoneyCallsPerSession: number;
}

export interface Session {
  /** Customer the shop authenticated for this conversation; null for anonymous chats. */
  customerId: string | null;
  refundedCents: number;
  moneyCalls: number;
}

export interface EvalContext {
  policy: Policy;
  ledger: Ledger;
  session: Session;
  now: Date;
}

export const TOOLKIT_DEFAULT_RETURN_URL = 'https://example.com/returnUrl';
export const TOOLKIT_DEFAULT_CANCEL_URL = 'https://example.com/cancelUrl';

export const MONEY_TOOLS = new Set([
  'create_order',
  'create_refund',
  'pay_order',
  'accept_dispute_claim',
  'send_invoice',
  'create_invoice',
  'charge_saved_card',
  'refund_transaction',
  'accept_dispute',
]);

const allow = (rule: string, reason: string): Decision => ({ verdict: 'allow', rule, reason });
const deny = (rule: string, reason: string): Decision => ({ verdict: 'deny', rule, reason });
const review = (rule: string, reason: string): Decision => ({ verdict: 'review', rule, reason });

/** Decides whether one PayPal toolkit call may run, using only trusted server state. */
export function evaluate(tool: string, args: Record<string, unknown>, ctx: EvalContext): Decision {
  const { policy, session } = ctx;
  const allowed = policy.allowedTools.includes(tool);
  const reviewed = policy.reviewTools.includes(tool);
  if (!allowed && !reviewed) return deny('tool-not-allowed', `${tool} is not enabled for this agent`);

  if (MONEY_TOOLS.has(tool) && session.moneyCalls >= policy.maxMoneyCallsPerSession) {
    return deny('rate-limit', `more than ${policy.maxMoneyCallsPerSession} payment actions in one conversation`);
  }
  if (reviewed) return review('always-human', `${tool} always needs a person to approve it`);

  const call = toolkitEquivalent(tool, args);
  switch (call.tool) {
    case 'create_order':
      return checkCreateOrder(call.args, ctx);
    case 'create_refund':
      return checkRefund(call.args, ctx);
    case 'get_order':
      return checkOwnOrder(String(call.args.id ?? ''), ctx);
    default:
      return allow('allowed-tool', `${tool} is read-only for this agent`);
  }
}

/** Braintree tools are held to the same rules as their PayPal Agent Toolkit counterparts. */
export function toolkitEquivalent(tool: string, args: Record<string, unknown>): { tool: string; args: Record<string, unknown> } {
  switch (tool) {
    case 'charge_saved_card':
      return { tool: 'create_order', args: { currencyCode: 'USD', items: args.items, shippingCost: args.shippingCost, discount: args.discount } };
    case 'refund_transaction':
      return {
        tool: 'create_refund',
        args: { capture_id: args.transaction_id, ...(args.amount === undefined ? {} : { amount: { currency_code: 'USD', value: String(args.amount) } }) },
      };
    case 'find_transaction':
      return { tool: 'get_order', args: { id: args.transaction_id } };
    default:
      return { tool, args };
  }
}

function checkCreateOrder(args: Record<string, unknown>, ctx: EvalContext): Decision {
  const { policy, ledger } = ctx;
  if (args.currencyCode !== policy.currency) return deny('currency', `orders must be in ${policy.currency}`);

  for (const field of ['returnUrl', 'cancelUrl'] as const) {
    const url = args[field];
    const toolkitDefault = field === 'returnUrl' ? TOOLKIT_DEFAULT_RETURN_URL : TOOLKIT_DEFAULT_CANCEL_URL;
    if (url === undefined || url === toolkitDefault) continue;
    if (!sameOrigin(String(url), policy.shopOrigin)) {
      return deny('redirect-origin', `${field} points outside ${policy.shopOrigin}`);
    }
  }

  if ((toCents(args.discount ?? 0) ?? -1) !== 0) return review('discount', 'the agent may not grant discounts on its own');
  if (toCents(args.shippingCost ?? 0) !== policy.shippingCents) {
    return deny('shipping-price', `shipping must be ${formatCents(policy.shippingCents)}`);
  }

  const items = Array.isArray(args.items) ? (args.items as Record<string, unknown>[]) : [];
  if (items.length === 0) return deny('empty-order', 'order has no items');

  let totalCents = policy.shippingCents;
  for (const item of items) {
    const name = String(item.name ?? '');
    const product = ledger.catalog.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!product) return deny('unknown-item', `"${name}" is not in the catalog`);

    const cost = toCents(item.itemCost);
    if (cost !== product.priceCents) {
      return deny('price-mismatch', `${product.name} costs ${formatCents(product.priceCents)}, agent tried ${cost === null ? 'an invalid price' : formatCents(cost)}`);
    }
    const qty = Number(item.quantity ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > product.maxQty) {
      return deny('quantity', `${product.name} quantity must be 1-${product.maxQty}`);
    }
    if (Number(item.taxPercent ?? 0) !== policy.taxPercent) return deny('tax', `tax must be ${policy.taxPercent}%`);
    if (item.itemTotal !== undefined && toCents(item.itemTotal) !== cost * qty) {
      return deny('line-total', `${product.name} line total does not equal price x quantity`);
    }
    totalCents += cost * qty;
  }

  if (totalCents > policy.maxOrderTotalCents) {
    return review('order-limit', `order total ${formatCents(totalCents)} is above ${formatCents(policy.maxOrderTotalCents)}`);
  }
  return allow('catalog-match', `every item matches the catalog; total ${formatCents(totalCents)}`);
}

function checkRefund(args: Record<string, unknown>, ctx: EvalContext): Decision {
  const { policy, ledger, session, now } = ctx;
  if (!session.customerId) return deny('unauthenticated', 'refunds need a signed-in customer');

  const order = ledger.orders.find((o) => o.captureId === args.capture_id);
  if (!order) return deny('unknown-capture', 'this payment is not one of the shop\'s orders');
  if (order.customerId !== session.customerId) return deny('not-your-order', 'the payment belongs to a different customer');

  const remaining = order.totalCents - order.refundedCents;
  const amount = args.amount as { currency_code?: string; value?: string } | undefined;
  let cents = remaining;
  if (amount) {
    if (amount.currency_code !== policy.currency) return deny('currency', `refunds must be in ${policy.currency}`);
    const parsed = toCents(amount.value);
    if (parsed === null || parsed <= 0) return deny('refund-amount', 'refund amount is not a positive number');
    cents = parsed;
  }
  if (remaining <= 0) return deny('already-refunded', 'this order is already fully refunded');
  if (cents > remaining) return deny('exceeds-refundable', `refund ${formatCents(cents)} is more than the ${formatCents(remaining)} still refundable`);

  const ageDays = (now.getTime() - new Date(order.capturedAt).getTime()) / 86_400_000;
  if (ageDays > policy.refundWindowDays) return review('refund-window', `order is ${Math.floor(ageDays)} days old (window is ${policy.refundWindowDays})`);
  if (cents > policy.autoRefundLimitCents) return review('refund-limit', `refund ${formatCents(cents)} is above the ${formatCents(policy.autoRefundLimitCents)} automatic limit`);
  if (session.refundedCents + cents > policy.sessionRefundBudgetCents) {
    return review('session-budget', `this conversation would refund more than ${formatCents(policy.sessionRefundBudgetCents)}`);
  }
  return allow('refund-in-policy', `refund ${formatCents(cents)} on the customer's own order`);
}

function checkOwnOrder(orderId: string, ctx: EvalContext): Decision {
  const { ledger, session } = ctx;
  if (!session.customerId) return deny('unauthenticated', 'order lookups need a signed-in customer');
  const order = ledger.orders.find((o) => o.orderId === orderId);
  if (!order || order.customerId !== session.customerId) return deny('not-your-order', 'order does not belong to this customer');
  return allow('own-order', 'customer is reading their own order');
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}
