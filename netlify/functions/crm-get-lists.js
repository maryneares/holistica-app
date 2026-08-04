// netlify/functions/crm-get-lists.js
//
// Renvoie soit toutes les listes avec leur nombre de contacts (par
// défaut), soit le détail des contacts d'une liste précise si un
// listId est fourni en query string (?listId=...).
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
    const listId = event.queryStringParameters?.listId;

    if (listId) {
      const { data, error } = await supabase
        .from('crm_list_contacts')
        .select('crm_contacts(id,email,first_name,last_name)')
        .eq('list_id', listId);
      if (error) throw error;
      const contacts = (data || []).map(row => row.crm_contacts);
      return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ contacts }) };
    }

    const { data: lists, error } = await supabase.from('crm_lists').select('id,name,created_at').order('created_at', { ascending: false });
    if (error) throw error;

    // Compte les contacts par liste
    const results = [];
    for (const l of lists || []) {
      const { count } = await supabase.from('crm_list_contacts').select('*', { count: 'exact', head: true }).eq('list_id', l.id);
      results.push({ ...l, contactCount: count || 0 });
    }

    return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ lists: results }) };
  } catch (e) {
    console.error('Erreur crm-get-lists:', e);
    return { headers: CORS_HEADERS, statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
