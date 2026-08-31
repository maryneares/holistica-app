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

// Détermine le plan via le vrai produit Stripe (fiable), avec repli sur les montants
// exacts connus si jamais la récupération du produit échoue — même logique que le
// webhook corrigé, pour éviter que l'offre de lancement à 39€ (Immersion) soit mal
// classée comme Équilibre, et qu'un abonnement annuel Équilibre (montant élevé) soit
// mal classé comme Immersion.
async function planFromPriceItem(priceItem) {
  try {
    const productId = typeof priceItem?.product === 'string' ? priceItem.product : priceItem?.product?.id;
    if (!productId) return planFromAmountFallback(priceItem?.unit_amount);
    const product = await stripe.products.retrieve(productId);
    const name = (product.name || '').toLowerCase();
    if (name.includes('immersion')) return 'immersion';
    if (name.includes('équilibre') || name.includes('equilibre')) return 'equilibre';
    return planFromAmountFallback(priceItem?.unit_amount);
  } catch (e) {
    return planFromAmountFallback(priceItem?.unit_amount);
  }
}
function planFromAmountFallback(amount) {
  const immersionAmounts = [4900, 3900, 47000];
  const equilibreAmounts = [2900, 27900];
  if (immersionAmounts.includes(amount)) return 'immersion';
  if (equilibreAmounts.includes(amount)) return 'equilibre';
  return amount >= 3500 ? 'immersion' : 'equilibre';
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

      const priceItem = sub.items?.data?.[0]?.price;
      const amount = priceItem?.unit_amount || 0;
      const plan = await planFromPriceItem(priceItem);
      const status = sub.status === 'trialing' ? 'trialing' : (sub.status === 'past_due' ? 'past_due' : 'active');
      const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
      const mrr = mrrFromAmount(amount);

      // Cherche D'ABORD le vrai compte Supabase Auth par email (la source de vérité
      // la plus fiable), PUIS son profil par identifiant — plutôt que l'inverse.
      // Cela couvre aussi le cas où un profil existe déjà mais avec une colonne
      // email vide ou différente (compte jamais mis à jour manuellement), qui
      // aurait été raté par une simple recherche de profil par email.
      const authUser = await findAuthUserByEmail(email);

      if (authUser) {
        const { data: profile } = await supabase.from('profiles').select('id,subscription_status,subscription_plan').eq('id', authUser.id).maybeSingle();

        if (profile) {
          const isAlreadyCorrect = profile.subscription_status === status && profile.subscription_plan === plan;
          if (isAlreadyCorrect) {
            results.alreadyOk.push({ email, plan, status });
            continue;
          }
          await supabase.from('profiles').update({
            subscription_status: status, subscription_plan: plan, email,
            stripe_customer_id: typeof customer === 'string' ? customer : customer.id,
            stripe_subscription_id: sub.id, mrr_amount: mrr, trial_end: trialEnd,
          }).eq('id', profile.id);
          results.corrected.push({ email, plan, status, avant: profile.subscription_status + ' (profil existant, email peut-être mal renseigné avant)' });
        } else {
          // Compte Auth trouvé, mais aucune ligne profils du tout : la crée.
          await supabase.from('profiles').upsert({
            id: authUser.id, email,
            subscription_status: status, subscription_plan: plan,
            stripe_customer_id: typeof customer === 'string' ? customer : customer.id,
            stripe_subscription_id: sub.id, mrr_amount: mrr, trial_end: trialEnd,
            subscription_started_at: new Date(sub.created * 1000).toISOString(),
          });
          results.corrected.push({ email, plan, status, avant: 'aucun profil existant (compte créé, jamais lié)' });
        }
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
