import { clients } from './_shared/runtime.mts';
import { makePortalHandler } from './_shared/customer-flow.mjs';
export default async req => makePortalHandler(clients())(req);
