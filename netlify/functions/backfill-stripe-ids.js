// netlify/functions/backfill-stripe-ids.js
//
// ═══════ USAGE UNIQUE, PUIS À SUPPRIMER ═══════
// Cette fonction retrouve automatiquement l'identifiant client Stripe de chaque
// abonnée déjà existante (dont le stripe_customer_id est encore vide), en
// recherchant sur Stripe par adresse email, puis met à jour Supabase.
//
// MARCHE À SUIVRE :
// 1. Place ce fichier dans netlify/functions/, à côté de stripe-webhook.js
// 2. Ajoute la variable d'environnement BACKFILL_SECRET dans Netlify (un mot de passe
//    que tu inventes toi-même, ex: "rattrapage2026", pour que personne d'autre ne puisse
//    déclencher cette fonction en devinant l'URL).
// 3. Déploie (GitHub push, comme d'habitude).
// 4. Visite une seule fois dans ton navigateur :
//    https://TON-SITE.netlify.app/.netlify/functions/backfill-stripe-ids?secret=rattrapage2026
// 5. Regarde le résultat affiché (combien de comptes ont été mis à jour, lesquels n'ont pas été trouvés).
// 6. Une fois terminé, SUPPRIME ce fichier de ton dépôt (sécurité : mieux vaut ne pas laisser
//    traîner une fonction capable de modifier des comptes, même protégée par un mot de passe).

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  const providedSecret = event.queryStringParameters?.secret;
  if (!providedSecret || providedSecret !== process.env.BACKFILL_SECRET) {
    return { statusCode: 401, body: 'Non autorisé.' };
  }

  const results = { updated: [], notFound: [], alreadyOk: 0, errors: [] };

  try {
    // Récupère toutes les personnes abonnées (actives ou en essai) sans identifiant Stripe enregistré.
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, email, name, subscription_status, stripe_customer_id')
      .in('subscription_status', ['active', 'trialing', 'past_due']);

    if (error) throw error;

    for (const profile of profiles) {
      if (profile.stripe_customer_id) {
        results.alreadyOk++;
        continue;
      }

      let email = profile.email;
      if (!email) {
        const { data: authUser } = await supabase.auth.admin.getUserById(profile.id);
        email = authUser?.user?.email;
      }
      if (!email) {
        results.notFound.push({ id: profile.id, reason: 'aucun email trouvé' });
        continue;
      }

      const customers = await stripe.customers.list({ email, limit: 1 });
      if (customers.data.length === 0) {
        results.notFound.push({ id: profile.id, email, reason: 'aucun client Stripe avec cet email' });
        continue;
      }

      const customerId = customers.data[0].id;
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', profile.id);

      if (updateError) {
        results.errors.push({ id: profile.id, email, error: updateError.message });
      } else {
        results.updated.push({ id: profile.id, email, name: profile.name, stripe_customer_id: customerId });
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
