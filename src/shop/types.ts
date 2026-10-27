// Server-side records the guard trusts. Nothing here ever comes from model output.

export interface CatalogItem {
  sku: string;
  name: string;
  priceCents: number;
  maxQty: number;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  /** Vaulted Braintree card; the shop charges it, the model never sees or chooses it. */
  paymentMethodToken?: string;
}

export interface PaidOrder {
  orderId: string;
  captureId: string;
  customerId: string;
  totalCents: number;
  refundedCents: number;
  capturedAt: string;
}

export interface Ledger {
  catalog: CatalogItem[];
  customers: Customer[];
  orders: PaidOrder[];
}
