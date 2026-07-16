const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
        await supabase
          .from('profiles')
          .update({ abonnement_actif: true, stripe_customer_id: session.customer })
          .eq('id', userId);
        break;
      }
      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        const actif = sub.status === 'active' || sub.status === 'trialing';
        await supabase
          .from('profiles')
          .update({ abonnement_actif: actif })
          .eq('stripe_customer_id', sub.customer);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        await supabase
          .from('profiles')
          .update({ abonnement_actif: false })
          .eq('stripe_customer_id', sub.customer);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        await supabase
          .from('profiles')
          .update({ abonnement_actif: false })
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