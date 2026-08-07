// netlify/functions/astro-calculate.js
//
// Calcule le thème astral précis (Soleil, Lune, Ascendant, maisons,
// planètes rétrogrades) à partir d'une date, heure et lieu de
// naissance exacts, via une vraie bibliothèque de calcul
// astronomique (pas une approximation).
//
// Body attendu (POST) :
// { year, month, day, hour, minute, latitude, longitude }
// month est 1-12 (normal, pas 0-indexé comme en JS natif)
//
// Dépendance à ajouter dans package.json :
// "circular-natal-horoscope-js": "^1.6.0" (ou dernière version)

const { Origin, Horoscope } = require('circular-natal-horoscope-js');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const SIGN_MAP = {
  Aries: 'Bélier', Taurus: 'Taureau', Gemini: 'Gémeaux', Cancer: 'Cancer',
  Leo: 'Lion', Virgo: 'Vierge', Libra: 'Balance', Scorpio: 'Scorpion',
  Sagittarius: 'Sagittaire', Capricorn: 'Capricorne', Aquarius: 'Verseau', Pisces: 'Poissons'
};

function frSign(label) {
  return SIGN_MAP[label] || label;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method not allowed' };
  }

  try {
    const { year, month, day, hour, minute, latitude, longitude } = JSON.parse(event.body || '{}');
    if (!year || !month || !day || latitude === undefined || longitude === undefined) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'year, month, day, latitude et longitude sont requis' }) };
    }

    const origin = new Origin({
      year: Number(year),
      month: Number(month) - 1, // la bibliothèque attend un mois 0-indexé
      date: Number(day),
      hour: hour !== undefined && hour !== '' ? Number(hour) : 12,
      minute: minute !== undefined && minute !== '' ? Number(minute) : 0,
      latitude: Number(latitude),
      longitude: Number(longitude)
    });

    const horoscope = new Horoscope({
      origin,
      houseSystem: 'placidus',
      zodiac: 'tropical',
      aspectPoints: ['bodies'],
      aspectWithPoints: ['bodies'],
      aspectTypes: ['major'],
      customOrbs: {},
      language: 'en'
    });

    const hasExactTime = hour !== undefined && hour !== '' && hour !== null;

    const sun = horoscope.CelestialBodies.sun;
    const moon = horoscope.CelestialBodies.moon;

    const result = {
      sun: {
        sign: frSign(sun.Sign.label),
        degree: Math.round(sun.ChartPosition.Ecliptic.DecimalDegrees % 30 * 10) / 10
      },
      moon: {
        sign: frSign(moon.Sign.label),
        degree: Math.round(moon.ChartPosition.Ecliptic.DecimalDegrees % 30 * 10) / 10
      },
      hasExactTime
    };

    // L'Ascendant et les maisons nécessitent une heure de naissance précise
    if (hasExactTime) {
      const asc = horoscope.Ascendant;
      result.ascendant = {
        sign: frSign(asc.Sign.label),
        degree: Math.round(asc.ChartPosition.Ecliptic.DecimalDegrees % 30 * 10) / 10
      };
      result.houses = horoscope.Houses.map((h, i) => ({
        number: i + 1,
        sign: frSign(h.Sign.label)
      }));
    }

    // Planètes rétrogrades au moment de la naissance
    const retroBodies = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
    result.retrogrades = retroBodies
      .filter(p => horoscope.CelestialBodies[p]?.isRetrograde)
      .map(p => p.charAt(0).toUpperCase() + p.slice(1));

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(result) };
  } catch (e) {
    console.error('Erreur astro-calculate:', e);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: e.message }) };
  }
};
