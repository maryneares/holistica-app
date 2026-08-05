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
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    const listId = event.queryStringParameters?.listId;
    const allContacts = event.queryStringParameters?.allContacts;

    if (event.httpMethod === 'POST') {
      const { createListName, addToListId, contactIds } = JSON.parse(event.body || '{}');

      if (addToListId && contactIds?.length) {
        const links = contactIds.map(contactId => ({ list_id: addToListId, contact_id: contactId }));
        const { error } = await supabase.from('crm_list_contacts').upsert(links, { onConflict: 'list_id,contact_id' });
        if (error) throw error;
        return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ success: true, added: links.length }) };
      }

      if (createListName) {
        const { data, error } = await supabase.from('crm_lists').insert({ name: createListName, nom: createListName }).select('id').single();
        if (error) throw error;
        return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ success: true, id: data.id }) };
      }

      return { headers: CORS_HEADERS, statusCode: 400, body: JSON.stringify({ error: 'createListName ou (addToListId + contactIds) requis' }) };
    }

    if (allContacts) {
      const { data, error } = await supabase
        .from('crm_contacts')
        .select('id,email,first_name,last_name,blocked')
        .order('email', { ascending: true });
      if (error) throw error;
      return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ contacts: data || [] }) };
    }

    if (listId) {
      const { data, error } = await supabase
        .from('crm_list_contacts')
        .select('added_at,crm_contacts(id,email,first_name,last_name,created_at,blocked)')
        .eq('list_id', listId);
      if (error) throw error;
      const contacts = (data || []).map(row => ({ ...row.crm_contacts, added_at: row.added_at }));
      return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ contacts }) };
    }

    if (event.httpMethod === 'PATCH') {
      const { contactId, blocked } = JSON.parse(event.body || '{}');
      if (!contactId || typeof blocked !== 'boolean') {
        return { headers: CORS_HEADERS, statusCode: 400, body: JSON.stringify({ error: 'contactId et blocked (booléen) requis' }) };
      }
      const { error } = await supabase.from('crm_contacts').update({ blocked }).eq('id', contactId);
      if (error) throw error;
      return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    if (event.httpMethod === 'DELETE') {
      const delListId = event.queryStringParameters?.listId;
      if (!delListId) return { headers: CORS_HEADERS, statusCode: 400, body: JSON.stringify({ error: 'listId manquant' }) };
      // Supprime d'abord les liaisons (au cas où la contrainte cascade ne serait pas active),
      // puis la liste elle-même. Les contacts eux-mêmes (crm_contacts) ne sont PAS supprimés,
      // seulement retirés de cette liste précise.
      await supabase.from('crm_list_contacts').delete().eq('list_id', delListId);
      const { error } = await supabase.from('crm_lists').delete().eq('id', delListId);
      if (error) throw error;
      return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ success: true }) };
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
