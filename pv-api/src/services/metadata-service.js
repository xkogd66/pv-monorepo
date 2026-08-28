const config = require("../config");

/**
 * Reverse-geocode "lat,lng" to a place name via Mapbox.
 * EXIF extraction lives in pv-metadata (Python) — the worker calls it directly.
 */
async function getAddressFromCoordinates(coordinates) {
  if (!coordinates || coordinates === "not found") return "not found";
  if (!config.mapbox_token) return "API key not configured";

  try {
    const [lat, lng] = coordinates.split(",");
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${config.mapbox_token}&types=address,poi,place`;

    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return `API error: ${response.status}`;

    const data = await response.json();
    if (data.features?.length > 0) {
      return (
        data.features[0].place_name ||
        data.features[0].text ||
        "Address not found"
      );
    }
    return "Address not found";
  } catch (error) {
    return "Address lookup failed";
  }
}

module.exports = { getAddressFromCoordinates };
