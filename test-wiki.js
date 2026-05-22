import axios from 'axios';

async function testWikipedia() {
  const city = 'Hyderabad';
  try {
    const res = await axios.get(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=landmarks%20in%20${city}&utf8=&format=json`);
    console.log(res.data.query.search.map(s => s.title));
  } catch (err) {
    console.error(err.message);
  }
}
testWikipedia();
