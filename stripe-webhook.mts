import { handler as legacyHandler } from './_shared/stripe-webhook-legacy.mjs';
import { clients,env,mailer } from './_shared/runtime.mts';
import { makeWebhookHandler } from './_shared/customer-flow.mjs';
export default async req => {
  const {db,stripe}=clients();
  // Keep the legacy Transformation path unchanged. Only Équilibre/Immersion use the new flow.
  const legacy=async(request,body)=>{
    const result=await legacyHandler({httpMethod:request.method,headers:Object.fromEntries(request.headers),body,isBase64Encoded:false});
    return new Response(result.body,{status:result.statusCode,headers:result.headers});
  };
  return makeWebhookHandler({db,stripe,secret:env('STRIPE_WEBHOOK_SECRET'),mailer:mailer(db),legacy})(req);
};
