import {runLifecycle} from './_shared/lifecycle.mjs';
export default async () => {
  const result=await runLifecycle();
  return new Response(result.body,{status:result.statusCode,headers:{'Content-Type':'application/json'}});
};
export const config={schedule:'0 8 * * *'};
