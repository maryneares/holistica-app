// netlify/functions/stripe-webhook.js
//
// Webhook Stripe pour Holistica Club.
// Reçoit les événements Stripe, met à jour Supabase (profiles), et envoie les emails
// correspondants via l'API Resend (pas besoin de repasser par les templates Supabase Auth,
// puisque ce sont des événements de paiement, pas des événements de connexion).
//
// ═══════ MISE EN PLACE (à faire une seule fois) ═══════
// 1. Dans ton projet : mkdir -p netlify/functions, puis place ce fichier dans ce dossier.
// 2. npm install stripe @supabase/supabase-js (à la racine du projet, avant déploiement).
// 3. Variables d'environnement à ajouter dans Netlify (Site settings > Environment variables) :
//    STRIPE_SECRET_KEY       (Stripe > Developers > API keys > Secret key)
//    STRIPE_WEBHOOK_SECRET   (donné après l'étape 4 ci-dessous)
//    SUPABASE_URL            (https://lsoddhgahdfcpmuydmbt.supabase.co)
//    SUPABASE_SERVICE_ROLE_KEY (Supabase > Settings > API > service_role — GARDE-LA SECRÈTE)
//    RESEND_API_KEY          (Resend > API keys)
// 4. Dans Stripe Dashboard > Developers > Webhooks > Add endpoint :
//    URL: https://TON-SITE.netlify.app/.netlify/functions/stripe-webhook
//    Événements à écouter : checkout.session.completed, invoice.payment_failed,
//    customer.subscription.deleted, customer.subscription.updated
// 5. Dans Stripe Dashboard > Settings > Billing > Subscriptions and emails > Manage failed payments :
//    règle le nombre de tentatives / délai pour que l'annulation finale arrive ~7 jours après
//    le premier échec (sinon le délai par défaut de Stripe peut être plus long).

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const FROM = '"Holistica Club - Maryne Arès" <bonjour@maryneares.fr>';

async function sendEmail(to, subject, html) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, html })
    });
  } catch (e) {
    console.error('Erreur envoi email:', e);
  }
}

function wrapEmail(title, bodyHtml) {
  return `<div style="background-color:#FAF8FF;padding:32px 16px;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(91,78,168,0.10);">
    <tr>
      <td style="background:linear-gradient(135deg,#5B4EA8,#7B6EC8,#C890C8);padding:40px 32px 32px;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">Holistica <span style="font-weight:400;opacity:.85;">Club</span></div>
        <div style="font-size:14px;color:rgba(255,255,255,0.85);margin-top:6px;">Prête à prendre soin de toi ?</div>
      </td>
    </tr>
    <tr><td style="padding:36px 32px 8px;">
      <div style="font-size:19px;font-weight:700;color:#1A1828;margin-bottom:14px;">${title}</div>
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:24px 32px 36px;">
      <div style="font-size:12px;color:#8A85A8;line-height:1.6;text-align:center;">Des questions ? Réponds directement à cet email.<br>À très vite sur Holistica Club 🪷</div>
    </td></tr>
  </table>
</div>`;
}

