// Old clients supplied an arbitrary recipient without authentication. This endpoint is retired.
// Deletion confirmations are now sent by delete-account after successful server-side deletion.
export default async () => Response.json({error:'Utilise le parcours de suppression de compte sécurisé.'},{status:410,headers:{'Cache-Control':'no-store'}});
