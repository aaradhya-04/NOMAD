import axios from 'axios';
import * as cheerio from 'cheerio';

async function testScrape() {
  try {
    const { data } = await axios.get('https://allevents.in/hyderabad/all', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const $ = cheerio.load(data);
    const events = [];
    $('li[data-type="event"]').each((i, el) => {
      const title = $(el).find('.title h3, h3').text().trim();
      const date = $(el).find('.date').text().trim();
      const venue = $(el).find('.subtitle, .meta-right').text().trim();
      if (title) {
        events.push({ title, date, venue });
      }
    });
    console.log('Found events:', events.length);
    console.log(events.slice(0, 3));
  } catch (err) {
    console.error('Scraping error:', err.message);
  }
}
testScrape();
