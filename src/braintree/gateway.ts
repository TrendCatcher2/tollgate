import braintree from 'braintree';

export function sandboxGateway(env: NodeJS.ProcessEnv = process.env): braintree.BraintreeGateway {
  const { BRAINTREE_MERCHANT_ID, BRAINTREE_PUBLIC_KEY, BRAINTREE_PRIVATE_KEY } = env;
  if (!BRAINTREE_MERCHANT_ID || !BRAINTREE_PUBLIC_KEY || !BRAINTREE_PRIVATE_KEY) {
    throw new Error('Missing BRAINTREE_MERCHANT_ID / BRAINTREE_PUBLIC_KEY / BRAINTREE_PRIVATE_KEY. Copy them from the Braintree sandbox (gear icon -> API -> Keys) into .env.');
  }
  return new braintree.BraintreeGateway({
    environment: braintree.Environment.Sandbox,
    merchantId: BRAINTREE_MERCHANT_ID,
    publicKey: BRAINTREE_PUBLIC_KEY,
    privateKey: BRAINTREE_PRIVATE_KEY,
  });
}
