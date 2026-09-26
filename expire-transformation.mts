import {clients,mailer} from './_shared/runtime.mts';
import {sendOnce} from './_shared/customer-flow.mjs';
import {expireTransformations} from './_shared/transformation.mjs';
export default async()=>{
 const {db}=clients();
 try{return Response.json(await expireTransformations({db,send:(key,message)=>sendOnce(mailer(db),key,message)}));}
 catch(e){console.error('Transformation expiry failed',e.message);return Response.json({error:'Retry required'},{status:500});}
};
export const config={schedule:'5 * * * *'};
