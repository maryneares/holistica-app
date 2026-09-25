// netlify/functions/send-lifecycle-emails.js
//
// Fonction déclenchée automatiquement une fois par jour. Elle envoie
// UNIQUEMENT deux types d'emails, jamais aux utilisatrices très
// actives sans raison :
//
//   1) J+14 après inscription (une seule fois, à TOUTES les
//      abonnées actives) :
//        - Plan Équilibre → petit bilan + présentation du Plan
//          Immersion (communauté, plan alimentaire personnalisé,
//          challenges bonus)
//        - Plan Immersion → petit bilan + message de motivation
//          basé sur son activité réelle dans l'app (séries, séances)
//
//   2) Relance anti-churn : UNIQUEMENT si 20 jours sans connexion,
//      quel que soit le plan. Ne part jamais à quelqu'un d'actif.
//      Peut se redéclencher si la personne revient puis repart.
//
// Variables d'environnement nécessaires (Netlify → Site settings →
// Environment variables) : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// RESEND_API_KEY

import { createClient } from '@supabase/supabase-js';
import { sendOnce } from './customer-flow.mjs';

const supabase = createClient(
  Netlify.env.get('SUPABASE_URL'),
  Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY')
);

const RESEND_API_KEY = Netlify.env.get('RESEND_API_KEY');
const FROM_EMAIL = Netlify.env.get('TRANSACTIONAL_FROM') || 'Holistica Club - Maryne Arès <info@maryneares.fr>';
const APP_URL = 'https://app.holisticaclub.com';

