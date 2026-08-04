// netlify/functions/crm-import-contacts.js
//
// Reçoit une liste de contacts (déjà parsés côté CMS depuis le CSV)
// et le nom d'une liste (existante ou nouvelle). Traite les contacts
// PAR LOTS (au lieu d'un par un) pour rester rapide même avec des
// fichiers de plusieurs centaines/milliers de contacts, et éviter
// le dépassement de temps limite d'exécution de la fonction.
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

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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

    // Nettoie et dédoublonne les emails reçus
    const seen = new Set();
    const cleanContacts = [];
    let skipped = 0;
    for (const c of contacts) {
      const email = (c.email || '').trim().toLowerCase();
      if (!email || !email.includes('@') || seen.has(email)) { skipped++; continue; }
      seen.add(email);
      cleanContacts.push({
        email,
        first_name: c.first_name || null,
        last_name: c.last_name || null,
        prenom: c.first_name || null,
        nom: c.last_name || null
      });
    }

    // ═══ Upsert des contacts PAR LOTS de 300 (au lieu d'un par un) ═══
    const contactBatches = chunk(cleanContacts, 300);
    let allContactIds = [];

    for (const batch of contactBatches) {
      const { data, error } = await supabase
        .from('crm_contacts')
        .upsert(batch, { onConflict: 'email', ignoreDuplicates: false })
        .select('id');
      if (error) throw error;
      allContactIds = allContactIds.concat((data || []).map(c => c.id));
    }

    // ═══ Rattachement à la liste PAR LOTS également ═══
    const links = allContactIds.map(contactId => ({ list_id: targetListId, contact_id: contactId }));
    const linkBatches = chunk(links, 500);
    let linked = 0;

    for (const batch of linkBatches) {
      const { error } = await supabase
        .from('crm_list_contacts')
        .upsert(batch, { onConflict: 'list_id,contact_id' });
      if (!error) linked += batch.length;
    }

    return {
      headers: CORS_HEADERS,
      statusCode: 200,
      body: JSON.stringify({ success: true, listId: targetListId, imported: allContactIds.length, linked, skipped })
    };
  } catch (e) {
    console.error('Erreur crm-import-contacts:', e);
    return { headers: CORS_HEADERS, statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
