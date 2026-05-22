import axios from 'axios';

async function testNominatim() {
  const city = 'Hyderabad';
  try {
    const res = await axios.get(`https://nominatim.openstreetmap.org/search?q=tourist+attractions+in+${city}&format=json&limit=5`, {
      headers: { 'User-Agent': 'NOMAD-App/1.0 (aditi@example.com)' }
    });
    console.log(res.data.map(p => p.display_name));
  } catch (err) {
    console.error(err.message);
  }
}
testNominatim();
