// Server-only: Stripe is authoritative; no access from a client-supplied user id.
const id=v=>typeof v==='string'?v:v?.id;
const email=v=>String(v||'').trim().toLowerCase();
const checked=r=>{if(r.error)throw new Error('Transformation database: '+r.error.code);return r.data;};
export const isTransformation=p=>/transformation/i.test(p?.name||'');
export function threeMonthsAfter(seconds){
 const d=new Date(seconds*1000),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+3);
 const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return d.toISOString();
}
async function productOf(stripe,price){return typeof price.product==='string'?stripe.products.retrieve(price.product):price.product;}
export async function transformationState(stripe,{subscriptionId,sessionId},now=new Date()){
 let sub,session,price,customerId,start,status,paid=false;
 if(subscriptionId){
  sub=await stripe.subscriptions.retrieve(subscriptionId,{expand:['items.data.price.product','latest_invoice']});
  if(sub.items?.data?.length!==1)throw new Error('Multiple subscription products require review');
  price=sub.items.data[0].price;if(!isTransformation(await productOf(stripe,price)))return null;
  if(price.recurring?.interval!=='month'||(price.recurring.interval_count||1)!==1)throw new Error('Transformation must be monthly');
  customerId=id(sub.customer);start=sub.start_date||sub.created;
  const invoices=await stripe.invoices.list({subscription:sub.id,status:'paid',limit:100});
  paid=invoices.data.some(i=>i.amount_paid>0&&['subscription_create','subscription_cycle'].includes(i.billing_reason));
  status=sub.status==='active'&&paid?'active':sub.status;
  if(status==='active'&&!paid)status='pending';
 }else{
  session=await stripe.checkout.sessions.retrieve(sessionId);
  if(session.subscription)return transformationState(stripe,{subscriptionId:id(session.subscription)},now);
  const lines=await stripe.checkout.sessions.listLineItems(session.id,{limit:100});
  if(lines.has_more)throw new Error('Checkout line items incomplete; review required');
  const products=await Promise.all(lines.data.map(async line=>({line,product:line.price?await productOf(stripe,line.price):null})));
  const programmes=products.filter(item=>isTransformation(item.product));
  if(!programmes.length)return null;
  if(programmes.length!==1||(programmes[0].line.quantity||1)!==1)throw new Error('Multiple Transformation programmes require review');
  // A separately priced one-off guide may accompany the programme.
  // It neither changes the programme duration nor creates another entitlement.
  if(lines.data.some(line=>!line.price||line.price.recurring))throw new Error('Unexpected recurring checkout item');
  price=programmes[0].line.price;
  if(session.mode!=='payment')throw new Error('Unsupported checkout mode');
  customerId=id(session.customer);start=session.created;
  paid=session.payment_status==='paid'&&session.amount_total>0;status=paid?'active':'pending';
  if(paid&&session.payment_intent){const pi=await stripe.paymentIntents.retrieve(id(session.payment_intent),{expand:['latest_charge']});
   if(pi.status!=='succeeded')status='pending';
   if(pi.latest_charge?.refunded||pi.latest_charge?.disputed)status='revoked';
  }
 }
 const customer=customerId?await stripe.customers.retrieve(customerId):null;
 const recipient=email(!customer?.deleted&&customer?.email||session?.customer_details?.email);
 if(!recipient)throw new Error('Payment email missing');
 const expiresAt=threeMonthsAfter(start);
 if(new Date(expiresAt)<=now)status='expired';
 return {order_id:sub?.id||session.id,subscription_id:sub?.id||null,session_id:session?.id||null,customer_id:customerId||null,email:recipient,starts_at:new Date(start*1000).toISOString(),expires_at:expiresAt,status,sub};
}
export async function stopAfterThreeMonths(stripe,state){
 if(!state.sub||!['active','trialing','past_due'].includes(state.sub.status))return;
 const end=Math.floor(new Date(state.expires_at).getTime()/1000);
 // Stripe owns the end date: retries never add three more months.
 if(end<=Math.floor(Date.now()/1000)){
  await stripe.subscriptions.cancel(state.sub.id,{invoice_now:false,prorate:false});return;
 }
 if(state.sub.cancel_at_period_end||state.sub.cancel_at&&state.sub.cancel_at<=end)return;
 await stripe.subscriptions.update(state.sub.id,{cancel_at:end,proration_behavior:'none'});
}
export async function saveTransformation(db,state){
 const {sub,...row}=state;
 checked(await db.from('holistica_transformation_orders').upsert(row,{onConflict:'order_id'}));
 let order=checked(await db.from('holistica_transformation_orders').select('*').eq('order_id',state.order_id).single());
 if(!order.user_id){
  const pattern=state.email.replace(/[\\%_]/g,c=>'\\'+c);
  const candidate=checked(await db.from('profiles').select('id').ilike('email',pattern).maybeSingle());
  if(candidate){const a=await db.auth.admin.getUserById(candidate.id);if(a.error)throw a.error;
   if(a.data.user?.email_confirmed_at&&email(a.data.user.email)===state.email){
    checked(await db.rpc('apply_holistica_transformation',{p_order_id:state.order_id,p_user_id:candidate.id}));
   }
  }
 }else checked(await db.rpc('apply_holistica_transformation',{p_order_id:state.order_id,p_user_id:order.user_id}));
}
export async function claimTransformation({db,stripe,user,now=new Date()}){
 const orders=checked(await db.from('holistica_transformation_orders').select('*').eq('email',email(user.email)).order('starts_at',{ascending:false}).limit(10))||[];
 for(const order of orders){
  if(order.user_id&&order.user_id!==user.id)continue;
  const state=await transformationState(stripe,{subscriptionId:order.subscription_id,sessionId:order.session_id},now);
  if(!state||state.email!==email(user.email))continue;
  await saveTransformation(db,state);
  if(state.status==='active'){
   const applied=checked(await db.rpc('apply_holistica_transformation',{p_order_id:state.order_id,p_user_id:user.id}));
   if(applied)return true;
  }
 }
 return false;
}
export function transformationEmail(kind,state){
 const end=new Date(state.expires_at).toLocaleDateString('fr-FR',{timeZone:'Europe/Paris'});
 const copy={welcome:['Bienvenue dans ton programme Transformation',`Ton paiement est confirmé. Ton accompagnement de trois mois inclut l’accès Immersion jusqu’au ${end}, sans abonnement Immersion supplémentaire.<p>Crée ton compte ou connecte-toi avec cette même adresse e-mail. Maryne te contactera pour organiser ton premier bilan.</p>`],paid:['Paiement reçu — Transformation','Ton paiement pour le programme Transformation a bien été reçu. Merci pour ta confiance.'],failed:['Ton paiement Transformation nécessite une vérification','Ton paiement n’a pas abouti. Vérifie ton moyen de paiement et le statut de ton programme dans ton espace membre.'],ended:['Fin de ton accès Transformation','Ton accès lié au programme Transformation est terminé. Merci d’avoir partagé ce parcours avec nous.']};
 const [subject,body]=copy[kind];
 return {to:[state.email],subject,html:`<div style="font-family:Arial,sans-serif;line-height:1.6;color:#3D3860"><h1>Holistica Club</h1><p>Bonjour,</p><p>${body}</p><p>Pour gérer ton compte, modifier ou résilier ton abonnement, ou supprimer ton compte, connecte-toi à ton espace membre sur <a href="https://www.holisticaclub.com/accueil">le site Holistica</a>. Ces démarches se font uniquement sur le site internet, et non dans l’application.</p><p>À bientôt,<br>Maryne Arès</p><p data-holistica-email-footer="v1">Pour toute question, contactez-nous à : <a href="mailto:info@maryneares.fr">info@maryneares.fr</a><br>Merci de ne pas répondre directement à cet email.</p></div>`};
}
export async function handleTransformation({event,db,stripe,send,now=new Date()}){
 if(event.type==='charge.refunded'){
  const intent=id(event.data.object.payment_intent);if(!intent)return false;
  const sessions=await stripe.checkout.sessions.list({payment_intent:intent,limit:100});
  for(const session of sessions.data){
   if(session.mode!=='payment')continue;
   const state=await transformationState(stripe,{sessionId:session.id},now);
   if(state){await saveTransformation(db,state);return true;}
  }
  return false;
 }
 const obj=event.data.object,checkout=event.type.startsWith('checkout.session.');
 const subscriptionId=event.type.startsWith('customer.subscription.')?obj.id:id(obj.subscription||obj.parent?.subscription_details?.subscription);
 if(!subscriptionId&&!checkout)return false;
 if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed'].includes(event.type))return false;
 const state=await transformationState(stripe,{subscriptionId,sessionId:checkout?obj.id:null},now);
 if(!state)return false;
 if(state.sub)await stopAfterThreeMonths(stripe,state);
 await saveTransformation(db,state);
 // Welcome is also retried on invoice.paid: event order cannot lose it.
 if(state.status==='active')await send('transformation-welcome-'+state.order_id,transformationEmail('welcome',state));
 if(event.type==='invoice.paid'&&obj.amount_paid>0&&obj.billing_reason!=='subscription_create')await send('transformation-paid-'+obj.id,transformationEmail('paid',state));
 if(event.type==='invoice.payment_failed'&&['past_due','unpaid'].includes(state.status))await send('transformation-failed-'+obj.id+'-'+(obj.attempt_count||0),transformationEmail('failed',state));
 if(event.type==='customer.subscription.deleted'&&['canceled','expired'].includes(state.status))await send('transformation-ended-'+state.order_id,transformationEmail('ended',state));
 return true;
}
export async function expireTransformations({db,send,now=new Date()}){
 const orders=checked(await db.from('holistica_transformation_orders').select('*').lte('expires_at',now.toISOString()).in('status',['active','expired']).limit(1000))||[];
 for(const order of orders){
  checked(await db.from('holistica_transformation_orders').update({status:'expired'}).eq('order_id',order.order_id));
  // Only revoke the entitlement this order owns, never a later subscription.
  if(order.user_id)checked(await db.from('profiles').update({subscription_status:'inactive',mrr_amount:0}).eq('id',order.user_id).eq('transformation_order_id',order.order_id));
  await send('transformation-ended-'+order.order_id,transformationEmail('ended',order));
  checked(await db.from('holistica_transformation_orders').update({status:'ended'}).eq('order_id',order.order_id));
 }
 return {checked:orders.length};
}
