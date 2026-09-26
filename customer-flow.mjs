import {claimTransformation,handleTransformation} from './transformation.mjs';
export const APP_URL = 'https://app.holisticaclub.com';
export const ACCOUNT_URL = 'https://www.holisticaclub.com/?slug=mon-compte';
const ORIGINS = new Set([APP_URL, 'https://holistica-app.netlify.app', 'https://www.holisticaclub.com', 'https://holisticaclub.com', 'capacitor://localhost', 'http://localhost', 'https://localhost']);
export const emailOf = value => String(value || '').trim().toLowerCase();
export const idOf = value => typeof value === 'string' ? value : value?.id;
export function checked(result) { if (result.error) throw new Error('Database operation failed: ' + result.error.code); return result.data; }
export function planOf(product) {
  const name = String(product?.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (name.includes('transformation')) return null;
  if (name.includes('immersion')) return 'immersion';
  if (name.includes('equilibre')) return 'equilibre';
  return null;
}
export function response(req, status, body) {
  const headers = {'Content-Type':'application/json', 'Cache-Control':'no-store', 'Vary':'Origin'};
  if (ORIGINS.has(req.headers.get('origin'))) headers['Access-Control-Allow-Origin'] = req.headers.get('origin');
  headers['Access-Control-Allow-Headers'] = 'authorization,content-type';
  headers['Access-Control-Allow-Methods'] = 'POST,OPTIONS';
  return new Response(status === 204 ? null : JSON.stringify(body), {status, headers});
}
export function preflight(req) {
  if (req.headers.has('origin') && !ORIGINS.has(req.headers.get('origin'))) return response(req,403,{error:'Origine non autorisée'});
  if (req.method === 'OPTIONS') return response(req,204,null);
  if (req.method !== 'POST') return response(req,405,{error:'Méthode non autorisée'});
}
export async function authenticated(req, db) {
  const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return null;
  const {data,error} = await db.auth.getUser(token);
  if (error || !data?.user?.email_confirmed_at || !emailOf(data.user.email)) return null;
  return data.user;
}
export async function ensureProfile(db,user) {
  checked(await db.from('profiles').upsert({id:user.id,email:emailOf(user.email)}, {onConflict:'id',ignoreDuplicates:true}));
  const p = checked(await db.from('profiles').select('id,email,subscription_plan,stripe_customer_id,stripe_subscription_id').eq('id',user.id).single());
  if (!p) throw new Error('Profile not created');
  return p;
}
export async function subscriptionState(stripe,subId) {
  const sub = await stripe.subscriptions.retrieve(subId,{expand:['items.data.price.product']});
  const items = sub.items?.data || [];
  if (items.length !== 1) throw new Error('Subscription needs manual reconciliation');
  const item = items[0], price = item.price;
  const product = typeof price.product === 'string' ? await stripe.products.retrieve(price.product) : price.product;
  const plan = planOf(product);
  const customer = await stripe.customers.retrieve(idOf(sub.customer));
  const interval = price.recurring?.interval, count = price.recurring?.interval_count || 1;
  const months = interval === 'year' ? 12*count : interval === 'month' ? count : null;
  const active = ['active','trialing'].includes(sub.status);
  return {sub,plan,product,customer,email:emailOf(customer.deleted ? '' : customer.email),active,payload:{
    subscription_plan:plan,subscription_status:sub.status,stripe_customer_id:idOf(sub.customer),stripe_subscription_id:sub.id,
    subscription_started_at:new Date((sub.start_date||sub.created)*1000).toISOString(),
    trial_end:sub.trial_end ? new Date(sub.trial_end*1000).toISOString() : null,
    mrr_amount:active && months ? Math.round((price.unit_amount||0)*(item.quantity||1)/months)/100 : 0
  }};
}
export async function applyToProfile(db,stripe,profile,state) {
  if (profile.subscription_plan === 'transformation') throw new Error('Transformation is outside this flow');
  if (profile.stripe_subscription_id && profile.stripe_subscription_id !== state.sub.id) {
    const previous = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
    if (!['canceled','incomplete_expired'].includes(previous.status)) throw new Error('A different subscription is already linked');
  }
  let query=db.from('profiles').update({...state.payload,transformation_order_id:null,transformation_expires_at:null}).eq('id',profile.id);
  query=profile.stripe_subscription_id ? query.eq('stripe_subscription_id',profile.stripe_subscription_id) : query.is('stripe_subscription_id',null);
  const rows=checked(await query.select('id'));
  if (!rows?.length) throw new Error('Profile changed concurrently; retry');
  checked(await db.from('pending_subscriptions').delete().eq('stripe_subscription_id',state.sub.id));
}
export async function syncMembership(db,stripe,state) {
  let profile=checked(await db.from('profiles').select('id,subscription_plan,stripe_subscription_id').eq('stripe_subscription_id',state.sub.id).maybeSingle());
  if (!profile && state.active && state.email) {
    const pattern=state.email.replace(/[\\%_]/g, c=>'\\'+c);
    const candidate=checked(await db.from('profiles').select('id,subscription_plan,stripe_subscription_id').ilike('email',pattern).maybeSingle());
    if (candidate) {
      const {data,error}=await db.auth.admin.getUserById(candidate.id);
      if (error) throw new Error('Unable to verify account');
      if (data?.user?.email_confirmed_at && emailOf(data.user.email)===state.email) profile=candidate;
    }
  }
  if (profile) return applyToProfile(db,stripe,profile,state);
  if (!state.active) {
    checked(await db.from('pending_subscriptions').update(state.payload).eq('stripe_subscription_id',state.sub.id));
    return;
  }
  if (!state.email) throw new Error('Missing customer email');
  const pending=checked(await db.from('pending_subscriptions').select('stripe_subscription_id,subscription_plan').eq('email',state.email).maybeSingle());
  if (pending && (pending.subscription_plan==='transformation' || pending.stripe_subscription_id!==state.sub.id)) throw new Error('Pending subscription conflict');
  checked(await db.from('pending_subscriptions').upsert({email:state.email,...state.payload},{onConflict:'email'}));
}
export function makeClaimHandler({db,stripe}) {
  return async req=>{
    const early=preflight(req);if(early)return early;
    try {
      const user=await authenticated(req,db);if(!user)return response(req,401,{error:'Connecte-toi avec une adresse e-mail confirmée.'});
      const profile=await ensureProfile(db,user);
      if(await claimTransformation({db,stripe,user}))return response(req,200,{applied:true,plan:'immersion',status:'active',profileReady:true});
      const pending=checked(await db.from('pending_subscriptions').select('*').eq('email',emailOf(user.email)).maybeSingle());
      const subId=profile.stripe_subscription_id || pending?.stripe_subscription_id;
      if(!subId)return response(req,200,{applied:false,profileReady:true});
      const state=await subscriptionState(stripe,subId);
      if(!state.plan)return response(req,200,{applied:false,profileReady:true});
      // A pending row is a hint, never proof of entitlement. Read Stripe and verify ownership.
      if(!profile.stripe_subscription_id && state.email!==emailOf(user.email))return response(req,409,{error:'L’adresse du paiement ne correspond pas à ton compte.'});
      await applyToProfile(db,stripe,profile,state);
      return response(req,200,{applied:true,plan:state.plan,status:state.sub.status,profileReady:true});
    }catch(e){console.error('Membership reconciliation failed',e.message);return response(req,503,{error:'Actualisation indisponible. Réessaie dans un instant.'});}
  };
}
export function makePortalHandler({db,stripe}) {
  return async req=>{
    const early=preflight(req);if(early)return early;
    try {
      const user=await authenticated(req,db);if(!user)return response(req,401,{error:'Connexion requise'});
      const profile=checked(await db.from('profiles').select('stripe_customer_id,stripe_subscription_id,transformation_order_id').eq('id',user.id).maybeSingle());
      if(profile?.transformation_order_id&&!profile.stripe_subscription_id)return response(req,409,{error:'Ton programme Transformation a été payé en une fois : aucun abonnement Transformation à résilier. Pour toute question, contacte info@maryneares.fr.'});
      if(!profile?.stripe_customer_id || !profile.stripe_subscription_id)return response(req,409,{error:'Actualise ton accès avant de gérer ton abonnement.'});
      const sub=await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
      if(idOf(sub.customer)!==profile.stripe_customer_id)throw new Error('Customer mismatch');
      const portal=await stripe.billingPortal.sessions.create({customer:profile.stripe_customer_id,return_url:ACCOUNT_URL});
      return response(req,200,{url:portal.url});
    }catch(e){console.error('Portal unavailable',e.message);return response(req,503,{error:'Le portail est momentanément indisponible.'});}
  };
}
export function makeDeleteHandler({db,deleteUser,mailer}) {
  return async req=>{
    const early=preflight(req);if(early)return early;
    try {
      const user=await authenticated(req,db);if(!user)return response(req,401,{error:'Connexion requise'});
      const result=await deleteUser(req.headers.get('authorization'));
      const data=await result.json();
      if(!result.ok || !data.success)return response(req,result.ok?502:result.status,{error:data.error||'Suppression non confirmée.'});
      let emailSent=false;
      try {
        await sendOnce(mailer,'account-deleted-'+user.id,{to:[user.email],subject:'Ton compte Holistica Club a été supprimé',html:withEmailFooter('<p>Bonjour,</p><p>La suppression de ton compte Holistica Club est confirmée.</p><p>Merci d’avoir fait partie de Holistica.</p>'+ACCOUNT_EMAIL_NOTICE)});
        emailSent=true;
      }catch(e){console.error('Deletion completed; confirmation email failed',e.message);}
      return response(req,200,{success:true,emailSent});
    }catch(e){console.error('Account deletion failed',e.message);return response(req,503,{error:'Suppression indisponible. Réessaie dans un instant.'});}
  };
}
const escapeHtml = value => String(value || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const MEMBER_SITE_URL='https://www.holisticaclub.com/accueil';
export const EMAIL_FOOTER='<p data-holistica-email-footer="v1" style="font-size:12px;line-height:1.6;color:#625878">Pour toute question, contactez-nous à : <a href="mailto:info@maryneares.fr">info@maryneares.fr</a><br>Merci de ne pas répondre directement à cet email.</p>';
export const ACCOUNT_EMAIL_NOTICE=`<p>Pour gérer ton compte, modifier ou résilier ton abonnement, ou supprimer ton compte, connecte-toi à ton espace membre sur <a href="${MEMBER_SITE_URL}">le site Holistica</a>. Ces démarches se font uniquement sur le site internet, et non dans l’application.</p>`;
export function withEmailFooter(html){
 if(html.includes('data-holistica-email-footer'))return html;
 return html.includes('</body>')?html.replace('</body>',EMAIL_FOOTER+'</body>'):html+EMAIL_FOOTER;
}
export function membershipEmail(kind,state,invoice) {
 const label=state.plan==='immersion'?'Immersion':'Équilibre';
 let subject,content;
 if(kind==='welcome'){
  const trial=state.sub.status==='trialing'&&state.sub.trial_end;
  subject=trial?'Ton essai Holistica Club a commencé':'Bienvenue dans Holistica Club';
  content=trial?`Ton essai du Plan ${label} est actif jusqu’au ${new Date(state.sub.trial_end*1000).toLocaleDateString('fr-FR',{timeZone:'Europe/Paris'})}.`:`Ton Plan ${label} est actif. Bienvenue !`;
  content+='<p>Utilise la même adresse e-mail que lors du paiement pour retrouver ton accès.</p>';
 }else if(kind==='paid'){
  subject='Paiement confirmé — Holistica Club';
  const amount=new Intl.NumberFormat('fr-FR',{style:'currency',currency:invoice.currency||'eur'}).format(invoice.amount_paid/100);
  content=`Ton paiement de ${escapeHtml(amount)} pour le Plan ${label} est confirmé. Merci pour ta confiance.`;
 }else if(kind==='failed'){
  subject='Ton paiement nécessite une vérification — Holistica Club';
  content='Ton dernier paiement n’a pas abouti. Connecte-toi à ton espace membre sur le site pour vérifier ton moyen de paiement et le statut de ton abonnement.';
 }else{
  subject='Fin de ton abonnement — Holistica Club';
  content=`Ton abonnement au Plan ${label} est terminé. Merci d’avoir partagé cette expérience avec nous. Ton compte reste disponible en mode découverte.`;
 }
 return {to:[state.email],subject,html:withEmailFooter(`<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;line-height:1.6;color:#3D3860"><h1>Holistica Club</h1><p>Bonjour,</p><p>${content}</p>${ACCOUNT_EMAIL_NOTICE}<p>À bientôt,<br>Maryne Arès</p></div>`)};
}
export async function sendOnce({db,fetcher,apiKey,from},key,message) {
  if(!apiKey)throw new Error('RESEND_API_KEY is missing');
  const payload={from,...message,html:withEmailFooter(message.html)};
  const delivery=checked(await db.rpc('claim_holistica_transactional_email',{p_key:key,p_payload:payload}));
  if(!delivery)return;
  try {
    const result=await fetcher('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(delivery),signal:AbortSignal.timeout(8000)});
    if(!result.ok)throw new Error(`Resend refused delivery (${result.status})`);
    const receipt=await result.json();if(!receipt.id)throw new Error('Resend receipt missing');
    checked(await db.from('holistica_transactional_emails').update({sent_at:new Date().toISOString(),resend_id:receipt.id,lease_until:null,payload:{}}).eq('delivery_key',key));
  }catch(e){
    checked(await db.from('holistica_transactional_emails').update({lease_until:null}).eq('delivery_key',key).is('sent_at',null));
    throw e;
  }
}
export function makeWebhookHandler({db,stripe,secret,mailer,legacy}) {
  return async req=>{
    if(req.method!=='POST')return new Response('Method not allowed',{status:405});
    const raw=await req.text();let event;
    try{event=stripe.webhooks.constructEvent(raw,req.headers.get('stripe-signature')||'',secret);}catch{return new Response('Invalid signature',{status:400});}
    try {
      if(await handleTransformation({event,db,stripe,send:(key,message)=>sendOnce(mailer,key,message)}))return Response.json({received:true});
      const obj=event.data.object;
      const supported=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed'];
      if(!supported.includes(event.type))return Response.json({received:true});
      const subId=event.type.startsWith('customer.subscription.')?obj.id:idOf(obj.subscription||obj.parent?.subscription_details?.subscription);
      if(!subId)return Response.json({received:true});
      const state=await subscriptionState(stripe,subId);
      if(!state.plan)return Response.json({received:true});
      await syncMembership(db,stripe,state);
      let kind,key;
      if(['checkout.session.completed','checkout.session.async_payment_succeeded','customer.subscription.created'].includes(event.type)&&state.active){kind='welcome';key=`welcome-${subId}`;}
      if(event.type==='invoice.paid'&&obj.amount_paid>0){kind='paid';key=`paid-${obj.id}`;}
      if(event.type==='invoice.payment_failed'&&['past_due','unpaid'].includes(state.sub.status)){kind='failed';key=`failed-${obj.id}-${obj.attempt_count||0}`;}
      if(event.type==='customer.subscription.deleted'&&state.sub.status==='canceled'){kind='ended';key=`ended-${subId}`;}
      if(kind){if(!state.email)throw new Error('Recipient missing');await sendOnce(mailer,key,membershipEmail(kind,state,obj));}
      return Response.json({received:true});
    }catch(e){console.error('Stripe processing failed',event.id,e.message);return Response.json({error:'Temporary processing failure'},{status:500});}
  };
}
