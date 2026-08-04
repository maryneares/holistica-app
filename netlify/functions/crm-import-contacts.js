// netlify/functions/crm-import-contacts.js
//
// Reçoit une liste de contacts (déjà parsés côté CMS depuis le CSV)
// et le nom d'une liste (existante ou nouvelle). Crée les contacts
// s'ils n'existent pas encore (par email), et les rattache à la liste.
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

  if (event.httpMethod !== 'POST') {
    return { headers: CORS_HEADERS, statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { contacts, listName, listId } = JSON.parse(event.body || '{}');
    if (!Array.isArray(contacts) || !contacts.length) {
      return { headers: CORS_HEADERS, statusCode: 400, body: JSON.stringify({ error: 'Aucun contact reçu' }) };
    }

    // Récupère ou crée la liste
    let targetListId = listId;
    if (!targetListId) {
      if (!listName) return { headers: CORS_HEADERS, statusCode: 400, body: JSON.stringify({ error: 'Nom de liste manquant' }) };
      const { data: existing } = await supabase.from('crm_lists').select('id').eq('name', listName).maybeSingle();
      if (existing) {
        targetListId = existing.id;
      } else {
        const { data: created, error: createErr } = await supabase.from('crm_lists').insert({ name: listName, nom: listName }).select('id').single();
        if (createErr) throw createErr;
        targetListId = created.id;
      }
    }

    let imported = 0, linked = 0, skipped = 0;

    for (const c of contacts) {
      const email = (c.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) { skipped++; continue; }

      // Upsert du contact (créé s'il n'existe pas, ignoré sinon)
      const { data: contact, error: upsertErr } = await supabase
        .from('crm_contacts')
        .upsert({ email, first_name: c.first_name || null, last_name: c.last_name || null, prenom: c.first_name || null, nom: c.last_name || null }, { onConflict: 'email', ignoreDuplicates: false })
        .select('id')
        .single();
      if (upsertErr || !contact) { skipped++; continue; }
      imported++;

      // Rattache à la liste (ignore si déjà présent)
      const { error: linkErr } = await supabase
        .from('crm_list_contacts')
        .upsert({ list_id: targetListId, contact_id: contact.id }, { onConflict: 'list_id,contact_id' });
      if (!linkErr) linked++;
    }

    return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ success: true, listId: targetListId, imported, linked, skipped }) };
  } catch (e) {
    console.error('Erreur crm-import-contacts:', e);
    return { headers: CORS_HEADERS, statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
