// netlify/functions/crm-campaigns.js
//
// Gère les campagnes en brouillon ou programmées (pas encore
// envoyées) : GET pour lister, POST pour créer/programmer, DELETE
// (avec ?id=...) pour annuler une campagne programmée.
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
      const { data, error } = await supabase
        .from('crm_campaigns')
        .select('id,subject,status,scheduled_at,sent_at,recipients_count,list_id,created_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ campaigns: data || [] }) };
    }

    if (event.httpMethod === 'POST') {
      const { listId, contactIds, subject, blocks, headerTag, scheduledAt } = JSON.parse(event.body || '{}');
      if ((!listId && !contactIds) || !subject || !blocks) {
        return { headers: CORS_HEADERS, statusCode: 400, body: JSON.stringify({ error: 'listId ou contactIds, subject et blocks sont requis' }) };
      }
      const status = scheduledAt ? 'scheduled' : 'draft';
      const { data, error } = await supabase.from('crm_campaigns').insert({
        list_id: listId || null,
        contact_ids: contactIds || null,
        subject,
        blocks,
        header_tag: headerTag || '',
        body_html: '', // généré au moment de l'envoi
        status,
        scheduled_at: scheduledAt || null
      }).select('id').single();
      if (error) throw error;
      return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ success: true, id: data.id, status }) };
    }

    if (event.httpMethod === 'DELETE') {
      const id = event.queryStringParameters?.id;
      if (!id) return { headers: CORS_HEADERS, statusCode: 400, body: JSON.stringify({ error: 'id manquant' }) };
      const { error } = await supabase.from('crm_campaigns').delete().eq('id', id).neq('status', 'sent');
      if (error) throw error;
      return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    return { headers: CORS_HEADERS, statusCode: 405, body: 'Method not allowed' };
  } catch (e) {
    console.error('Erreur crm-campaigns:', e);
    return { headers: CORS_HEADERS, statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
