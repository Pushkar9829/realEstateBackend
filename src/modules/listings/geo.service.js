// Geocoding for the listing map pin (RE-A-04). Google Geocoding API when a
// key is configured, OpenStreetMap Nominatim otherwise, `none` in tests.
// The pin can always be placed manually when the geocoder is unavailable.
const axios = require('axios');
const env = require('../../config/env');
const { ApiError } = require('../../core/http');
const { Master } = require('../cms/models');
const { toPoint, distanceM } = require('../../core/geo');

const UA = { 'User-Agent': 'RealEstatePlatform/1.0 (support@example.com)' };

async function geocode(address) {
  if (env.GEOCODER_PROVIDER === 'none') throw new ApiError(503, 'GEOCODER_UNAVAILABLE', 'Address search is unavailable, place the pin on the map');
  if (env.GEOCODER_PROVIDER === 'google' && env.GOOGLE_MAPS_SERVER_KEY) {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', { params: { address, region: 'in', key: env.GOOGLE_MAPS_SERVER_KEY }, timeout: 8000 });
    return (data.results || []).slice(0, 5).map((r) => ({ label: r.formatted_address, lat: r.geometry.location.lat, lng: r.geometry.location.lng }));
  }
  const { data } = await axios.get('https://nominatim.openstreetmap.org/search', { params: { q: address, format: 'json', countrycodes: 'in', limit: 5 }, headers: UA, timeout: 8000 });
  return data.map((r) => ({ label: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }));
}

// Nearest active locality (by centroid) within 15 km - works without any external call.
async function nearestLocality(lat, lng) {
  const point = toPoint(lat, lng);
  const localities = await Master.find({ type: 'locality', active: true, mergedInto: null, 'meta.centroid': { $exists: true } }).lean();
  let best = null;
  localities.forEach((l) => {
    const d = distanceM(point, l.meta.centroid);
    if (d <= 15000 && (!best || d < best.distanceM)) best = { localityId: l._id, locality: l.name, cityId: l.parentId, distanceM: d };
  });
  if (best) {
    const city = await Master.findById(best.cityId).lean();
    best.city = city && city.name;
  }
  return best;
}

async function reverse(lat, lng) {
  const local = await nearestLocality(lat, lng);
  let address = null;
  if (env.GEOCODER_PROVIDER === 'google' && env.GOOGLE_MAPS_SERVER_KEY) {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', { params: { latlng: `${lat},${lng}`, key: env.GOOGLE_MAPS_SERVER_KEY }, timeout: 8000 }).catch(() => ({ data: {} }));
    address = data.results && data.results[0] && data.results[0].formatted_address;
  } else if (env.GEOCODER_PROVIDER === 'nominatim') {
    const { data } = await axios.get('https://nominatim.openstreetmap.org/reverse', { params: { lat, lon: lng, format: 'json' }, headers: UA, timeout: 8000 }).catch(() => ({ data: {} }));
    address = data.display_name;
  }
  return { ...(local || {}), address };
}

module.exports = { geocode, reverse, nearestLocality };
