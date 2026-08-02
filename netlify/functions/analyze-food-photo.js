// netlify/functions/analyze-food-photo.js
//
// Reçoit une photo de repas (en base64), l'envoie à l'API Claude (vision)
// avec une consigne demandant d'identifier les aliments et d'estimer
// calories/protéines/glucides/lipides, et renvoie un résultat structuré
// que le formulaire "Ajouter un aliment" pré-remplit pour validation par
// l'utilisatrice (jamais d'ajout automatique sans confirmation).
//
// Variable d'environnement nécessaire : ANTHROPIC_API_KEY
// (Netlify > Site settings > Environment variables)

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { imageBase64, mediaType } = JSON.parse(event.body || '{}');
    if (!imageBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Aucune image reçue' }) };
    }

    const prompt = `Tu regardes une photo d'un repas. Identifie le ou les aliments présents et estime au mieux, pour la portion visible sur la photo :
- un nom court et clair pour l'ensemble du repas (en français)
- les calories totales (kcal)
- les protéines (g)
- les glucides (g)
- les lipides (g)

Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte avant ou après, au format exact :
{"name":"...", "cal":0, "p":0, "g":0, "l":0}

Si tu ne peux pas identifier de nourriture sur la photo, réponds avec :
{"error":"no_food_detected"}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('Erreur API Claude:', data);
      return { statusCode: 500, body: JSON.stringify({ error: 'Analyse indisponible pour le moment' }) };
    }

    const textBlock = (data.content || []).find(c => c.type === 'text');
    let parsed;
    try {
      const clean = (textBlock?.text || '').replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      return { statusCode: 200, body: JSON.stringify({ error: 'no_food_detected' }) };
    }

    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch (e) {
    console.error('Erreur analyze-food-photo:', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
