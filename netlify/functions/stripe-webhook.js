const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Détermine le plan à partir du montant payé (en centimes).
// Équilibre = 29€/mois, Immersion = 49€/mois.
function planFromAmount(amountInCents) {
  const euros = amountInCents / 100;
  if (euros <= 0) return { plan: 'inconnu', mrr: 0 };
  // On prend le prix de référence le plus proche pour absorber d'éventuels écarts (taxes, arrondis, essais)
  const distEquilibre = Math.abs(euros - 29);
  const distImmersion = Math.abs(euros - 49);
  if (distImmersion < distEquilibre) return { plan: 'immersion', mrr: 49 };
  return { plan: 'equilibre', mrr: 29 };
}

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Signature invalide :', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const userId = session.client_reference_id;

        // Récupère le prix réellement payé pour déterminer le plan
        let amount = session.amount_total || 0;
        let trialEnd = null;
        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          if (sub.items?.data?.[0]?.price?.unit_amount) {
            amount = sub.items.data[0].price.unit_amount;
          }
          if (sub.trial_end) trialEnd = new Date(sub.trial_end * 1000).toISOString();
        }
        const { plan, mrr } = planFromAmount(amount);

        await supabase
          .from('profiles')
          .update({
            abonnement_actif: true,
            stripe_customer_id: session.customer,
            plan,
            mrr_amount: mrr,
            subscription_status: trialEnd ? 'trialing' : 'active',
            trial_start: trialEnd ? new Date().toISOString() : null,
            trial_end: trialEnd,
            subscription_started_at: new Date().toISOString(),
            canceled_at: null,
          })
          .eq('id', userId);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        const actif = sub.status === 'active' || sub.status === 'trialing';
        const amount = sub.items?.data?.[0]?.price?.unit_amount || 0;
        const { plan, mrr } = planFromAmount(amount);

        await supabase
          .from('profiles')
          .update({
            abonnement_actif: actif,
            subscription_status: sub.status,
            plan,
            mrr_amount: actif ? mrr : 0,
            trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
            canceled_at: sub.status === 'canceled' ? new Date().toISOString() : null,
          })
          .eq('stripe_customer_id', sub.customer);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        await supabase
          .from('profiles')
          .update({
            abonnement_actif: false,
            subscription_status: 'canceled',
            mrr_amount: 0,
            canceled_at: new Date().toISOString(),
          })
          .eq('stripe_customer_id', sub.customer);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        await supabase
          .from('profiles')
          .update({
            abonnement_actif: false,
            subscription_status: 'past_due',
          })
          .eq('stripe_customer_id', invoice.customer);
        break;
      }
    }
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('Erreur traitement webhook :', err);
    return { statusCode: 500, body: 'Erreur serveur' };
  }
};
