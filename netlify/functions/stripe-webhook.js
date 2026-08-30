// netlify/functions/stripe-webhook.js
//
// Webhook Stripe pour Holistica Club — version corrigée pour bien gérer l'essai
// gratuit de 3 jours de bout en bout, avec les emails de confirmation à chaque étape.
//
// ═══════ ÉVÉNEMENTS ÉCOUTÉS (à activer dans Stripe Dashboard > Webhooks) ═══════
//   checkout.session.completed   → premier contact (infos initiales du client)
//   customer.subscription.created → démarrage réel de l'abonnement/essai (LE PLUS FIABLE)
//   customer.subscription.updated → changement de statut (fin d'essai, reprise, etc.)
//   customer.subscription.deleted → annulation (y compris pendant l'essai)
//   invoice.paid                  → paiement réel confirmé (fin d'essai réussie)
//   invoice.payment_failed        → échec de paiement
//
// ═══════ MISE EN PLACE ═══════
// Variables d'environnement Netlify nécessaires :
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY
//
// ═══════ CE QUI A CHANGÉ PAR RAPPORT À LA VERSION PRÉCÉDENTE ═══════
// - Ajout de customer.subscription.created : c'est l'événement le plus fiable pour
//   savoir qu'un essai démarre (checkout.session.completed peut arriver avant que
//   l'abonnement Stripe soit complètement formé).
// - subscription_status prend maintenant correctement la valeur 'trialing' pendant
//   l'essai (avant, tout était mis à 'active' même pendant l'essai, ce qui n'est pas
//   grave pour l'accès, mais empêchait le CMS de distinguer "en essai" / "payante").
// - Ajout de invoice.paid : confirme le VRAI paiement à la fin de l'essai, envoie un
//   email de confirmation différent de l'email de bienvenue initial.
// - Table de correspondance stricte : email + stripe_customer_id + stripe_subscription_id,
//   pour ne jamais créer de doublon si Stripe renvoie plusieurs fois le même événement.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const FROM = '"Holistica Club - Maryne Arès" <info@maryneares.fr>';

async function sendEmail(to, subject, html) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
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
      <div style="font-size:12px;color:#8A85A8;line-height:1.6;text-align:center;">Pour toute demande, envoie un email à <a href="mailto:info@maryneares.fr" style="color:#8A85A8;">info@maryneares.fr</a>.<br>Ne réponds pas directement à cet email automatique.<br>À très vite sur Holistica Club 🪷</div>
    </td></tr>
  </table>
