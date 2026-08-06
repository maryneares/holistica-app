// netlify/functions/crm-forms.js
//
// Gère les formulaires côté admin : GET pour lister, POST pour
// créer/modifier, DELETE pour supprimer. Le rendu public et la
// réception des inscriptions se font dans crm-form-public.js.
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
      const { data, error } = await supabase.from('crm_forms').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ forms: data || [] }) };
    }

    if (event.httpMethod === 'POST') {
      const { id, name, blocks, targetListId, submitLabel, successMessage, headerTag } = JSON.parse(event.body || '{}');
      if (!name || !blocks || !targetListId) {
        return { headers: CORS_HEADERS, statusCode: 400, body: JSON.stringify({ error: 'name, blocks et targetListId sont requis' }) };
      }
      const row = {
        name,
        blocks,
        target_list_id: targetListId,
        submit_label: submitLabel || 'S\'inscrire',
        success_message: successMessage || 'Merci ! Ton inscription est confirmée.',
        header_tag: headerTag || ''
      };
      let result;
      if (id) {
        result = await supabase.from('crm_forms').update(row).eq('id', id).select('id').single();
      } else {
        result = await supabase.from('crm_forms').insert(row).select('id').single();
      }
      if (result.error) throw result.error;
      return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ success: true, id: result.data.id }) };
    }

    if (event.httpMethod === 'DELETE') {
      const id = event.queryStringParameters?.id;
      if (!id) return { headers: CORS_HEADERS, statusCode: 400, body: JSON.stringify({ error: 'id manquant' }) };
      const { error } = await supabase.from('crm_forms').delete().eq('id', id);
      if (error) throw error;
      return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    return { headers: CORS_HEADERS, statusCode: 405, body: 'Method not allowed' };
  } catch (e) {
    console.error('Erreur crm-forms:', e);
    return { headers: CORS_HEADERS, statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