async function sendEmail(to,subject,html,key) {
  await sendOnce({db:supabase,fetcher:fetch,apiKey:RESEND_API_KEY,from:FROM_EMAIL},key,{to:[to],subject,html});
}
function safeName(value){return String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

function emailShell(title, bodyHtml, ctaLabel, ctaUrl) {
  return `
  <div style="background:#FAF8FF;padding:32px 16px;font-family:Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:white;border-radius:20px;overflow:hidden;box-shadow:0 6px 30px rgba(91,78,168,0.12);">
      <div style="background:linear-gradient(145deg,#7B6EC8,#C890C8);padding:36px 28px;text-align:center;">
        <div style="font-size:28px;font-weight:800;color:white;letter-spacing:.5px;">Holistica Club</div>
      </div>
      <div style="padding:28px;">
        <h1 style="font-size:19px;color:#1A1828;margin:0 0 14px;">${title}</h1>
        <div style="font-size:14px;color:#3D3860;line-height:1.6;">${bodyHtml}</div>
        ${ctaLabel ? `
        <div style="text-align:center;margin-top:26px;">
          <a href="${ctaUrl}" style="display:inline-block;background:linear-gradient(145deg,#7B6EC8,#C890C8);color:white;text-decoration:none;font-weight:700;font-size:14px;padding:14px 28px;border-radius:14px;">${ctaLabel}</a>
        </div>` : ''}
      </div>
      <div style="padding:16px 28px 24px;text-align:center;font-size:11px;color:#8A85A8;">
        Holistica Club — <a href="${APP_URL}" style="color:#8A85A8;">app.holisticaclub.com</a>
      </div>
    </div>
  </div>`;
}

function j14EquilibreEmail(name) {
  return emailShell(
    `${name ? name + ', d' : 'D'}eux semaines avec Holistica Club 🌿`,
    `<p>Comment te sens-tu depuis que tu as commencé ? On espère que tu as pu explorer tranquillement ton profil Ayurvédique et tes premières séances.</p>
     <p>Si tu veux aller plus loin, le <strong>Plan Immersion</strong> ajoute :</p>
     <ul style="padding-left:18px;">
       <li>🤝 La communauté privée (groupe Immersion, conférence mensuelle avec Maryne)</li>
       <li>🥗 Un <strong>plan alimentaire personnalisé</strong> selon ton profil Ayurvédique — perte de masse grasse, maintien de la masse musculaire, soutien du cycle hormonal, sans gluten ni lactose, anti-inflammatoire</li>
       <li>🏆 Des challenges bonus chaque mois</li>
     </ul>
     <p>Tu peux consulter les possibilités de changement de formule dans ton espace abonnement.</p>`,
    'Découvrir le Plan Immersion',
    'https://www.holisticaclub.com/?slug=mon-compte'
  );
}

function j14ImmersionEmail(name, streak, sessions) {
  const streakLine = streak > 0
    ? `<p>Tu es déjà à <strong>${streak} jour${streak>1?'s':''} d'affilée</strong> — continue comme ça, c'est cette régularité qui fait la différence 💜</p>`
    : `<p>Le plus dur est déjà fait : tu as commencé. La régularité vient ensuite, petit à petit.</p>`;
  const sessionsLine = sessions > 0
    ? `<p>${sessions} séance${sessions>1?'s':''} complétée${sessions>1?'s':''} depuis ton arrivée — bravo pour ce cap !</p>`
    : `<p>N'hésite pas à te lancer sur une première séance courte aujourd'hui, même 10 minutes comptent.</p>`;
  return emailShell(
    `${name ? name + ', d' : 'D'}eux semaines déjà 🌸`,
    `<p>Merci de faire partie du Plan Immersion depuis deux semaines maintenant.</p>
     ${streakLine}
     ${sessionsLine}
     <p>Retrouve les échanges, les annonces et les informations sur la conférence mensuelle dans notre groupe Immersion.</p>`,
    'Retourner sur l\'app',
    APP_URL
  );
}

function churnEmail(name) {
  return emailShell(
    `${name ? 'On ne t\'a pas vue, ' + name : 'On ne t\'a pas vue'} depuis un moment 🌙`,
    `<p>Tout va bien ? Ça fait quelques semaines qu'on ne t'a pas vue sur Holistica Club.</p>
     <p>Pas besoin de tout reprendre d'un coup : une séance de 10 minutes ou un coup d'œil à ton profil Ayurvédique du jour suffit pour te reconnecter en douceur.</p>`,
    'Je reprends 5 minutes',
    APP_URL
  );
}

export async function runLifecycle() {
  const now = new Date();
  const results = { j14_equilibre: 0, j14_immersion: 0, churn: 0, errors: [] };

  try {
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id,email,name,created_at,login_dates,onboarding_j14_sent_at,churn_email_sent_at,subscription_status,subscription_plan,streak,sessions')
      .eq('subscription_status', 'active').in('subscription_plan',['equilibre','immersion']);

    if (error) throw error;

    for (const p of profiles || []) {
      if (!p.email) continue;
      p.name=safeName(p.name);
      const createdAt = new Date(p.created_at);
      const daysSinceSignup = Math.floor((now - createdAt) / 86400000);

      if (daysSinceSignup >= 14 && daysSinceSignup < 21 && !p.onboarding_j14_sent_at) {
        try {
          if (p.subscription_plan === 'immersion') {
            await sendEmail(p.email, 'Deux semaines déjà 🌸', j14ImmersionEmail(p.name, p.streak || 0, p.sessions || 0), 'j14-'+p.id);
            results.j14_immersion++;
          } else {
            await sendEmail(p.email, 'Deux semaines avec Holistica Club 🌿', j14EquilibreEmail(p.name), 'j14-'+p.id);
            results.j14_equilibre++;
          }
          await supabase.from('profiles').update({ onboarding_j14_sent_at: now.toISOString() }).eq('id', p.id);
        } catch (e) { results.errors.push(`J14 ${p.email}: ${e.message}`); }
      }

      const loginDates = (p.login_dates || []).map(d => new Date(d)).filter(d => !isNaN(d));
      const lastLogin = loginDates.length ? new Date(Math.max(...loginDates)) : createdAt;
      const daysSinceLastLogin = Math.floor((now - lastLogin) / 86400000);
      const churnSentAt = p.churn_email_sent_at ? new Date(p.churn_email_sent_at) : null;
      const alreadySentForThisStreak = churnSentAt && churnSentAt > lastLogin;

      if (daysSinceLastLogin >= 20 && !alreadySentForThisStreak) {
        try {
          await sendEmail(p.email, 'On ne t\'a pas vue depuis un moment 🌙', churnEmail(p.name), 'return-'+p.id+'-'+lastLogin.toISOString());
          await supabase.from('profiles').update({ churn_email_sent_at: now.toISOString() }).eq('id', p.id);
          results.churn++;
        } catch (e) { results.errors.push(`Churn ${p.email}: ${e.message}`); }
      }
    }

    return { statusCode: 200, body: JSON.stringify(results) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