</div>`;
}

function planFromAmount(amount) {
  // 29€ = Plan Équilibre, 49€ = Plan Immersion (montants en centimes)
  if (amount >= 4000) return 'immersion';
  return 'equilibre';
}

function mrrFromAmount(amount) {
  if (amount > 10000) return Math.round((amount / 100 / 12) * 100) / 100;
  return amount / 100;
}

// Retrouve (ou prépare) le profil correspondant à cet abonnement Stripe, en essayant
// dans l'ordre : identifiant direct, email déjà connu, puis abandon vers "en attente".
async function findProfile({ userId, email, stripeCustomerId }) {
  if (userId) {
    const { data } = await supabase.from('profiles').select('id,email,name').eq('id', userId).maybeSingle();
    if (data) return data;
  }
  if (stripeCustomerId) {
    const { data } = await supabase.from('profiles').select('id,email,name').eq('stripe_customer_id', stripeCustomerId).maybeSingle();
    if (data) return data;
  }
  if (email) {
    const { data } = await supabase.from('profiles').select('id,email,name').eq('email', email).maybeSingle();
    if (data) return data;
  }
  return null;
}

async function applySubscriptionUpdate({ profile, email, status, plan, stripeCustomerId, stripeSubscriptionId, trialEnd, mrr, isNew }) {
  const payload = {
    subscription_status: status,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    payment_warning_sent_at: null,
  };
  if (plan) payload.subscription_plan = plan;
  if (trialEnd !== undefined) payload.trial_end = trialEnd;
  if (mrr !== undefined) payload.mrr_amount = mrr;
  if (isNew) { payload.subscription_started_at = new Date().toISOString(); payload.canceled_at = null; }

  if (profile) {
    if (email && !profile.email) payload.email = email;
    await supabase.from('profiles').update(payload).eq('id', profile.id);
    return true;
  } else if (email) {
    // Aucun compte encore créé dans l'app : on garde l'abonnement de côté. Il sera
    // appliqué automatiquement dès que la personne se connecte (app OU site), qui
    // vérifient tous les deux pending_subscriptions au moment de la connexion.
    await supabase.from('pending_subscriptions').upsert({
      email,
      subscription_plan: plan,
      subscription_status: status,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      subscription_started_at: new Date().toISOString(),
      mrr_amount: mrr,
      trial_end: trialEnd,
    });
    return false;
  }
  return false;
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

      // ═══ Premier contact : récupère les infos initiales, mais ne fait pas
      // confiance à cet événement seul pour l'activation (voir subscription.created).
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const payerEmail = session.customer_details?.email || session.customer_email || null;
        const userId = session.client_reference_id;
        if (payerEmail || userId) {
          const profile = await findProfile({ userId, email: payerEmail, stripeCustomerId: session.customer });
          if (profile && session.customer) {
            await supabase.from('profiles').update({ stripe_customer_id: session.customer }).eq('id', profile.id);
          }
        }
        break;
      }

      // ═══ L'événement le plus fiable pour savoir qu'un essai (ou abonnement) démarre. ═══
      case 'customer.subscription.created': {
        const sub = stripeEvent.data.object;
        const amount = sub.items?.data?.[0]?.price?.unit_amount || 0;
        const plan = planFromAmount(amount);
        const status = sub.status === 'trialing' ? 'trialing' : 'active';
        const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
        const mrr = mrrFromAmount(amount);

        let customerEmail = null;
        try {
          const customer = await stripe.customers.retrieve(sub.customer);
          customerEmail = customer.email;
        } catch (e) { /* tant pis, on continue sans email direct */ }

        const profile = await findProfile({ email: customerEmail, stripeCustomerId: sub.customer });
        const applied = await applySubscriptionUpdate({
          profile, email: customerEmail, status, plan,
          stripeCustomerId: sub.customer, stripeSubscriptionId: sub.id,
          trialEnd, mrr, isNew: true,
        });

        const recipientEmail = profile?.email || customerEmail;
        if (recipientEmail) {
          const planLabel = plan === 'immersion' ? 'Plan Immersion' : 'Plan Équilibre';
          const planFeatures = plan === 'immersion'
            ? ['Accès complet à l\'application, recettes et séances vidéo', 'Suivi de cycle et bilan ayurvédique', 'Plan alimentaire personnalisé, mis à jour toutes les 2 semaines', 'Groupe WhatsApp privé, challenges et lives avec Maryne']
            : ['Accès complet à l\'application', 'Toutes les recettes et séances vidéo', 'Suivi de cycle et bilan ayurvédique', 'Recommandations personnalisées'];
          const trialDateFr = trialEnd ? new Date(trialEnd).toLocaleDateString('fr-FR', { day:'numeric', month:'long' }) : null;

          const html = wrapEmail('Ton essai gratuit commence 🌸', `
            <div style="font-size:14px;line-height:1.7;color:#3D3860;">
              Merci pour ta confiance ! Ton essai gratuit de 3 jours sur le <b>${planLabel}</b> commence aujourd'hui${trialDateFr ? `, jusqu'au <b>${trialDateFr}</b>` : ''}. Aucun prélèvement avant cette date.
            </div>

            <div style="background:#F4F0FB;border-radius:14px;padding:16px 18px;margin:18px 0;">
              <div style="font-size:13px;font-weight:700;color:#5B4EA8;text-transform:uppercase;letter-spacing:.3px;margin-bottom:8px;">Ce qui est inclus dans ton ${planLabel}</div>
              ${planFeatures.map(f => `<div style="font-size:13.5px;color:#3D3860;padding:4px 0;">✓ ${f}</div>`).join('')}
            </div>

            <div style="font-size:15px;font-weight:700;color:#1A1828;margin:22px 0 12px;">Tes prochaines étapes</div>

            <div style="font-size:14px;line-height:1.6;color:#3D3860;margin-bottom:14px;">
              <b>1. Télécharge l'app</b><br>
              — Sur <b>Android</b> : cherche "Holistica Club" sur le Google Play Store.<br>
              — Sur <b>iPhone</b> : l'app s'installe comme une icône sur ton écran d'accueil, directement depuis Safari (voir le tutoriel juste en dessous).
            </div>

            <div style="font-size:14px;line-height:1.6;color:#3D3860;margin-bottom:14px;">
              <b>2. Crée ton compte</b><br>
              Utilise <b>cette même adresse email</b> (${recipientEmail}) et choisis un mot de passe. Confirme ensuite ton compte via l'email de vérification que tu recevras.
            </div>

            <div style="font-size:14px;line-height:1.6;color:#3D3860;margin-bottom:20px;">
              <b>3. Réponds au questionnaire</b><br>
              Il personnalise entièrement ton espace : ton profil ayurvédique, tes routines, ton alimentation et tes séances.
            </div>

            <div style="text-align:center;margin:20px 0;">
              <a href="https://app.holisticaclub.com/" style="display:inline-block;background:#5B4EA8;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:14px;">Ouvrir l'app (iPhone / lien direct)</a>
            </div>
            <div style="text-align:center;margin-bottom:20px;">
              <a href="https://play.google.com/store/apps/details?id=com.holisticaclub.app2" style="color:#5B4EA8;font-weight:700;font-size:14px;text-decoration:underline;">Télécharger sur Google Play (Android)</a>
            </div>

            <div style="background:#FAF8FF;border:1px solid #EDE6FB;border-radius:14px;padding:16px 18px;margin-bottom:20px;">
              <div style="font-size:13px;font-weight:700;color:#5B4EA8;margin-bottom:10px;">📱 Comment installer sur iPhone (30 secondes)</div>
              <div style="font-size:13px;line-height:1.7;color:#3D3860;">
                1. Ouvre <a href="https://app.holisticaclub.com/" style="color:#5B4EA8;">app.holisticaclub.com</a> dans Safari<br>
                2. Appuie sur l'icône de partage (la flèche qui pointe vers le haut, en bas de l'écran)<br>
                3. Fais défiler et choisis <b>"Ajouter à l'écran d'accueil"</b><br>
                4. Confirme en appuyant sur <b>"Ajouter"</b> en haut à droite<br>
                5. Une icône Holistica Club apparaît sur ton écran d'accueil, exactement comme une vraie app — ton espace est prêt !
              </div>
            </div>

            <div style="border-top:1px solid #EDE6FB;padding-top:16px;">
              <div style="font-size:13.5px;font-weight:700;color:#1A1828;margin-bottom:6px;">Ton espace membre en ligne</div>
              <div style="font-size:13px;line-height:1.6;color:#8A85A8;">
                Retrouve à tout moment sur <a href="https://www.holisticaclub.com/" style="color:#5B4EA8;">holisticaclub.com</a> : la gestion de ton abonnement (changer de formule, annuler), ton profil ayurvédique complet, ton thème astral et tes factures.
              </div>
            </div>

            <div style="font-size:12.5px;line-height:1.6;color:#8A85A8;margin-top:16px;">Tu peux annuler à tout moment avant la fin de ton essai, sans aucun frais, directement depuis ton espace membre.</div>
          `);
          await sendEmail(recipientEmail, 'Ton essai gratuit Holistica Club commence 🌸', html);
        }
        break;
      }

      // ═══ Paiement réel confirmé (fin d'essai réussie, ou renouvellement). ═══
      case 'invoice.paid': {
        const invoice = stripeEvent.data.object;
        if (!invoice.subscription) break; // ignore les factures hors abonnement
        const profile = await findProfile({ stripeCustomerId: invoice.customer });
        if (!profile) break;

        await supabase.from('profiles').update({
          subscription_status: 'active',
          payment_warning_sent_at: null,
        }).eq('id', profile.id);

        // On n'envoie l'email "paiement confirmé" que pour un vrai montant prélevé
        // (pas pour une facture à 0€ générée pendant l'essai lui-même).
        if (profile.email && invoice.amount_paid > 0) {
          const montant = (invoice.amount_paid / 100).toFixed(2).replace('.', ',') + '€';
          const prochaine = invoice.lines?.data?.[0]?.period?.end
            ? new Date(invoice.lines.data[0].period.end * 1000).toLocaleDateString('fr-FR', { day:'numeric', month:'long' })
            : null;
          const html = wrapEmail('Ton abonnement est confirmé 🌸', `
            <div style="font-size:14px;line-height:1.7;color:#3D3860;">
              Ton paiement de <b>${montant}</b> a bien été effectué. Ton abonnement Holistica Club est maintenant actif${prochaine ? `, prochaine échéance le <b>${prochaine}</b>` : ''}.
            </div>
            ${invoice.hosted_invoice_url ? `<div style="text-align:center;margin-top:20px;"><a href="${invoice.hosted_invoice_url}" style="display:inline-block;background:#5B4EA8;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:14px;">Voir ma facture</a></div>` : ''}
          `);
          await sendEmail(profile.email, 'Paiement confirmé — Holistica Club', html);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        const profile = await findProfile({ stripeCustomerId: invoice.customer });
        if (!profile) break;

        const { data: current } = await supabase.from('profiles').select('payment_warning_sent_at').eq('id', profile.id).maybeSingle();
        await supabase.from('profiles').update({ subscription_status: 'past_due' }).eq('id', profile.id);

        if (!current?.payment_warning_sent_at && profile.email) {
          const html = wrapEmail('Action requise pour ton abonnement ⚠️', `
            <div style="font-size:14px;line-height:1.7;color:#3D3860;">Nous n'avons pas pu prélever ton abonnement Holistica Club. Merci de vérifier ou mettre à jour ton moyen de paiement dès que possible.</div>
            <div style="font-size:14px;line-height:1.7;color:#3D3860;margin-top:10px;"><b>Sans mise à jour, ton accès sera automatiquement coupé dans 3 jours.</b></div>
            ${invoice.hosted_invoice_url ? `<div style="text-align:center;margin-top:20px;"><a href="${invoice.hosted_invoice_url}" style="display:inline-block;background:#5B4EA8;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:14px;">Mettre à jour mon paiement</a></div>` : ''}
          `);
          await sendEmail(profile.email, 'Action requise pour ton abonnement Holistica Club', html);
          await supabase.from('profiles').update({ payment_warning_sent_at: new Date().toISOString() }).eq('id', profile.id);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        const profile = await findProfile({ stripeCustomerId: sub.customer });
        if (!profile) break;

        const { data: current } = await supabase.from('profiles').select('subscription_status').eq('id', profile.id).maybeSingle();
        const reason = sub.cancellation_details?.reason;
        const wasTrialing = current?.subscription_status === 'trialing';
        const isVoluntary = reason === 'cancellation_requested' || (!reason && current?.subscription_status === 'active');

        await supabase.from('profiles').update({
          subscription_status: 'cancelled', subscription_plan: null,
          canceled_at: new Date().toISOString(), mrr_amount: 0,
        }).eq('id', profile.id);

        if (profile.email) {
          const html = wasTrialing
            ? wrapEmail('Ton essai a été annulé', `<div style="font-size:14px;line-height:1.7;color:#3D3860;">Ton essai gratuit Holistica Club a bien été annulé, comme demandé. Aucun prélèvement n'aura lieu. Tu peux te réabonner à tout moment.</div>`)
            : isVoluntary
              ? wrapEmail('Ton abonnement a été annulé', `<div style="font-size:14px;line-height:1.7;color:#3D3860;">Ton abonnement Holistica Club a bien été annulé, comme demandé. Ton accès reste actif jusqu'à la fin de la période déjà payée.</div>`)
              : wrapEmail('Ton accès a été suspendu', `<div style="font-size:14px;line-height:1.7;color:#3D3860;">Faute de paiement régularisé, ton accès à Holistica Club vient d'être suspendu. Tu peux te réabonner à tout moment.</div>`);
          const subject = wasTrialing ? "Confirmation d'annulation de ton essai" : (isVoluntary ? "Confirmation d'annulation — Holistica Club" : 'Ton accès Holistica Club a été suspendu');
          await sendEmail(profile.email, subject, html);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        const profile = await findProfile({ stripeCustomerId: sub.customer });
        if (!profile) break;

        if (sub.status === 'active') {
          await supabase.from('profiles').update({ subscription_status: 'active', payment_warning_sent_at: null }).eq('id', profile.id);
        } else if (sub.status === 'trialing') {
          await supabase.from('profiles').update({ subscription_status: 'trialing' }).eq('id', profile.id);
        } else if (sub.status === 'past_due' || sub.status === 'unpaid') {
          await supabase.from('profiles').update({ subscription_status: 'past_due' }).eq('id', profile.id);
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
