// netlify/functions/crm-send-campaign.js
//
// Envoie un email à tous les contacts d'une liste, via l'API Resend
// (envoi par lots de 100), puis enregistre la campagne. Accepte soit
// des "blocks" (recommandé, éditeur sans code), soit un bodyHtml brut
// (mode avancé).
//
// Variables d'environnement nécessaires (déjà présentes) :
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FROM = 'Maryne Ares - Holistica <info@maryneares.fr>';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ═══ Moteur de rendu des blocs (identique à admin.html) ═══ */
function extractYouTubeId(url) {
  if (!url) return '';
  const m = url.match(/(?:youtu\.be\/|v=|\/embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : url.trim();
}

function blockToHtml(block) {
  switch (block.type) {
    case 'eyebrow_title':
      return `<tr><td class="mobile-padding" style="padding:40px 48px 4px 48px;">
        ${block.eyebrow ? `<p class="body-font" style="margin:0 0 10px 0;color:#C890C8;font-size:12px;letter-spacing:2.5px;text-transform:uppercase;font-weight:600;">${block.eyebrow}</p>` : ''}
        <h1 class="title-font title-xl" style="margin:0;color:#5B4EA8;font-size:28px;line-height:35px;font-weight:400;">${block.title || ''}</h1>
      </td></tr>`;
    case 'paragraph':
      return `<tr><td class="mobile-padding" style="padding:18px 48px 8px 48px;">
        ${(block.text || '').split('\n').filter(l => l.trim()).map(line =>
          `<p class="body-font" style="margin:0 0 14px 0;color:#6B6580;font-size:15px;line-height:26px;">${line}</p>`
        ).join('')}
      </td></tr>`;
    case 'info_box':
      return `<tr><td class="mobile-padding" style="padding:18px 48px 8px 48px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF8FF;border-radius:18px;">
          <tr><td style="padding:24px 26px;">
            <p class="body-font" style="margin:0;color:#6B6580;font-size:14px;line-height:23px;">${(block.text || '').replace(/\n/g, '<br>')}</p>
          </td></tr>
        </table>
      </td></tr>`;
    case 'image': {
      const img = `<img src="${block.imageUrl}" width="504" alt="${block.alt || ''}" class="fluid-img" style="display:block;width:100%;border-radius:18px;">`;
      return `<tr><td class="mobile-padding" style="padding:18px 48px 8px 48px;">
        ${block.link ? `<a href="${block.link}" target="_blank">${img}</a>` : img}
      </td></tr>`;
    }
    case 'video': {
      const ytId = extractYouTubeId(block.videoUrl);
      const thumb = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
      return `<tr><td class="mobile-padding" style="padding:32px 48px 8px 48px;">
        ${block.eyebrow ? `<p class="body-font" style="margin:0 0 8px 0;color:#C890C8;font-size:12px;letter-spacing:2.5px;text-transform:uppercase;font-weight:600;">${block.eyebrow}</p>` : ''}
        ${block.text ? `<p class="body-font" style="margin:0 0 18px 0;color:#6B6580;font-size:14.5px;line-height:24px;">${block.text}</p>` : ''}
      </td></tr>
      <tr><td class="mobile-padding" style="padding:0 48px 22px 48px;">
        <a href="${block.videoUrl}" target="_blank" style="text-decoration:none;">
          <img src="${thumb}" width="504" alt="Vidéo" class="fluid-img" style="display:block;width:100%;border-radius:18px;">
        </a>
      </td></tr>
      <tr><td align="center" class="mobile-padding" style="padding:4px 48px 40px 48px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td align="center" style="border-radius:50px;background-color:#5B4EA8;">
            <a href="${block.videoUrl}" target="_blank" class="body-font" style="display:inline-block;padding:15px 32px;color:#FFFFFF;font-size:13.5px;font-weight:600;text-decoration:none;border-radius:50px;">${block.buttonLabel || 'Je regarde la vidéo'}</a>
          </td>
        </tr></table>
      </td></tr>`;
    }
    case 'button':
      return `<tr><td align="center" class="mobile-padding" style="padding:20px 48px 20px 48px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td align="center" style="border-radius:50px;background-color:#5B4EA8;">
            <a href="${block.link}" target="_blank" class="body-font" style="display:inline-block;padding:15px 32px;color:#FFFFFF;font-size:13.5px;font-weight:600;text-decoration:none;border-radius:50px;">${block.label || 'En savoir plus'}</a>
          </td>
        </tr></table>
      </td></tr>`;
    case 'steps': {
      const items = (block.items || []).map((step, i) => `
        <tr>
          <td width="34" valign="top" style="padding-bottom:14px;">
            <span style="display:inline-block;width:24px;height:24px;line-height:24px;background-color:#5B4EA8;border-radius:50%;color:#FFFFFF;font-size:12px;text-align:center;" class="body-font">${i + 1}</span>
          </td>
          <td valign="top" style="padding-bottom:14px;">
            <p class="body-font" style="margin:0;color:#6B6580;font-size:14px;line-height:24px;">${step}</p>
          </td>
        </tr>`).join('');
      return `<tr><td class="mobile-padding" style="padding:18px 48px 6px 48px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F3EFFC;border-radius:18px;">
          <tr><td style="padding:26px 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${items}</table>
          </td></tr>
        </table>
      </td></tr>`;
    }
    case 'banner':
      return `<tr><td style="background-color:#5B4EA8;padding:14px 0;">
        <p class="body-font" style="margin:0;color:#FFFFFF;font-size:11px;letter-spacing:3px;text-transform:uppercase;text-align:center;">${block.text || ''}</p>
      </td></tr>`;
    case 'divider':
      return `<tr><td align="center" style="padding:28px 0 6px 0;">
        <div style="width:60px;height:2px;background-color:#C8BEED;border-radius:2px;font-size:0;line-height:0;">&nbsp;</div>
      </td></tr>`;
    case 'columns_2':
    case 'columns_3':
    case 'columns_4': {
      const n = block.type === 'columns_2' ? 2 : block.type === 'columns_3' ? 3 : 4;
      const widthPct = Math.floor(100 / n);
      let cellsHtml = '';
      for (let i = 1; i <= n; i++) {
        const img = block['col' + i + '_image'];
        const txt = block['col' + i + '_text'] || '';
        const isFirst = i === 1, isLast = i === n;
        cellsHtml += `<td width="${widthPct}%" valign="top" style="padding:0 ${isLast?'0':'10'}px 0 ${isFirst?'0':'10'}px;">${img?`<img src="${img}" width="100%" style="display:block;border-radius:12px;margin-bottom:8px;">`:''}<p class="body-font" style="margin:0;color:#6B6580;font-size:13px;line-height:22px;">${txt}</p></td>`;
      }
      return `<tr><td class="mobile-padding" style="padding:18px 48px 8px 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cellsHtml}</tr></table></td></tr>`;
    }
    case 'signature':
      return `<tr><td class="mobile-padding" style="padding:30px 48px 20px 48px;">
        <p class="body-font" style="margin:0;color:#6B6580;font-size:14.5px;line-height:24px;">
          ${block.intro || 'À bientôt,'}<br>
          <span class="title-font" style="color:#5B4EA8;font-size:16px;">${block.name || 'Maryne'}</span><br>
          <span class="body-font" style="color:#C890C8;font-size:12.5px;">Holistica Club</span>
        </p>
      </td></tr>`;
    case 'raw_html':
      return `<tr><td class="mobile-padding" style="padding:18px 48px 8px 48px;">${block.html || ''}</td></tr>`;
    default:
      return '';
  }
}

function blocksToEmailHtml(blocks, meta) {
  meta = meta || {};
  const headerTag = meta.headerTag || '';
  const preheader = meta.preheader || '';
  const footerNote = meta.footerNote || 'Tu reçois cet email car tu es inscrite auprès de Holistica Club.';
  const bodyRows = (blocks || []).map(blockToHtml).join('');

  return `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital@1&family=Inter:wght@400;500;600&display=swap');
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  img{-ms-interpolation-mode:bicubic;border:0;height:auto;line-height:100%;outline:none;text-decoration:none;}
  body{margin:0;padding:0;width:100% !important;background-color:#FAF8FF;}
  .title-font{font-family:'Playfair Display',Georgia,'Times New Roman',serif;font-style:italic;}
  .body-font{font-family:'Inter',Helvetica,Arial,sans-serif;}
  @media screen and (max-width:600px){
    .email-container{width:100% !important;}
    .fluid-img{width:100% !important;height:auto !important;}
    .mobile-padding{padding-left:24px !important;padding-right:24px !important;}
    .title-xl{font-size:24px !important;line-height:30px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#FAF8FF;" class="body-font">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF8FF;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" class="email-container" style="width:600px;max-width:600px;background-color:#FFFFFF;border-radius:24px;overflow:hidden;box-shadow:0 8px 30px rgba(91,78,168,0.08);">

<tr><td align="center" style="background-color:#5B4EA8;padding:30px 24px 24px 24px;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 10px auto;"><tr>
    <td width="46" height="46" align="center" valign="middle" style="background-color:rgba(255,255,255,0.12);border:1px dashed rgba(255,255,255,0.5);border-radius:50%;font-size:18px;">🌸</td>
  </tr></table>
  <p class="title-font" style="margin:0;color:#FFFFFF;font-size:19px;letter-spacing:0.5px;">Holistica Club</p>
  ${headerTag ? `<p class="body-font" style="margin:6px 0 0 0;color:#C8BEED;font-size:11px;letter-spacing:2px;text-transform:uppercase;">${headerTag}</p>` : ''}
</td></tr>

${bodyRows}

<tr><td align="center" style="background-color:#5B4EA8;padding:32px 24px;">
  <p class="body-font" style="margin:0 0 6px 0;color:#C8BEED;font-size:11px;line-height:18px;">
    Holistica Club — Maryne Arès<br>${footerNote}
  </p>
  <p class="body-font" style="margin:8px 0 0 0;font-size:11px;">
    <a href="{{unsubscribe}}" style="color:#C8BEED;text-decoration:underline;">Se désinscrire</a>
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}
/* ═══ Fin moteur de rendu ═══ */

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
    const { listId, contactIds, subject, bodyHtml, blocks, headerTag, preheader, footerNote } = JSON.parse(event.body || '{}');
    if ((!listId && !contactIds) || !subject || (!bodyHtml && !blocks)) {
      return { headers: CORS_HEADERS, statusCode: 400, body: JSON.stringify({ error: 'listId ou contactIds, subject et (bodyHtml ou blocks) sont requis' }) };
    }

    const finalHtml = blocks ? blocksToEmailHtml(blocks, { headerTag, preheader, footerNote }) : bodyHtml;

    let contacts = [];
    if (contactIds && contactIds.length) {
      const { data, error } = await supabase
        .from('crm_contacts')
        .select('id,email,first_name,blocked')
        .in('id', contactIds);
      if (error) throw error;
      contacts = (data || []).filter(c => c?.email && !c.blocked);
    } else {
      const { data: rows, error } = await supabase
        .from('crm_list_contacts')
        .select('crm_contacts(id,email,first_name,blocked)')
        .eq('list_id', listId);
      if (error) throw error;
      contacts = (rows || []).map(r => r.crm_contacts).filter(c => c?.email && !c.blocked);
    }

    if (!contacts.length) {
      return { headers: CORS_HEADERS, statusCode: 400, body: JSON.stringify({ error: 'Aucun destinataire valide trouvé' }) };
    }

    // Crée la campagne EN AMONT pour avoir un id auquel rattacher chaque
    // destinataire (nécessaire pour le suivi de délivrabilité ensuite).
    const { data: campaignRow, error: campaignErr } = await supabase.from('crm_campaigns').insert({
      list_id: listId || null,
      contact_ids: contactIds || null,
      subject,
      body_html: finalHtml,
      blocks: blocks || null,
      header_tag: headerTag || '',
      status: 'sent',
      recipients_count: 0,
      sent_at: new Date().toISOString()
    }).select('id').single();
    if (campaignErr) throw campaignErr;
    const campaignId = campaignRow.id;

    const batches = chunk(contacts, 100);
    let sentCount = 0;

    for (const batch of batches) {
      const emails = batch.map(c => ({
        from: FROM,
        to: [c.email],
        subject,
        html: finalHtml
          .replace(/\{\{prenom\}\}/g, c.first_name || '')
          .replace(/\{\{unsubscribe\}\}/g, `https://app.holisticaclub.com/.netlify/functions/crm-unsubscribe?id=${c.id}`)
      }));

      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(emails)
      });

      if (res.ok) {
        const resendData = await res.json();
        const resendIds = (resendData.data || []).map(d => d.id);
        sentCount += batch.length;

        // Enregistre chaque destinataire pour le suivi de délivrabilité
        const recipientRows = batch.map((c, i) => ({
          campaign_id: campaignId,
          contact_id: c.id || null,
          email: c.email,
          resend_email_id: resendIds[i] || null,
          status: 'sent'
        })).filter(r => r.resend_email_id);
        if (recipientRows.length) {
          await supabase.from('crm_campaign_recipients').insert(recipientRows);
        }
      } else {
        const err = await res.text();
        console.error('Erreur envoi lot Resend:', err);
      }
    }

    await supabase.from('crm_campaigns').update({ recipients_count: sentCount }).eq('id', campaignId);

    return { headers: CORS_HEADERS, statusCode: 200, body: JSON.stringify({ success: true, sentCount, totalContacts: contacts.length }) };
  } catch (e) {
    console.error('Erreur crm-send-campaign:', e);
    return { headers: CORS_HEADERS, statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
