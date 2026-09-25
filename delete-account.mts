import { clients,env,mailer } from './_shared/runtime.mts';
import { makeDeleteHandler } from './_shared/customer-flow.mjs';
export default async req => {
  const {db}=clients();
  return makeDeleteHandler({db,mailer:mailer(db),deleteUser:authorization=>fetch(env('SUPABASE_URL')+'/functions/v1/delete-account',{method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json'}})})(req);
};
