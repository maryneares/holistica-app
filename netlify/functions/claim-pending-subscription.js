// netlify/functions/claim-pending-subscription.js
//
// Appelée par l'app (et le site) à chaque connexion, pour "réclamer" un abonnement
// payé sur Stripe AVANT que la personne ait créé son compte dans l'app — ou dont
// l'email différait par la casse au moment du paiement (voir stripe-webhook.js).
//
// Le webhook Stripe écrit dans la table `pending_subscriptions` quand il ne trouve
// pas de profil correspondant au moment du paiement. Cette fonction fait le lien
// une fois que la personne est bien connectée : on sait alors avec certitude quel
// est son vrai compte (currentUser.id via le token Supabase), donc on peut appliquer
// l'abonnement en attente à son profil, sans dépendre uniquement de la correspondance
// par email.
//
// ═══════ MISE EN PLACE ═══════
// Variables d'environnement Netlify nécessaires :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Appelée en POST, avec un header "Authorization: Bearer <access_token Supabase>".
// Réponse : { applied: true, plan, status } ou { applied: false }.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Même normalisation que dans stripe-webhook.js : Supabase Auth met toujours
// l'email en minuscules, Stripe non — sans ça, le rattachement échoue silencieusement
// si la casse diffère ne serait-ce que d'une lettre.
function normEmail(email) {
  return (email || '').trim().toLowerCase() || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ applied: false, error: 'Méthode non autorisée' }) };
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ applied: false, error: 'Non authentifié' }) };
  }

  try {
    // Vérifie le token et récupère l'utilisateur Supabase correspondant, de façon
    // sûre côté serveur (on ne fait jamais confiance à un email envoyé depuis le front).
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return { statusCode: 401, body: JSON.stringify({ applied: false, error: 'Session invalide' }) };
    }

    const email = normEmail(user.email);
    if (!email) {
      return { statusCode: 200, body: JSON.stringify({ applied: false }) };
    }

    // Recherche insensible à la casse, pour couvrir le cas où l'email a été enregistré
    // par le webhook Stripe avec une casse différente de celle utilisée à l'inscription.
    const { data: pending, error: pendingError } = await supabase
      .from('pending_subscriptions')
      .select('*')
      .ilike('email', email)
      .maybeSingle();

    if (pendingError) {
      console.error('Erreur lecture pending_subscriptions:', pendingError.message);
      return { statusCode: 500, body: JSON.stringify({ applied: false, error: 'Erreur serveur' }) };
    }
    if (!pending) {
      return { statusCode: 200, body: JSON.stringify({ applied: false }) };
    }

    // Applique l'abonnement en attente au vrai profil de la personne connectée.
    const payload = {
      subscription_status: pending.subscription_status,
      subscription_plan: pending.subscription_plan,
      stripe_customer_id: pending.stripe_customer_id,
      stripe_subscription_id: pending.stripe_subscription_id,
      subscription_started_at: pending.subscription_started_at,
      trial_end: pending.trial_end,
      mrr_amount: pending.mrr_amount,
      payment_warning_sent_at: null,
      canceled_at: null,
      email: email,
    };

    const { error: updateError } = await supabase.from('profiles').update(payload).eq('id', user.id);
    if (updateError) {
      console.error('Erreur mise à jour du profil depuis pending_subscriptions:', updateError.message);
      return { statusCode: 500, body: JSON.stringify({ applied: false, error: 'Erreur serveur' }) };
    }

    // Nettoie l'entrée en attente une fois appliquée, pour ne jamais la réclamer deux fois.
    await supabase.from('pending_subscriptions').delete().eq('id', pending.id);

    return {
      statusCode: 200,
      body: JSON.stringify({
        applied: true,
        plan: pending.subscription_plan,
        status: pending.subscription_status,
      }),
    };
  } catch (err) {
    console.error('Erreur claim-pending-subscription:', err);
    return { statusCode: 500, body: JSON.stringify({ applied: false, error: 'Erreur interne' }) };
  }
};
