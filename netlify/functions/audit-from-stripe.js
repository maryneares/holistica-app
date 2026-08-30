// netlify/functions/audit-from-stripe.js
//
// ═══════ USAGE UNIQUE, PUIS À SUPPRIMER ═══════
// Contrairement à resync-broken-accounts.js (qui partait de Supabase pour chercher
// les comptes visiblement cassés), cet outil part de STRIPE, la vraie source de
// vérité : il liste TOUS les abonnements actifs/en essai/en retard de paiement
// existant chez Stripe, et vérifie pour CHACUN que Supabase est bien à jour —
// y compris les cas où le profil n'existe même pas du tout côté Supabase (pas
// seulement ceux visiblement marqués "inactif").
//
// MARCHE À SUIVRE :
// 1. Place ce fichier dans netlify/functions/, à côté des autres.
// 2. Réutilise la même variable d'environnement RESYNC_SECRET déjà en place.
// 3. Déploie (GitHub push).
// 4. Visite une seule fois :
//    https://app.holisticaclub.com/.netlify/functions/audit-from-stripe?secret=TON_MOT_DE_PASSE
// 5. Regarde le résultat : la liste complète de tous tes abonnements Stripe actifs,
//    avec pour chacun si Supabase est bien à jour ou non (et corrigé automatiquement
//    si un email correspondant existe dans Supabase Auth).
// 6. Supprime ce fichier une fois terminé (sécurité).

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

// Cherche un compte Supabase Auth par email (contrairement à la table profiles,
// auth.users existe dès la création du compte, même avant tout onboarding).
async function findAuthUserByEmail(email) {
  // Supabase n'offre pas de recherche directe par email sur auth.users côté admin API
  // en une seule requête simple : on liste par pages et on filtre. Pour un volume de
  // clientes encore raisonnable (lancement récent), c'est largement suffisant.
  let page = 1;
  while (page <= 20) { // sécurité : jamais plus de 20 pages (2000 comptes)
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (error || !data?.users?.length) break;
    const match = data.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (match) return match;
    if (data.users.length < 100) break; // dernière page atteinte
    page++;
  }
  return null;
}

exports.handler = async (event) => {
  const providedSecret = event.queryStringParameters?.secret;
  if (!providedSecret || providedSecret !== process.env.RESYNC_SECRET) {
    return { statusCode: 401, body: 'Non autorisé.' };
  }

  const results = { total: 0, alreadyOk: [], corrected: [], noSupabaseAccount: [], errors: [] };

  try {
    // Liste TOUS les abonnements Stripe pertinents (essai, actif, en retard).
    let allSubs = [];
    let startingAfter;
    for (let i = 0; i < 20; i++) { // sécurité : max 2000 abonnements
      const page = await stripe.subscriptions.list({
        status: 'all', limit: 100, starting_after: startingAfter, expand: ['data.customer'],
      });
      allSubs = allSubs.concat(page.data);
      if (!page.has_more) break;
      startingAfter = page.data[page.data.length - 1].id;
    }

    const relevantSubs = allSubs.filter(s => ['trialing', 'active', 'past_due'].includes(s.status));
    results.total = relevantSubs.length;

    for (const sub of relevantSubs) {
      const customer = sub.customer; // objet complet grâce à expand ci-dessus
      const email = typeof customer === 'object' ? customer.email : null;
      if (!email) {
        results.noSupabaseAccount.push({ stripeCustomerId: typeof customer === 'string' ? customer : customer.id, reason: 'aucun email sur le client Stripe' });
        continue;
      }

      const amount = sub.items?.data?.[0]?.price?.unit_amount || 0;
      const plan = planFromAmount(amount);
      const status = sub.status === 'trialing' ? 'trialing' : (sub.status === 'past_due' ? 'past_due' : 'active');
      const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
      const mrr = mrrFromAmount(amount);

      // Cherche d'abord un profil déjà existant (par email).
      const { data: profile } = await supabase.from('profiles').select('id,subscription_status,subscription_plan').eq('email', email).maybeSingle();

      if (profile) {
        const isAlreadyCorrect = profile.subscription_status === status && profile.subscription_plan === plan;
        if (isAlreadyCorrect) {
          results.alreadyOk.push({ email, plan, status });
          continue;
        }
        await supabase.from('profiles').update({
          subscription_status: status, subscription_plan: plan,
          stripe_customer_id: typeof customer === 'string' ? customer : customer.id,
          stripe_subscription_id: sub.id, mrr_amount: mrr, trial_end: trialEnd,
        }).eq('id', profile.id);
        results.corrected.push({ email, plan, status, avant: profile.subscription_status });
        continue;
      }

      // Aucun profil du tout : cherche si un compte Supabase Auth existe déjà
      // (créé dans l'app mais sans encore de ligne profiles), pour le lier directement.
      const authUser = await findAuthUserByEmail(email);
      if (authUser) {
        await supabase.from('profiles').upsert({
          id: authUser.id, email,
          subscription_status: status, subscription_plan: plan,
          stripe_customer_id: typeof customer === 'string' ? customer : customer.id,
          stripe_subscription_id: sub.id, mrr_amount: mrr, trial_end: trialEnd,
          subscription_started_at: new Date(sub.created * 1000).toISOString(),
        });
        results.corrected.push({ email, plan, status, avant: 'aucun profil existant (compte créé, jamais lié)' });
      } else {
        // Personne n'a encore créé de compte dans l'app avec cet email : on le
        // met en attente, comme le fait déjà normalement le webhook.
        await supabase.from('pending_subscriptions').upsert({
          email, subscription_plan: plan, subscription_status: status,
          stripe_customer_id: typeof customer === 'string' ? customer : customer.id,
          stripe_subscription_id: sub.id, mrr_amount: mrr, trial_end: trialEnd,
        });
        results.noSupabaseAccount.push({ email, plan, status, reason: 'aucun compte app créé pour l\'instant — mis en attente' });
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
