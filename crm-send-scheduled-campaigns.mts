import {clients,mailer} from './_shared/runtime.mts';
import {runScheduledCampaigns,blocksToEmailHtml} from './_shared/scheduled-campaigns.mjs';
export default async ()=>{
 try{const {db}=clients();const result=await runScheduledCampaigns({db,mailer:mailer(db),render:blocksToEmailHtml});return Response.json(result);}
 catch(e){console.error('Scheduled email failure',e.message);return Response.json({error:'Envoi différé'},{status:500});}
};
export const config={schedule:'*/15 * * * *'};
