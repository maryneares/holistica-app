// The scheduled lifecycle function already handles the J+14 message.
// Retire the duplicate, publicly callable sender to avoid double promotions.
export default async () => Response.json({error:'Cet envoi est géré par le programme automatique.'},{status:410});
