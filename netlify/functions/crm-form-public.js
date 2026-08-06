// netlify/functions/crm-form-public.js
//
// Fonction PUBLIQUE (aucune authentification) qui :
//  - en GET : affiche le formulaire sous forme de page HTML complète,
//    prête à être partagée en lien direct ou intégrée en iframe
//  - en POST : reçoit une inscription, crée/retrouve le contact, et
//    l'ajoute à la liste CRM ciblée par le formulaire
//
// URL publique du formulaire : 
// https://app.holisticaclub.com/.netlify/functions/crm-form-public?id=FORM_ID
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
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

/* ═══ Rendu des blocs du formulaire (mêmes couleurs/police que les emails) ═══ */
function formBlockToHtml(block) {
  switch (block.type) {
    case 'form_title':
      return `<div style="margin-bottom:18px;">
        ${block.eyebrow ? `<p style="margin:0 0 8px 0;color:#C890C8;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">${block.eyebrow}</p>` : ''}
        <h1 style="margin:0;color:#5B4EA8;font-size:26px;line-height:32px;font-weight:400;font-style:italic;font-family:Georgia,serif;">${block.title || ''}</h1>
      </div>`;
    case 'form_text':
      return `<div style="margin-bottom:18px;">${(block.text || '').split('\n').filter(l => l.trim()).map(l => `<p style="margin:0 0 10px 0;color:#6B6580;font-size:14.5px;line-height:24px;">${l}</p>`).join('')}</div>`;
    case 'form_image':
      return `<div style="margin-bottom:18px;"><img src="${block.imageUrl || ''}" style="display:block;width:100%;border-radius:14px;" alt=""></div>`;
    case 'form_divider':
      return `<div style="width:50px;height:2px;background:#C8BEED;border-radius:2px;margin:22px 0;"></div>`;
    case 'form_field': {
      const kind = block.kind || 'text';
      const type = kind === 'email' ? 'email' : 'text';
      const required = block.required !== false;
      return `<div style="margin-bottom:16px;">
        <label style="display:block;margin-bottom:6px;font-size:13px;font-weight:600;color:#5B4EA8;">${block.label || ''}${required ? ' *' : ''}</label>
        <input type="${type}" name="${kind}" ${required ? 'required' : ''} placeholder="${block.placeholder || ''}" style="width:100%;box-sizing:border-box;padding:12px 14px;border:1.5px solid #E4DFF5;border-radius:10px;font-size:14px;font-family:inherit;">
      </div>`;
    }
    case 'form_checkbox':
      return `<div style="margin-bottom:16px;display:flex;align-items:flex-start;gap:8px;">
        <input type="checkbox" id="cb_${block.id || Math.random()}" ${block.required ? 'required' : ''} style="margin-top:3px;">
        <label for="cb_${block.id || ''}" style="font-size:13px;color:#6B6580;line-height:20px;">${block.label || ''}</label>
      </div>`;
    case 'form_raw_html':
      return block.html || '';
    default:
      return '';
  }
}

function renderFormPage(form) {
  const blocksHtml = (form.blocks || []).map(formBlockToHtml).join('');
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${form.name}</title>
<style>
  body{margin:0;padding:0;background:#FAF8FF;font-family:-apple-system,'Inter',Helvetica,Arial,sans-serif;}
  .wrap{max-width:520px;margin:0 auto;padding:48px 20px;}
  .card{background:#FFFFFF;border-radius:24px;padding:36px 32px;box-shadow:0 8px 30px rgba(91,78,168,0.08);}
  .btn{width:100%;padding:14px;background:#5B4EA8;color:#FFFFFF;border:none;border-radius:50px;font-size:14.5px;font-weight:600;cursor:pointer;font-family:inherit;}
  .btn:disabled{opacity:.6;cursor:default;}
  .success{display:none;text-align:center;padding:20px 0;}
  .success p{color:#5B4EA8;font-size:16px;font-style:italic;font-family:Georgia,serif;}
  .error{color:#C0392B;font-size:13px;margin-top:10px;display:none;}
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <div id="formContent">${blocksHtml}
    <button class="btn" id="submitBtn" onclick="submitForm()">${form.submit_label || 'S\'inscrire'}</button>
    <p class="error" id="errorMsg"></p>
  </div>
  <div class="success" id="successBlock"><p>${form.success_message || 'Merci ! Ton inscription est confirmée.'}</p></div>
</div></div>
<script>
async function submitForm(){
  const btn=document.getElementById('submitBtn');
  const errorEl=document.getElementById('errorMsg');
  errorEl.style.display='none';
  const email=document.querySelector('input[name="email"]');
  if(email&&(!email.value||!email.value.includes('@'))){
    errorEl.textContent='Merci de renseigner une adresse email valide.';
    errorEl.style.display='block';
    return;
  }
  btn.disabled=true;
  btn.textContent='Envoi...';
  const payload={
    formId:'${form.id}',
    email:email?email.value:'',
    first_name:(document.querySelector('input[name="text"]')||{}).value||''
  };
  try{
    const res=await fetch(window.location.href.split('?')[0]+'?id=${form.id}',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    });
    const data=await res.json();
    if(!res.ok||data.error)throw new Error(data.error||'Erreur');
    document.getElementById('formContent').style.display='none';
    document.getElementById('successBlock').style.display='block';
  }catch(e){
    errorEl.textContent="Une erreur est survenue, réessaie dans un instant.";
    errorEl.style.display='block';
    btn.disabled=false;
    btn.textContent='${form.submit_label || "S'inscrire"}';
  }
}
</script>
</body>
</html>`;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const formId = event.queryStringParameters?.id;
  if (!formId) {
    return { statusCode: 400, headers: CORS_HEADERS, body: 'Formulaire introuvable' };
  }

  try {
    const { data: form, error } = await supabase.from('crm_forms').select('*').eq('id', formId).single();
    if (error || !form) {
      return { statusCode: 404, headers: CORS_HEADERS, body: 'Formulaire introuvable' };
    }

    if (event.httpMethod === 'GET') {
      return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
        body: renderFormPage(form)
      };
    }

    if (event.httpMethod === 'POST') {
      const { email, first_name } = JSON.parse(event.body || '{}');
      const cleanEmail = (email || '').trim().toLowerCase();
      if (!cleanEmail || !cleanEmail.includes('@')) {
        return { headers: CORS_HEADERS, statusCode: 400, body: JSON.stringify({ error: 'Email invalide' }) };
      }

      const { data: contact, error: upsertErr } = await supabase
        .from('crm_contacts')
        .upsert({ email: cleanEmail, first_name: first_name || null, prenom: first_name || null }, { onConflict: 'email', ignoreDuplicates: false })
        .select('id')
        .single();
      if (upsertErr) throw upsertErr;

      if (form.target_list_id) {
        await supabase.from('crm_list_contacts').upsert(
          { list_id: form.target_list_id, contact_id: contact.id },
          { onConflict: 'list_id,contact_id' }
        );
      }

      return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    return { headers: CORS_HEADERS, statusCode: 405, body: 'Method not allowed' };
  } catch (e) {
    console.error('Erreur crm-form-public:', e);
    return { headers: CORS_HEADERS, statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
