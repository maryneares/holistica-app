// netlify/functions/send-account-email.js
//
// Envoie un email transactionnel simple déclenché depuis l'app cliente (ex: confirmation
// de suppression de compte). Ne JAMAIS appeler l'API Resend directement depuis le navigateur —
// ça exposerait la clé secrète. Cette fonction fait le lien de façon sécurisée.
//
// Appelée par exemple ainsi depuis index.html :
//   fetch('/.netlify/functions/send-account-email', {
//     method: 'POST',
//     body: JSON.stringify({ type: 'account_deleted', email: '...', name: '...' })
//   });

const FROM = '"Holistica Club - Maryne Arès" <bonjour@maryneares.fr>';

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

const TEMPLATES = {
  account_deleted: (name) => ({
    subject: 'Ton compte Holistica Club a bien été supprimé',
    html: wrapEmail('Compte supprimé 🌸', `
      <div style="font-size:14px;line-height:1.7;color:#3D3860;">
        Bonjour ${name || ''}, ton compte et toutes tes données (profil, historique, progression) ont été définitivement supprimés, comme demandé.
      </div>
      <div style="font-size:14px;line-height:1.7;color:#3D3860;margin-top:10px;">
        Si c'était une erreur ou que tu changes d'avis, tu es toujours la bienvenue pour recréer un compte à tout moment.
      </div>
    `)
  }),
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  try {
    const { type, email, name } = JSON.parse(event.body || '{}');
    if (!type || !email || !TEMPLATES[type]) {
      return { statusCode: 400, body: 'Requête invalide' };
    }
    const { subject, html } = TEMPLATES[type](name);
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: FROM, to: [email], subject, html })
    });
    return { statusCode: 200, body: JSON.stringify({ sent: true }) };
  } catch (err) {
    console.error('Erreur send-account-email:', err);
    return { statusCode: 500, body: 'Erreur interne' };
  }
};
