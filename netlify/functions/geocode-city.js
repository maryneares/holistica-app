// netlify/functions/geocode-city.js
//
// Recherche de villes dans le monde entier (autocomplétion), via
// l'API publique et gratuite OpenStreetMap Nominatim. Passe par le
// serveur (plutôt que directement depuis le navigateur) pour
// respecter leurs conditions d'usage (User-Agent identifié).
//
// GET ?q=paris

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const q = event.queryStringParameters?.q;
  if (!q || q.length < 2) {
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ cities: [] }) };
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=8&accept-language=fr`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'HolisticaClub/1.0 (contact@holisticaclub.com)' }
    });
    if (!res.ok) throw new Error('Erreur Nominatim');
    const data = await res.json();

    const cities = data
      .filter(d => ['city', 'town', 'village', 'municipality', 'suburb', 'city_district', 'hamlet'].includes(d.type) || d.class === 'place' || d.class === 'boundary')
      .map(d => ({
        name: d.display_name.split(',')[0],
        fullName: d.display_name,
        region: d.address?.state || d.address?.county || '',
        lat: parseFloat(d.lat),
        lon: parseFloat(d.lon),
        country: d.address?.country || ''
      }));

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ cities }) };
  } catch (e) {
    console.error('Erreur geocode-city:', e);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: e.message, cities: [] }) };
  }
};
