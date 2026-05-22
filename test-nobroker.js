import axios from 'axios';
import * as cheerio from 'cheerio';

async function testNoBroker() {
  try {
    const { data } = await axios.get('https://www.nobroker.in/flats-for-rent-in-hyderabad', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const $ = cheerio.load(data);
    const properties = [];
    $('.bg-white').each((i, el) => {
      const title = $(el).find('h2').text().trim();
      const price = $(el).find('#roomType').parent().text().trim(); // This selector might be wrong, just guessing
      if (title) properties.push({ title, price });
    });
    console.log('Found properties:', properties.length);
    console.log(properties.slice(0, 5));
  } catch (err) {
    console.error('Scraping error:', err.message);
  }
}
testNoBroker();
