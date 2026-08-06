// netlify/functions/crm-unsubscribe.js
//
// Fonction PUBLIQUE (aucune authentification) appelée quand un
// destinataire clique sur "Se désinscrire" dans un email. Marque
// le contact comme bloqué (exclu de tous les futurs envois) et
// affiche une page de confirmation.
//
// URL : https://app.holisticaclub.com/.netlify/functions/crm-unsubscribe?id=CONTACT_ID
//
// Variables d'environnement nécessaires (déjà présentes) :
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function page(title, message) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body{margin:0;padding:0;background:#FAF8FF;font-family:-apple-system,'Inter',Helvetica,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;}
  .card{max-width:420px;margin:20px;background:#FFFFFF;border-radius:24px;padding:40px 32px;box-shadow:0 8px 30px rgba(91,78,168,0.08);text-align:center;}
  .icon{width:56px;height:56px;background:#F3EFFC;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:26px;}
  h1{color:#5B4EA8;font-size:20px;font-style:italic;font-family:Georgia,serif;font-weight:400;margin:0 0 12px;}
  p{color:#6B6580;font-size:14.5px;line-height:22px;margin:0;}
</style>
</head>
<body>
<div class="card">
  <div class="icon">🌸</div>
  <h1>${title}</h1>
  <p>${message}</p>
</div>
</body>
</html>`;
}

exports.handler = async function (event) {
  const contactId = event.queryStringParameters?.id;

  if (!contactId) {
    return { statusCode: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: page('Lien invalide', "Ce lien de désinscription n'est pas valide.") };
  }

  try {
    const { error } = await supabase.from('crm_contacts').update({ blocked: true }).eq('id', contactId);
    if (error) throw error;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: page('Tu es bien désinscrite', "Tu ne recevras plus d'emails de notre part. Si c'était une erreur, contacte-nous à info@maryneares.fr.")
    };
  } catch (e) {
    console.error('Erreur crm-unsubscribe:', e);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: page('Une erreur est survenue', "Réessaie dans un instant, ou contacte-nous à info@maryneares.fr.")
    };
  }
};