function planFromAmount(amountTotal) {
  // 29€ = Plan Équilibre, 49€ = Plan Immersion (montants en centimes)
  if (amountTotal >= 4000) return 'immersion';
  return 'equilibre';
}

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature Stripe invalide:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  try {
    switch (stripeEvent.type) {

      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const userId = session.client_reference_id;
        if (!userId) break;
        const plan = planFromAmount(session.amount_total);

        const { data: profile } = await supabase.from('profiles').select('email,name').eq('id', userId).maybeSingle();
        // La colonne profiles.email n'est remplie que si l'utilisatrice a édité son profil manuellement.
        // On va donc chercher l'email fiable directement sur le compte (rempli dès l'inscription).
        let recipientEmail = profile?.email;
        if (!recipientEmail) {
          const { data: authUser } = await supabase.auth.admin.getUserById(userId);
          recipientEmail = authUser?.user?.email;
        }

        const updatePayload = {
          subscription_status: 'active',
          subscription_plan: plan,
          stripe_customer_id: session.customer,
          payment_warning_sent_at: null
        };
        if (recipientEmail) updatePayload.email = recipientEmail;
        await supabase.from('profiles').update(updatePayload).eq('id', userId);

        if (recipientEmail) {
          const planLabel = plan === 'immersion' ? 'Plan Immersion (49€/mois)' : 'Plan Équilibre (29€/mois)';
          const extra = plan === 'immersion'
            ? `<div style="font-size:14px;line-height:1.7;color:#3D3860;margin-top:14px;">Ton accès au groupe WhatsApp privé est déjà actif — tu le trouveras directement dans l'onglet <b>Challenge</b> de l'app.</div>`
            : '';
          const html = wrapEmail('Bienvenue dans ton espace 🌸', `
            <div style="font-size:14px;line-height:1.7;color:#3D3860;">
              Merci ${profile?.name || ''} pour ta confiance ! Ton abonnement <b>${planLabel}</b> est actif dès maintenant.
              Toutes tes recettes, séances et ton suivi personnalisé t'attendent dans l'app.
            </div>${extra}
          `);
          await sendEmail(recipientEmail, 'Bienvenue dans ton espace Holistica Club 🌸', html);
        } else {
          console.error('Aucun email trouvé pour l\'utilisateur', userId);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        const customerId = invoice.customer;
        const { data: profile } = await supabase.from('profiles').select('id,email,name,payment_warning_sent_at').eq('stripe_customer_id', customerId).maybeSingle();
        if (!profile) break;

        await supabase.from('profiles').update({ subscription_status: 'past_due' }).eq('id', profile.id);

        // On n'envoie le mail d'avertissement "7 jours" qu'une seule fois par cycle d'échec,
        // pour ne pas spammer à chaque nouvelle tentative de prélèvement de Stripe.
        if (!profile.payment_warning_sent_at && profile.email) {
          const html = wrapEmail('Ton paiement a échoué ⚠️', `
            <div style="font-size:14px;line-height:1.7;color:#3D3860;">
              Nous n'avons pas pu prélever ton abonnement Holistica Club. Merci de vérifier ou mettre à jour ton moyen de paiement dès que possible.
            </div>
            <div style="font-size:14px;line-height:1.7;color:#3D3860;margin-top:10px;">
              <b>Sans mise à jour, ton accès sera automatiquement coupé dans 7 jours.</b>
            </div>
            ${invoice.hosted_invoice_url ? `<div style="text-align:center;margin-top:20px;"><a href="${invoice.hosted_invoice_url}" style="display:inline-block;background:#5B4EA8;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:14px;">Mettre à jour mon paiement</a></div>` : ''}
          `);
          await sendEmail(profile.email, 'Paiement échoué — 7 jours pour régulariser', html);
          await supabase.from('profiles').update({ payment_warning_sent_at: new Date().toISOString() }).eq('id', profile.id);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        const { data: profile } = await supabase.from('profiles').select('id,email,name').eq('stripe_customer_id', sub.customer).maybeSingle();
        if (!profile) break;

        await supabase.from('profiles').update({ subscription_status: 'cancelled', subscription_plan: null }).eq('id', profile.id);

        if (profile.email) {
          const html = wrapEmail('Ton accès a été suspendu', `
            <div style="font-size:14px;line-height:1.7;color:#3D3860;">
              Faute de paiement régularisé, ton accès à Holistica Club vient d'être suspendu. Tu peux te réabonner à tout moment directement depuis l'app pour retrouver tout ton suivi.
            </div>
          `);
          await sendEmail(profile.email, 'Ton accès Holistica Club a été suspendu', html);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        // Reprise de paiement après un échec : on redonne l'accès et on relance rien.
        if (sub.status === 'active') {
          const { data: profile } = await supabase.from('profiles').select('id').eq('stripe_customer_id', sub.customer).maybeSingle();
          if (profile) {
            await supabase.from('profiles').update({ subscription_status: 'active', payment_warning_sent_at: null }).eq('id', profile.id);
          }
        }
        break;
      }

      default:
        break;
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('Erreur traitement webhook:', err);
    return { statusCode: 500, body: 'Erreur interne' };
  }
};
