// netlify/functions/send-upsell-emails.js
//
// Fonction PROGRAMMÉE (s'exécute automatiquement chaque jour, voir netlify.toml).
// Envoie l'email "Passe au Plan Immersion" aux clientes en Plan Équilibre depuis au
// moins 14 jours, qui ne l'ont jamais reçu. Ne dépend d'aucun événement Stripe précis,
// contrairement aux autres emails — c'est un envoi basé sur le temps écoulé.

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const FROM = '"Holistica Club - Maryne Arès" <bonjour@maryneares.fr>';
const DAYS_BEFORE_UPSELL = 14;

function wrapEmail(title, bodyHtml) {
  return `<div style="background-color:#FAF8FF;padding:32px 16px;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(91,78,168,0.10);">
    <tr>
      <td style="background:linear-gradient(135deg,#5B4EA8,#7B6EC8,#C890C8);padding:40px 32px 32px;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">Holistica <span style="font-weight:400;opacity:.85;">Club</span></div>
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

exports.handler = async () => {
  const cutoff = new Date(Date.now() - DAYS_BEFORE_UPSELL * 24 * 60 * 60 * 1000).toISOString();

  const { data: candidates, error } = await supabase
    .from('profiles')
    .select('id,email,name,created_at')
    .eq('subscription_status', 'active')
    .eq('subscription_plan', 'equilibre')
    .is('upsell_email_sent_at', null)
    .lte('created_at', cutoff);

  if (error) {
    console.error('Erreur récupération candidates upsell:', error);
    return { statusCode: 500, body: 'Erreur' };
  }
  if (!candidates || !candidates.length) {
    return { statusCode: 200, body: JSON.stringify({ sent: 0 }) };
  }

  let sentCount = 0;
  for (const profile of candidates) {
    if (!profile.email) continue;
    const html = wrapEmail('Prête à aller plus loin ? 🌸', `
      <div style="font-size:14px;line-height:1.7;color:#3D3860;">
        Bonjour ${profile.name || ''}, ça fait maintenant deux semaines que tu profites du Plan Équilibre — bravo pour ta régularité !
      </div>
      <div style="font-size:14px;line-height:1.7;color:#3D3860;margin-top:10px;">
        Le <b>Plan Immersion</b> t'ouvre en plus : la communauté WhatsApp privée, les challenges mensuels, une conférence live avec Maryne chaque mois, un cours en visio, et ton <b>plan alimentaire personnalisé</b> selon ton dosha.
      </div>
      <div style="text-align:center;margin-top:20px;">
        <a href="https://holisticaclub.com/" style="display:inline-block;background:#5B4EA8;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:14px;">Découvrir le Plan Immersion</a>
      </div>
    `);
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from: FROM, to: [profile.email], subject: 'Et si tu passais au Plan Immersion ? 🌸', html })
      });
      await supabase.from('profiles').update({ upsell_email_sent_at: new Date().toISOString() }).eq('id', profile.id);
      sentCount++;
    } catch (err) {
      console.error('Erreur envoi upsell pour', profile.id, err);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ sent: sentCount }) };
};
