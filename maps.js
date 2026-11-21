'use strict';
// Google Maps link resolution — ported verbatim from the original server.
const http = require('http');
const https = require('https');

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// Follow HTTP/HTTPS redirects server-side (e.g. maps.app.goo.gl -> google.com/maps/place/...)
function fetchWithRedirects(targetUrl, maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    let currentUrl = targetUrl;
    let hops = 0;

    function requestOnce(urlStr) {
      let parsed;
      try {
        parsed = new URL(urlStr);
      } catch (e) {
        return reject(new Error('Invalid URL'));
      }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.get(urlStr, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RestaurantVoteBot/1.0)',
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
        },
        timeout: 6000
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < maxRedirects) {
          hops += 1;
          const nextUrl = new URL(res.headers.location, urlStr).toString();
          res.resume();
          currentUrl = nextUrl;
          return requestOnce(nextUrl);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          if (body.length < 150000) body += chunk;
        });
        res.on('end', () => resolve({ finalUrl: currentUrl, html: body }));
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ finalUrl: currentUrl, html: '' });
      });
      req.on('error', () => resolve({ finalUrl: currentUrl, html: '' }));
    }

    requestOnce(currentUrl);
  });
}

function parseCoordinates(urlStr) {
  const exact = urlStr.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (exact) return { lat: parseFloat(exact[1]), lng: parseFloat(exact[2]) };
  const at = urlStr.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at) return { lat: parseFloat(at[1]), lng: parseFloat(at[2]) };
  return null;
}

function extractMetaTag(html, attrName, attrValue) {
  if (!html) return '';
  const regex = new RegExp(
    `<meta[^>]+${attrName}=["']${attrValue}["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+${attrName}=["']${attrValue}["']`,
    'i'
  );
  const m = html.match(regex);
  return m ? decodeHtmlEntities((m[1] || m[2] || '').trim()) : '';
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

function parseNameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const decodedPath = decodeURIComponent(u.pathname);
    const placeMatch = decodedPath.match(/\/place\/([^/@]+)/);
    if (placeMatch && placeMatch[1]) {
      return placeMatch[1].replace(/\+/g, ' ').trim();
    }
    const q = u.searchParams.get('query') || u.searchParams.get('q') || u.searchParams.get('name');
    if (q && q.trim().length > 1) return q.replace(/\+/g, ' ').trim();
  } catch (e) {
    // Ignore
  }
  return '';
}

function fetchJsonHttps(urlStr) {
  return new Promise(resolve => {
    const req = https.get(urlStr, {
      headers: { 'User-Agent': 'RestaurantVoteApp/1.0' },
      timeout: 5000
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function lookupWithGooglePlacesApi(query, coords) {
  if (!GOOGLE_MAPS_API_KEY || !query) return null;
  let endpoint = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=' +
    encodeURIComponent(query) +
    '&inputtype=textquery&language=zh-TW&fields=name,formatted_address&key=' +
    encodeURIComponent(GOOGLE_MAPS_API_KEY);
  if (coords) {
    endpoint += `&locationbias=point:${coords.lat},${coords.lng}`;
  }
  const data = await fetchJsonHttps(endpoint);
  if (data && data.candidates && data.candidates[0]) {
    return {
      name: data.candidates[0].name || '',
      address: data.candidates[0].formatted_address || ''
    };
  }
  return null;
}

async function reverseGeocodeNominatim(coords) {
  if (!coords) return '';
  const endpoint = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(coords.lat)}&lon=${encodeURIComponent(coords.lng)}&accept-language=zh-TW`;
  const data = await fetchJsonHttps(endpoint);
  if (!data || !data.address) return '';
  const a = data.address;
  const parts = [
    a.postcode || '',
    a.city || a.county || '',
    a.town || a.suburb || a.city_district || '',
    a.village || a.neighbourhood || '',
    a.road || '',
    a.house_number ? `${a.house_number}號` : ''
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('') : '';
}

async function resolveGoogleMapsInput(rawInput) {
  const text = String(rawInput || '').trim();
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  let url = urlMatch ? urlMatch[0].replace(/[),.;]+$/, '') : '';
  if (!url && /^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(text)) {
    url = 'https://' + text.split(/\s+/)[0];
  }
  if (!url) return null;

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
  } catch (e) {
    return null;
  }

  // Extract any lines pasted alongside the URL
  const extraLines = text
    .replace(url, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  let name = extraLines[0] || parseNameFromUrl(url);
  let address = extraLines.length >= 2 ? extraLines.slice(1).join(' ') : '';
  let finalUrl = url;

  // Expand short links or fetch metadata server-side when needed
  const host = parsedUrl.hostname.replace(/^www\./, '');
  const isShortMap = host === 'maps.app.goo.gl' || host === 'goo.gl';
  if (isShortMap || !name) {
    const resolved = await fetchWithRedirects(url);
    finalUrl = resolved.finalUrl || url;
    if (!name) {
      name = parseNameFromUrl(finalUrl);
    }
    if (!name && resolved.html) {
      const ogTitle = extractMetaTag(resolved.html, 'property', 'og:title');
      if (ogTitle) {
        const cleaned = ogTitle.split('·')[0].replace(/\s*-\s*Google\s*(Maps|地圖)\s*$/i, '').trim();
        if (cleaned && !/^Google\s*(Maps|地圖)$/i.test(cleaned)) {
          name = cleaned;
        }
      }
    }
    if (!address && resolved.html) {
      const ogTitle = extractMetaTag(resolved.html, 'property', 'og:title');
      if (ogTitle && ogTitle.includes('·')) {
        address = ogTitle.split('·').slice(1).join(' ').trim();
      }
    }
  }

  const coords = parseCoordinates(finalUrl) || parseCoordinates(url);

  // If server has GOOGLE_MAPS_API_KEY configured, enrich name & formatted_address via Google Places API
  if (GOOGLE_MAPS_API_KEY && name) {
    const placeInfo = await lookupWithGooglePlacesApi(name, coords);
    if (placeInfo) {
      if (placeInfo.name) name = placeInfo.name;
      if (placeInfo.address) address = placeInfo.address;
    }
  }

  if (!address && coords) {
    address = await reverseGeocodeNominatim(coords);
  }

  if (!name) {
    name = host === 'maps.app.goo.gl' ? 'Google Maps 餐廳' : host;
  }

  return { name, address, url: finalUrl };
}

module.exports = { resolveGoogleMapsInput };
