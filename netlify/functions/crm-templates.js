// netlify/functions/crm-templates.js
//
// Gère les templates d'emails réutilisables : GET pour lister,
// POST pour créer, DELETE (avec ?id=...) pour supprimer.
//
// Variables d'environnement nécessaires (déjà présentes) :
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    if (event.httpMethod === 'GET') {
      const { data, error } = await supabase.from('crm_templates').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ templates: data || [] }) };
    }

    if (event.httpMethod === 'POST') {
      const { name, subject, bodyHtml, blocks, headerTag } = JSON.parse(event.body || '{}');
      if (!name || (!bodyHtml && !blocks)) {
        return { headers: CORS_HEADERS, statusCode: 400, body: JSON.stringify({ error: 'name et (bodyHtml ou blocks) sont requis' }) };
      }
      const { data, error } = await supabase.from('crm_templates').insert({
        name,
        subject: subject || null,
        body_html: bodyHtml || null,
        blocks: blocks || null,
        header_tag: headerTag || ''
      }).select('id').single();
      if (error) throw error;
      return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ success: true, id: data.id }) };
    }

    if (event.httpMethod === 'DELETE') {
      const id = event.queryStringParameters?.id;
      if (!id) return { headers: CORS_HEADERS, statusCode: 400, body: JSON.stringify({ error: 'id manquant' }) };
      const { error } = await supabase.from('crm_templates').delete().eq('id', id);
      if (error) throw error;
      return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    return { headers: CORS_HEADERS, statusCode: 405, body: 'Method not allowed' };
  } catch (e) {
    console.error('Erreur crm-templates:', e);
    return { headers: CORS_HEADERS, statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
