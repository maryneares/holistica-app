import { clients } from './_shared/runtime.mts';
import { makeClaimHandler } from './_shared/customer-flow.mjs';
export default async req => makeClaimHandler(clients())(req);
