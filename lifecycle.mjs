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
import { sendOnce, EMAIL_FOOTER, ACCOUNT_EMAIL_NOTICE, MEMBER_SITE_URL } from './customer-flow.mjs';

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
        ${EMAIL_FOOTER}
      </div>
    </div>
  </div>`;
}

export function j14EquilibreEmail(name){
 return emailShell(`${name?name+', ':''}deux semaines avec Holistica`,
 `<p>Nous espérons que tes premières séances et routines te font du bien.</p><p>Si tu souhaites découvrir le Plan Immersion, retrouve les détails dans ton espace membre.</p>${ACCOUNT_EMAIL_NOTICE}`,
 'Accéder à mon espace membre',MEMBER_SITE_URL);
}
export function j14ImmersionEmail(name,streak,sessions){
 return emailShell(`${name?name+', ':''}deux semaines déjà`,
 `<p>Merci de faire partie du Plan Immersion. Avance à ton rythme et retrouve les échanges, les défis et les annonces de la conférence dans notre groupe Immersion.</p>`,
 'Retrouver mes séances',APP_URL);
}
export function churnEmail(name){
 return emailShell(`${name?'Bonjour '+name:'Bonjour'},`,
 `<p>Cela fait un moment que nous ne t’avons pas vue. Quand tu en auras envie, une courte séance suffit pour reprendre en douceur.</p><p>Nous sommes heureux de t’accompagner à ton rythme.</p>`,
 'Retrouver mes séances',APP_URL);
}

export async function runLifecycle({db=supabase,send=sendEmail,now=new Date()}={}) {
  const results = { j14_equilibre: 0, j14_immersion: 0, churn: 0, errors: [] };

  try {
    const { data: profiles, error } = await db
      .from('profiles')
      .select('id,email,name,subscription_started_at,login_dates,onboarding_j14_sent_at,churn_email_sent_at,subscription_status,subscription_plan,streak,sessions')
      .eq('subscription_status', 'active').in('subscription_plan',['equilibre','immersion']);

    if (error) throw error;

    for (const p of profiles || []) {
      if (!p.email) continue;
      const {data:auth,error:authError}=await db.auth.admin.getUserById(p.id);
      if(authError){results.errors.push('Compte non vérifié : '+p.id);continue;}
      if(!auth?.user?.email_confirmed_at||!auth.user.email)continue;
      p.email=auth.user.email;p.name=safeName(p.name);
      const createdAt = new Date(auth.user.created_at);
      if(isNaN(createdAt)){results.errors.push('Date d’inscription absente : '+p.id);continue;}
      const daysSinceSignup = Math.floor((now - createdAt) / 86400000);

      if (daysSinceSignup >= 14 && daysSinceSignup < 21 && !p.onboarding_j14_sent_at) {
        try {
          if (p.subscription_plan === 'immersion') {
            await send(p.email, 'Deux semaines déjà 🌸', j14ImmersionEmail(p.name, p.streak || 0, p.sessions || 0), 'j14-'+p.id);
            results.j14_immersion++;
          } else {
            await send(p.email, 'Deux semaines avec Holistica Club 🌿', j14EquilibreEmail(p.name), 'j14-'+p.id);
            results.j14_equilibre++;
          }
          const {error:stampError}=await db.from('profiles').update({ onboarding_j14_sent_at: now.toISOString() }).eq('id', p.id);if(stampError)throw stampError;
        } catch (e) { results.errors.push(`J14 ${p.id}: ${e.message}`); }
      }

      if(daysSinceSignup >= 14 && daysSinceSignup < 21 && !p.onboarding_j14_sent_at) continue;
      const loginDates = (p.login_dates || []).map(d => new Date(d)).filter(d => !isNaN(d));
      const lastLogin = loginDates.length ? new Date(Math.max(...loginDates)) : createdAt;
      const daysSinceLastLogin = Math.floor((now - lastLogin) / 86400000);
      const churnSentAt = p.churn_email_sent_at ? new Date(p.churn_email_sent_at) : null;
      const alreadySentForThisStreak = churnSentAt && churnSentAt > lastLogin;

      if (daysSinceLastLogin >= 20 && !alreadySentForThisStreak) {
        try {
          await send(p.email, 'On ne t\'a pas vue depuis un moment 🌙', churnEmail(p.name), 'return-'+p.id+'-'+lastLogin.toISOString());
          const {error:stampError}=await db.from('profiles').update({ churn_email_sent_at: now.toISOString() }).eq('id', p.id);if(stampError)throw stampError;
          results.churn++;
        } catch (e) { results.errors.push(`Churn ${p.id}: ${e.message}`); }
      }
    }

    return { statusCode: 200, body: JSON.stringify(results) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
