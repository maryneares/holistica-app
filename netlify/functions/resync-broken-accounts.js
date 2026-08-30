// netlify/functions/resync-broken-accounts.js
//
// ═══════ USAGE UNIQUE, PUIS À SUPPRIMER ═══════
// Corrige TOUS les comptes déjà bloqués par le bug PayPal (paiement fait, compte créé,
// mais subscription_status resté "inactive" faute de rattachement correct).
//
// Fonctionnement : pour chaque profil "inactif" ayant un stripe_customer_id (même
// partiel ou correct), ou en cherchant par email dans Stripe directement, récupère le
// VRAI statut d'abonnement actuel directement depuis Stripe, et corrige Supabase.
//
// MARCHE À SUIVRE :
// 1. Place ce fichier dans netlify/functions/, à côté de stripe-webhook.js
// 2. Ajoute la variable d'environnement RESYNC_SECRET dans Netlify (un mot de passe
//    que tu inventes toi-même).
// 3. Déploie (GitHub push).
// 4. Visite une seule fois :
//    https://TON-SITE.netlify.app/.netlify/functions/resync-broken-accounts?secret=TON_MOT_DE_PASSE
// 5. Regarde le résultat (combien de comptes corrigés, lesquels).
// 6. SUPPRIME ce fichier de ton dépôt une fois terminé (sécurité).

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function planFromAmount(amount) {
  if (amount >= 4000) return 'immersion';
  return 'equilibre';
}
function mrrFromAmount(amount) {
  if (amount > 10000) return Math.round((amount / 100 / 12) * 100) / 100;
  return amount / 100;
}

exports.handler = async (event) => {
  const providedSecret = event.queryStringParameters?.secret;
  if (!providedSecret || providedSecret !== process.env.RESYNC_SECRET) {
    return { statusCode: 401, body: 'Non autorisé.' };
  }

  const results = { corrected: [], alreadyOk: 0, noStripeMatch: [], errors: [] };

  try {
    // Récupère tous les comptes qui semblent bloqués (jamais activés).
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, email, name, subscription_status, stripe_customer_id')
      .or('subscription_status.is.null,subscription_status.eq.inactive');

    if (error) throw error;

    for (const profile of profiles) {
      let email = profile.email;
      if (!email) {
        const { data: authUser } = await supabase.auth.admin.getUserById(profile.id);
        email = authUser?.user?.email;
      }
      if (!email) continue;

      // Cherche le client Stripe correspondant, par ID déjà connu ou par email.
      let customer = null;
      if (profile.stripe_customer_id) {
        try { customer = await stripe.customers.retrieve(profile.stripe_customer_id); } catch (e) {}
      }
      if (!customer) {
        const found = await stripe.customers.list({ email, limit: 1 });
        customer = found.data[0] || null;
      }
      if (!customer) {
        results.noStripeMatch.push({ email });
        continue;
      }

      // Cherche son abonnement le plus récent (actif, en essai, ou en retard de paiement).
      const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 5 });
      const relevant = subs.data.find(s => ['trialing', 'active', 'past_due'].includes(s.status));
      if (!relevant) {
        results.noStripeMatch.push({ email, reason: 'aucun abonnement actif trouvé chez Stripe' });
        continue;
      }

      const amount = relevant.items?.data?.[0]?.price?.unit_amount || 0;
      const plan = planFromAmount(amount);
      const status = relevant.status === 'trialing' ? 'trialing' : (relevant.status === 'past_due' ? 'past_due' : 'active');
      const trialEnd = relevant.trial_end ? new Date(relevant.trial_end * 1000).toISOString() : null;

      const { error: updateError } = await supabase.from('profiles').update({
        subscription_status: status,
        subscription_plan: plan,
        stripe_customer_id: customer.id,
        stripe_subscription_id: relevant.id,
        subscription_started_at: new Date(relevant.created * 1000).toISOString(),
        mrr_amount: mrrFromAmount(amount),
        trial_end: trialEnd,
        email: email,
      }).eq('id', profile.id);

      if (updateError) {
        results.errors.push({ email, error: updateError.message });
      } else {
        results.corrected.push({ email, plan, status });
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(results, null, 2),
    };
  } catch (err) {
    return { statusCode: 500, body: 'Erreur : ' + err.message };
  }
};
