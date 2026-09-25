import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
export const env = name => Netlify.env.get(name);
export function clients() {
  const db=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
  const stripe=new Stripe(env('STRIPE_SECRET_KEY'));
  return {db,stripe};
}
export function mailer(db) {return {db,fetcher:fetch,apiKey:env('RESEND_API_KEY'),from:env('TRANSACTIONAL_FROM')||'Holistica Club - Maryne Arès <info@maryneares.fr>'};}
