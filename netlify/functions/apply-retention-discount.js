// netlify/functions/apply-retention-discount.js
//
// Appelée quand une utilisatrice accepte l'offre "-50% sur le mois
// prochain" au lieu de résilier. Applique automatiquement une remise
// Stripe sur son PROCHAIN mois de facturation uniquement (pas les
// suivants), en s'appuyant sur son stripe_subscription_id enregistré
// dans Supabase.
//
// Variables d'environnement nécessaires (déjà présentes normalement) :
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY

const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { userId } = JSON.parse(event.body || '{}');
    if (!userId) return { statusCode: 400, body: JSON.stringify({ error: 'userId manquant' }) };

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('stripe_subscription_id,email')
      .eq('id', userId)
      .single();

    if (error || !profile?.stripe_subscription_id) {
      return { statusCode: 400, body: JSON.stringify({ error: "Aucun abonnement Stripe lié à ce compte." }) };
    }

    // Coupon réutilisable à -50%, valable une seule facture ("once").
    // Créé automatiquement s'il n'existe pas déjà (idempotent via l'id fixe).
    const couponId = 'retention-50-once';
    try {
      await stripe.coupons.retrieve(couponId);
    } catch {
      await stripe.coupons.create({
        id: couponId,
        percent_off: 50,
        duration: 'once',
        name: 'Offre de fidélité -50%',
      });
    }

    await stripe.subscriptions.update(profile.stripe_subscription_id, {
      coupon: couponId,
    });

    await supabase.from('profiles').update({
      retention_discount_applied_at: new Date().toISOString(),
    }).eq('id', userId);

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
