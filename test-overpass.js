import axios from 'axios';

async function testOverpass() {
  const city = 'Hyderabad';
  const query = `[out:json];area[name="${city}"]->.searchArea;node["tourism"~"attraction|museum"](area.searchArea);out 5;`;
  try {
    const res = await axios.get('https://overpass-api.de/api/interpreter', {
      params: { data: query },
      headers: { 'User-Agent': 'NOMAD-App/1.0 (aditi@example.com)' }
    });
    console.log(res.data.elements.map(e => e.tags?.name || 'Unnamed'));
  } catch (err) {
    console.error(err.message);
  }
}
testOverpass();
