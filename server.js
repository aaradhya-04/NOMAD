// Express backend — proxies OTP requests to Fast2SMS
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import bcrypt from 'bcrypt';
import { connectDB } from './db/connect.js';
import {
  User,
  CommunityPost,
  FoodReview,
  CarpoolPost,
  toApiDoc,
  toApiDocs,
} from './db/models.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

app.use(cors());
app.use(express.json());

// POST /api/send-otp
// Body: { phone: "9876543210", otp: "123456" }
app.post('/api/send-otp', async (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({ success: false, message: 'Phone and OTP are required.' });
  }

  if (!/^\d{10}$/.test(phone)) {
    return res.status(400).json({ success: false, message: 'Invalid phone number.' });
  }

  try {
    const response = await axios.post('https://www.fast2sms.com/dev/bulkV2', {
      route: 'q',
      message: `Your NOMAD verification OTP is ${otp}`,
      language: 'english',
      flash: 0,
      numbers: String(phone),
    }, {
      headers: {
        authorization: process.env.FAST2SMS_KEY
      }
    });

    if (response.data.return === true) {
      console.log(`✅ OTP sent to +91${phone}`);
      return res.json({ success: true, message: 'OTP sent successfully.' });
    } else {
      console.error('Fast2SMS error:', response.data);
      return res.status(500).json({ success: false, message: 'Failed to send OTP.', detail: response.data });
    }
  } catch (err) {
    const errorDetail = err.response?.data || err.message;
    console.error('Fast2SMS Error Detail:', errorDetail);
    return res.status(500).json({ success: false, message: 'Server error while sending OTP.', detail: errorDetail });
  }
});

// POST /api/send-email-otp
// Body: { email: "user@example.com", otp: "123456" }
app.post('/api/send-email-otp', async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ success: false, message: 'Email and OTP are required.' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Your NOMAD Verification Code',
      text: `Welcome to NOMAD!\n\nYour verification OTP is: ${otp}\n\nPlease enter this code to complete your signup.`
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ Email OTP sent to ${email}`);
    res.json({ success: true, message: 'OTP sent to email successfully.' });
  } catch (err) {
    console.error('Email sending failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send OTP to email.', detail: err.message });
  }
});

// POST /api/signup
app.post('/api/signup', async (req, res) => {
  const { name, email, password, idType, idNumber, phone, designation } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ success: false, message: 'Name, email, and password are required' });
  }

  try {
    const emailNorm = normalizeEmail(email);
    const existing = await User.findOne({ email: emailNorm });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email already exists!' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await User.create({
      name,
      email: emailNorm,
      password: hashedPassword,
      idType,
      idNumber,
      phone,
      designation: designation || 'nomad',
    });

    res.json({ success: true, message: 'User signed up successfully' });
  } catch (err) {
    console.error('Signup error:', err);
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Email already exists!' });
    }
    res.status(500).json({ success: false, message: 'Server error during signup' });
  }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  try {
    const emailNorm = normalizeEmail(email);
    const user = await User.findOne({ email: emailNorm });
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found. Please sign up' });
    }

    if (!user.password) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    let match = false;
    if (user.password.startsWith('$2')) {
      match = await bcrypt.compare(password, user.password);
    } else {
      match = password === user.password;
    }

    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    res.json({
      success: true,
      message: 'Login successful',
      user: { name: user.name, email: user.email, designation: user.designation || 'nomad' },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error during login' });
  }
});

// POST /api/reset-password
app.post('/api/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) {
    return res.status(400).json({ success: false, message: 'Email and new password are required' });
  }

  try {
    const emailNorm = normalizeEmail(email);
    const user = await User.findOne({ email: emailNorm });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found. Cannot reset password.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ success: false, message: 'Server error during password reset' });
  }
});

// GET /api/events/:city
// Fetches REAL events — tries Ticketmaster, Eventbrite, Cheerio web scraping, then serves rich fallback
app.get('/api/events/:city', async (req, res) => {
  const city = req.params.city.toLowerCase();
  try {
    const requestedMonth = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const requestedYear  = parseInt(req.query.year)  || new Date().getFullYear();
    const TICKETMASTER_KEY = process.env.TICKETMASTER_KEY;
    const EVENTBRITE_KEY   = process.env.EVENTBRITE_KEY;

    let liveEvents = [];
    let dataSource = 'curated';

    // ── 1. Ticketmaster Discovery API ──────────────────
    if (TICKETMASTER_KEY && liveEvents.length === 0) {
      try {
        const startDate = `${requestedYear}-${String(requestedMonth).padStart(2, '0')}-01T00:00:00Z`;
        const endMonth  = requestedMonth === 12 ? 1 : requestedMonth + 1;
        const endYear   = requestedMonth === 12 ? requestedYear + 1 : requestedYear;
        const endDate   = `${endYear}-${String(endMonth).padStart(2, '0')}-01T00:00:00Z`;
        const tmRes = await axios.get('https://app.ticketmaster.com/discovery/v2/events.json', {
          params: { apikey: TICKETMASTER_KEY, city, startDateTime: startDate, endDateTime: endDate, size: 50 }, timeout: 6000
        });
        const tmEvents = tmRes.data?._embedded?.events || [];
        if (tmEvents.length > 0) {
          liveEvents = tmEvents.map(ev => ({
            id: `tm-${ev.id}`, title: ev.name, date: ev.dates?.start?.localDate || startDate.split('T')[0], type: 'special', venue: ev._embedded?.venues?.[0]?.name || city,
            bookingLink: ev.url || `https://www.ticketmaster.com/search?q=${encodeURIComponent(ev.name)}`
          }));
          dataSource = 'ticketmaster';
        }
      } catch (e) {}
    }

    // ── 2. Eventbrite fallback ───────────────────────────────────────────────
    if (EVENTBRITE_KEY && liveEvents.length === 0) {
      try {
        const ebRes = await axios.get('https://www.eventbriteapi.com/v3/events/search/', {
          params: { 'location.address': city, expand: 'venue', 'start_date.range_start': `${requestedYear}-${String(requestedMonth).padStart(2, '0')}-01T00:00:00Z` },
          headers: { Authorization: `Bearer ${EVENTBRITE_KEY}` }, timeout: 6000
        });
        const ebEvents = ebRes.data?.events || [];
        if (ebEvents.length > 0) {
          liveEvents = ebEvents.map(ev => ({ id: `eb-${ev.id}`, title: ev.name.text, date: ev.start.local, type: 'special', venue: ev.venue?.name || city, bookingLink: ev.url || `https://www.eventbrite.com/d/online/${encodeURIComponent(ev.name.text)}/` }));
          dataSource = 'eventbrite';
        }
      } catch (e) {}
    }

    // ── 3. Free Web Scraping Fallback (allevents.in) ─────────────────────────
    if (liveEvents.length === 0) {
      try {
        const cheerio = await import('cheerio');
        const { data } = await axios.get(`https://allevents.in/${city}/all`, { timeout: 4000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(data);
        $('li[data-type="event"]').each((i, el) => {
          const title = $(el).find('.title h3, h3').text().trim();
          const dateStr = $(el).find('.date').text().trim();
          const venue = $(el).find('.subtitle, .meta-right').text().trim();
          if (title && liveEvents.length < 20) {
            liveEvents.push({ id: `scraped-${i}`, title, date: new Date().toISOString().split('T')[0], type: 'special', venue, bookingLink: `https://allevents.in/${city}/all` });
          }
        });
        if (liveEvents.length > 0) dataSource = 'scraped free API';
      } catch (e) {
        console.error('Free web scraping failed:', e.message);
      }
    }

    // ── 4. Dense curated fallback ─────────────────
    const curatedEvents = buildCuratedEvents(requestedMonth, requestedYear, city);
    const allEvents = [...liveEvents, ...curatedEvents];
    allEvents.sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json({ success: true, events: allEvents, source: dataSource });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch events.' });
  }
});

function buildCuratedEvents(month, year, city) {
  const pad = n => String(n).padStart(2, '0');
  const date = (d) => `${year}-${pad(month)}-${pad(d)}`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const capCity = city.charAt(0).toUpperCase() + city.slice(1);
  const events = [];
  
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = date(d);
    if (d % 3 === 0) events.push({ id: `cur-${d}-1`, title: `${capCity} Cultural Night`, date: dateStr, type: 'performance', venue: `Downtown ${capCity}`, bookingLink: `https://in.bookmyshow.com/explore/events-${city}` });
    if (d % 5 === 0) events.push({ id: `cur-${d}-2`, title: `Street Food Festival ${capCity}`, date: dateStr, type: 'food', venue: `Central Park, ${capCity}`, bookingLink: `https://in.bookmyshow.com/explore/events-${city}` });
  }
  return events;
}

// ── City → State mapping for regional holidays ──
const CITY_STATE_MAP = {
  hyderabad: 'Telangana', secunderabad: 'Telangana', warangal: 'Telangana',
  mumbai: 'Maharashtra', pune: 'Maharashtra', nagpur: 'Maharashtra',
  delhi: 'Delhi', 'new delhi': 'Delhi', noida: 'Uttar Pradesh', lucknow: 'Uttar Pradesh',
  bangalore: 'Karnataka', bengaluru: 'Karnataka', mysore: 'Karnataka',
  chennai: 'Tamil Nadu', coimbatore: 'Tamil Nadu', madurai: 'Tamil Nadu',
  kolkata: 'West Bengal', jaipur: 'Rajasthan', udaipur: 'Rajasthan',
  ahmedabad: 'Gujarat', surat: 'Gujarat', kochi: 'Kerala', thiruvananthapuram: 'Kerala',
  bhopal: 'Madhya Pradesh', indore: 'Madhya Pradesh', patna: 'Bihar',
  chandigarh: 'Punjab', amritsar: 'Punjab', dehradun: 'Uttarakhand',
  guwahati: 'Assam', bhubaneswar: 'Odisha', ranchi: 'Jharkhand',
  visakhapatnam: 'Andhra Pradesh', vijayawada: 'Andhra Pradesh', tirupati: 'Andhra Pradesh',
  goa: 'Goa', panaji: 'Goa', shimla: 'Himachal Pradesh', srinagar: 'Jammu & Kashmir',
  raipur: 'Chhattisgarh', gangtok: 'Sikkim', imphal: 'Manipur', shillong: 'Meghalaya',
};

// Regional holidays by state (month-day → holiday name)
const REGIONAL_HOLIDAYS = {
  'Telangana': {
    '01-26': 'Republic Day', '06-02': 'Telangana Formation Day', '08-15': 'Independence Day',
    '10-02': 'Gandhi Jayanti', '11-01': 'Bathukamma Festival', '11-13': 'Diwali',
    '01-14': 'Makar Sankranti', '03-29': 'Ugadi (Telugu New Year)', '04-14': 'Ambedkar Jayanti',
    '08-26': 'Krishna Janmashtami', '09-07': 'Vinayaka Chavithi', '10-12': 'Dussehra',
    '10-31': 'Naraka Chaturdashi', '12-25': 'Christmas',
  },
  'Maharashtra': {
    '01-26': 'Republic Day', '05-01': 'Maharashtra Day', '08-15': 'Independence Day',
    '10-02': 'Gandhi Jayanti', '11-13': 'Diwali', '03-22': 'Gudi Padwa',
    '09-07': 'Ganesh Chaturthi', '10-12': 'Dussehra', '01-14': 'Makar Sankranti',
    '08-26': 'Krishna Janmashtami', '04-14': 'Ambedkar Jayanti', '12-25': 'Christmas',
    '02-26': 'Shivaji Jayanti', '06-29': 'Ashadhi Ekadashi',
  },
  'Karnataka': {
    '01-26': 'Republic Day', '11-01': 'Karnataka Rajyotsava', '08-15': 'Independence Day',
    '10-02': 'Gandhi Jayanti', '11-13': 'Diwali', '01-14': 'Makar Sankranti',
    '03-29': 'Ugadi', '09-07': 'Ganesh Chaturthi', '10-12': 'Dussehra',
    '08-26': 'Krishna Janmashtami', '04-14': 'Ambedkar Jayanti', '12-25': 'Christmas',
  },
  'Tamil Nadu': {
    '01-14': 'Pongal', '01-15': 'Thiruvalluvar Day', '01-26': 'Republic Day',
    '04-14': 'Tamil New Year', '08-15': 'Independence Day', '10-02': 'Gandhi Jayanti',
    '11-13': 'Diwali', '10-12': 'Dussehra', '12-25': 'Christmas',
    '09-07': 'Vinayaka Chaturthi', '08-26': 'Krishna Janmashtami',
  },
  'West Bengal': {
    '01-26': 'Republic Day', '08-15': 'Independence Day', '10-02': 'Gandhi Jayanti',
    '11-13': 'Kali Puja / Diwali', '10-12': 'Durga Puja (Bijoya Dashami)',
    '10-10': 'Durga Puja (Saptami)', '10-11': 'Durga Puja (Ashtami)',
    '04-15': 'Poila Baisakh', '12-25': 'Christmas', '01-14': 'Makar Sankranti',
  },
  'Kerala': {
    '01-26': 'Republic Day', '08-15': 'Independence Day', '10-02': 'Gandhi Jayanti',
    '08-29': 'Onam', '11-13': 'Diwali', '04-14': 'Vishu', '12-25': 'Christmas',
    '01-14': 'Makar Sankranti', '09-07': 'Vinayaka Chaturthi', '10-12': 'Dussehra',
  },
  'Rajasthan': {
    '01-26': 'Republic Day', '03-30': 'Rajasthan Day', '08-15': 'Independence Day',
    '10-02': 'Gandhi Jayanti', '11-13': 'Diwali', '03-13': 'Holi',
    '10-12': 'Dussehra', '01-14': 'Makar Sankranti', '08-26': 'Krishna Janmashtami',
    '07-17': 'Teej', '12-25': 'Christmas',
  },
  'Gujarat': {
    '01-14': 'Uttarayan / Makar Sankranti', '01-26': 'Republic Day', '05-01': 'Gujarat Day',
    '08-15': 'Independence Day', '10-02': 'Gandhi Jayanti', '10-24': 'Navratri Begins',
    '11-13': 'Diwali', '11-14': 'Gujarat New Year', '12-25': 'Christmas',
    '03-13': 'Holi', '08-26': 'Krishna Janmashtami',
  },
  'Delhi': {
    '01-26': 'Republic Day', '08-15': 'Independence Day', '10-02': 'Gandhi Jayanti',
    '11-13': 'Diwali', '03-13': 'Holi', '10-12': 'Dussehra', '01-14': 'Makar Sankranti / Lohri',
    '04-14': 'Ambedkar Jayanti / Baisakhi', '08-26': 'Krishna Janmashtami',
    '09-07': 'Ganesh Chaturthi', '12-25': 'Christmas', '11-27': 'Guru Nanak Jayanti',
  },
  'Andhra Pradesh': {
    '01-26': 'Republic Day', '03-29': 'Ugadi', '08-15': 'Independence Day',
    '10-02': 'Gandhi Jayanti', '11-13': 'Diwali', '01-14': 'Makar Sankranti',
    '10-12': 'Dussehra', '08-26': 'Krishna Janmashtami', '09-07': 'Vinayaka Chavithi',
    '04-14': 'Ambedkar Jayanti', '12-25': 'Christmas',
  },
};

// Default national holidays if state not found
const DEFAULT_HOLIDAYS = {
  '01-26': 'Republic Day', '08-15': 'Independence Day', '10-02': 'Gandhi Jayanti',
  '11-13': 'Diwali', '03-13': 'Holi', '10-12': 'Dussehra', '01-14': 'Makar Sankranti',
  '12-25': 'Christmas', '04-14': 'Ambedkar Jayanti', '08-26': 'Krishna Janmashtami',
  '09-07': 'Ganesh Chaturthi', '11-27': 'Guru Nanak Jayanti',
};

// GET /api/holidays/:city — fetches regional + national holidays (free, no API key)
app.get('/api/holidays/:city', async (req, res) => {
  const city = req.params.city.toLowerCase();
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const month = req.query.month ? parseInt(req.query.month) : null;

  const state = CITY_STATE_MAP[city];
  let holidays = [];
  let source = 'regional';

  // 1. Try Nager.Date API for India national holidays
  try {
    const nagerRes = await axios.get(`https://date.nager.at/api/v3/PublicHolidays/${year}/IN`, { timeout: 4000 });
    if (nagerRes.data && Array.isArray(nagerRes.data)) {
      holidays = nagerRes.data.map(h => ({
        id: `nager-${h.date}`,
        title: h.localName || h.name,
        date: h.date,
        type: 'holiday',
        venue: h.counties ? 'Regional' : 'National',
        isNational: !h.counties || h.counties.length === 0,
        isRegional: h.counties && h.counties.length > 0,
      }));
      source = 'nager.date';
    }
  } catch (err) {
    console.error('Nager.Date API error:', err.message);
  }

  // 2. Merge regional holidays from our curated list
  const stateHolidays = state ? (REGIONAL_HOLIDAYS[state] || DEFAULT_HOLIDAYS) : DEFAULT_HOLIDAYS;
  for (const [mmdd, name] of Object.entries(stateHolidays)) {
    const fullDate = `${year}-${mmdd}`;
    // Avoid duplicates
    if (!holidays.find(h => h.date === fullDate && h.title.toLowerCase().includes(name.split(' ')[0].toLowerCase()))) {
      holidays.push({
        id: `regional-${mmdd}`,
        title: name,
        date: fullDate,
        type: 'holiday',
        venue: state || 'India',
        isNational: ['Republic Day', 'Independence Day', 'Gandhi Jayanti'].includes(name),
        isRegional: !['Republic Day', 'Independence Day', 'Gandhi Jayanti', 'Christmas'].includes(name),
        isInternational: false
      });
    }
  }

  // 2.5 Add International Holidays
  const intlHolidays = {
    '01-01': "New Year's Day", '03-08': "International Women's Day", '05-01': "International Labour Day",
    '06-21': "International Yoga Day", '12-25': "Christmas",
  };
  for (const [mmdd, name] of Object.entries(intlHolidays)) {
    const fullDate = `${year}-${mmdd}`;
    if (!holidays.find(h => h.date === fullDate && h.title.toLowerCase().includes(name.split(' ')[0].toLowerCase()))) {
      holidays.push({
        id: `intl-${mmdd}`,
        title: name,
        date: fullDate,
        type: 'holiday',
        venue: 'Global',
        isNational: false,
        isRegional: false,
        isInternational: true
      });
    }
  }

  // 3. Filter by month if requested
  if (month) {
    const mm = String(month).padStart(2, '0');
    holidays = holidays.filter(h => h.date.split('-')[1] === mm);
  }

  // Sort by date
  holidays.sort((a, b) => new Date(a.date) - new Date(b.date));

  res.json({ success: true, holidays, state: state || 'India', source });
});

// GET /api/weather/:city — fetches live weather via wttr.in (no API key needed)
app.get('/api/weather/:city', async (req, res) => {
  const city = req.params.city;
  try {
    const response = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
      headers: { 'User-Agent': 'NOMAD-App/1.0' },
      timeout: 5000
    });
    const data = response.data;
    const current = data.current_condition[0];
    res.json({
      success: true,
      weather: {
        temp_c: current.temp_C,
        feels_like_c: current.FeelsLikeC,
        humidity: current.humidity,
        description: current.weatherDesc[0].value,
        wind_kmph: current.windspeedKmph,
        visibility: current.visibility,
        uv_index: current.uvIndex
      }
    });
  } catch (err) {
    console.error('Weather fetch error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch weather' });
  }
});

// Helper: fetch real image from Wikipedia for a place/food name
async function getWikipediaImage(placeName) {
  try {
    const encoded = encodeURIComponent(placeName.replace(/\s+/g, '_'));
    const res = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`, {
      headers: { 'User-Agent': 'NOMAD-App/1.0 (aditi@example.com)' }, timeout: 3000
    });
    if (res.data && res.data.thumbnail && res.data.thumbnail.source) {
      // Upgrade to higher resolution thumbnail
      const src = res.data.thumbnail.source.replace(/\/\d+px-/, '/640px-');
      return { image: src, description: res.data.extract || '' };
    }
  } catch (e) { /* no wiki page */ }
  return null;
}

// Helper: build a relevant Unsplash search URL (no API key needed via source.unsplash.com)
function unsplashSearch(query, width = 600, height = 400) {
  const q = encodeURIComponent(query);
  return `https://source.unsplash.com/${width}x${height}/?${q}`;
}

// Helper: fetch real food image — tries Wikipedia first, then Wikimedia Commons search
async function getFoodImage(foodName) {
  // 1. Try Wikipedia summary thumbnail
  const wiki = await getWikipediaImage(foodName);
  if (wiki && wiki.image) return wiki.image;

  // 2. Try Wikimedia Commons search API
  try {
    const q = encodeURIComponent(foodName);
    const res = await axios.get(
      `https://en.wikipedia.org/w/api.php?action=query&prop=pageimages&titles=${q}&pithumbsize=640&format=json&formatversion=2`,
      { headers: { 'User-Agent': 'NOMAD-App/1.0 (aditi@example.com)' }, timeout: 3000 }
    );
    const pages = res.data?.query?.pages;
    if (pages && pages.length > 0 && pages[0].thumbnail?.source) {
      return pages[0].thumbnail.source;
    }
  } catch (e) { /* ignore */ }

  // 3. Fallback to Unsplash source search
  return unsplashSearch(foodName + ' food Indian');
}

// GET /api/places/:city — fetches real famous places via curated lists
app.get('/api/places/:city', async (req, res) => {
  const city = req.params.city;
  const capCity = city.charAt(0).toUpperCase() + city.slice(1);
  
  // City-specific curated list (guaranteed high-quality Wikipedia images)
  const cityFallbacks = {
    hyderabad: [
      { id: 1, name: 'Charminar', category: 'Heritage Fort', description: 'Iconic 16th-century mosque and monument, the global symbol of Hyderabad.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/71/Charminar_Hyderabad_1702.jpg/640px-Charminar_Hyderabad_1702.jpg', rating: 4.8, timings: '9:30 AM – 5:30 PM', entry: '₹25' },
      { id: 2, name: 'Golconda Fort', category: 'Heritage Fort', description: 'Magnificent 13th-century fort famous for its acoustics and diamond history.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Golcunda_fort.jpg/640px-Golcunda_fort.jpg', rating: 4.7, timings: '8:00 AM – 5:30 PM', entry: '₹15' },
      { id: 3, name: 'Hussain Sagar Lake', category: 'Lake', description: 'Heart-shaped lake with a monolithic Buddha statue, connecting Twin Cities.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5a/Buddha_Statue_at_Hussain_Sagar%2C_Hyderabad.jpg/640px-Buddha_Statue_at_Hussain_Sagar%2C_Hyderabad.jpg', rating: 4.5, timings: 'Open 24/7', entry: 'Free' },
      { id: 4, name: 'Ramoji Film City', category: 'Attraction', description: 'World\'s largest film studio complex with guided tours and entertainment.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Ramoji_Film_City%2C_Hyderabad_-_views_from_the_location_%2810%29.JPG/640px-Ramoji_Film_City%2C_Hyderabad_-_views_from_the_location_%2810%29.JPG', rating: 4.6, timings: '9:00 AM – 5:30 PM', entry: '₹1250' },
      { id: 5, name: 'Salar Jung Museum', category: 'Museum', description: 'One of India\'s three National Museums with a vast collection of art & artifacts.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ea/SalarJungMuseum.jpg/640px-SalarJungMuseum.jpg', rating: 4.6, timings: '10:00 AM – 5:00 PM', entry: '₹20' },
      { id: 6, name: 'Birla Mandir', category: 'Temple', description: 'Stunning white marble temple atop Naubath Pahad hill with panoramic city views.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5b/Birla_Mandir%2C_Hyderabad_in_2020.jpg/640px-Birla_Mandir%2C_Hyderabad_in_2020.jpg', rating: 4.7, timings: '7:00 AM – 12:00 PM, 2:00 PM – 9:00 PM', entry: 'Free' },
      { id: 7, name: 'Chowmahalla Palace', category: 'Heritage Fort', description: 'Seat of the Asaf Jahi dynasty, showcasing Nizami grandeur and vintage cars.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/da/Chowmahalla_Palace_entrance.jpg/640px-Chowmahalla_Palace_entrance.jpg', rating: 4.5, timings: '10:00 AM – 5:00 PM', entry: '₹80' },
      { id: 8, name: 'Nehru Zoological Park', category: 'Park', description: 'One of India\'s largest zoos with safari rides, spread over 380 acres.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/Nehru_Zoological_Park_Entrance.JPG/640px-Nehru_Zoological_Park_Entrance.JPG', rating: 4.3, timings: '8:30 AM – 5:00 PM', entry: '₹40' }
    ],
    mumbai: [
      { id: 1, name: 'Gateway of India', category: 'Heritage Fort', description: 'Iconic monument on the waterfront overlooking the Arabian Sea.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Mumbai_03-2016_30_Gateway_of_India.jpg/640px-Mumbai_03-2016_30_Gateway_of_India.jpg', rating: 4.7, timings: 'Open 24/7', entry: 'Free' },
      { id: 2, name: 'Marine Drive', category: 'Attraction', description: 'C-shaped boulevard along the coast, famous as the Queen\'s Necklace.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d3/Marine_Drive_Mumbai.jpg/640px-Marine_Drive_Mumbai.jpg', rating: 4.8, timings: 'Open 24/7', entry: 'Free' },
      { id: 3, name: 'Chhatrapati Shivaji Maharaj Vastu Sangrahalaya', category: 'Museum', description: 'Premier art and history museum in India.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Chhatrapati_Shivaji_Maharaj_Vastu_Sangrahalaya_01.jpg/640px-Chhatrapati_Shivaji_Maharaj_Vastu_Sangrahalaya_01.jpg', rating: 4.6, timings: '10:15 AM - 6:00 PM', entry: '₹100' }
    ],
    bangalore: [
      { id: 1, name: 'Lalbagh Botanical Garden', category: 'Park', description: 'Historic botanical garden with a famous glass house.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/Lalbagh_Glass_House.jpg/640px-Lalbagh_Glass_House.jpg', rating: 4.6, timings: '6:00 AM - 7:00 PM', entry: '₹30' },
      { id: 2, name: 'Bangalore Palace', category: 'Heritage Fort', description: 'Majestic palace built in Tudor Revival style architecture.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/29/Bangalore_Palace.jpg/640px-Bangalore_Palace.jpg', rating: 4.5, timings: '10:00 AM - 5:30 PM', entry: '₹250' },
      { id: 3, name: 'Cubbon Park', category: 'Park', description: 'Landmark park in the heart of the city.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/Cubbon_Park_Bengaluru.jpg/640px-Cubbon_Park_Bengaluru.jpg', rating: 4.7, timings: '6:00 AM - 6:00 PM', entry: 'Free' }
    ],
    delhi: [
      { id: 1, name: 'India Gate', category: 'Heritage Fort', description: 'War memorial arch on Rajpath, the heart of ceremonial New Delhi.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fd/India_Gate_in_New_Delhi_03-2016_img3.jpg/640px-India_Gate_in_New_Delhi_03-2016_img3.jpg', rating: 4.8, timings: 'Open 24/7', entry: 'Free' },
      { id: 2, name: 'Red Fort', category: 'Heritage Fort', description: 'Mughal-era fortress and UNESCO site where the Prime Minister hoists the flag on Independence Day.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2f/Red_Fort_in_Delhi_03-2016.jpg/640px-Red_Fort_in_Delhi_03-2016.jpg', rating: 4.7, timings: '9:30 AM – 4:30 PM', entry: '₹35' },
      { id: 3, name: 'Qutub Minar', category: 'Heritage Fort', description: '73-metre victory tower and the tallest brick minaret in the world.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3c/Qutub_Minar_in_the_monsoons.jpg/640px-Qutub_Minar_in_the_monsoons.jpg', rating: 4.6, timings: '7:00 AM – 5:00 PM', entry: '₹30' },
      { id: 4, name: 'Lotus Temple', category: 'Temple', description: 'Striking Baháʼí House of Worship shaped like a blooming lotus flower.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4b/Lotus_temple_in_India.jpg/640px-Lotus_temple_in_India.jpg', rating: 4.6, timings: '9:00 AM – 5:30 PM', entry: 'Free' },
      { id: 5, name: 'Humayun\'s Tomb', category: 'Heritage Fort', description: 'Garden tomb that inspired the Taj Mahal — a masterpiece of Mughal architecture.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/Humayun%27s_Tomb%2C_Delhi.jpg/640px-Humayun%27s_Tomb%2C_Delhi.jpg', rating: 4.7, timings: '6:00 AM – 6:00 PM', entry: '₹30' },
      { id: 6, name: 'Akshardham', category: 'Temple', description: 'Sprawling Hindu temple complex with exhibitions, gardens, and a musical fountain.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8e/Akshardham_Temple_-_Delhi.jpg/640px-Akshardham_Temple_-_Delhi.jpg', rating: 4.8, timings: '10:00 AM – 6:30 PM', entry: 'Free (exhibits extra)' },
      { id: 7, name: 'Chandni Chowk', category: 'Attraction', description: 'Legendary Old Delhi bazaar — spices, jewellery, street food, and Mughal lanes.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5c/Crowded_street_-_geograph.org.uk_-_1002342.jpg/640px-Crowded_street_-_geograph.org.uk_-_1002342.jpg', rating: 4.5, timings: '10:00 AM – 9:00 PM', entry: 'Free' },
      { id: 8, name: 'Connaught Place', category: 'Attraction', description: 'Colonial-era circular market and Delhi\'s commercial and nightlife hub.', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5c/Crowded_street_-_geograph.org.uk_-_1002342.jpg/640px-Crowded_street_-_geograph.org.uk_-_1002342.jpg', rating: 4.4, timings: 'Open 24/7', entry: 'Free' }
    ]
  };

  let places = cityFallbacks[city.toLowerCase()];
  
  if (!places) {
    try {
      const searchRes = await axios.get(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=landmarks%20in%20${encodeURIComponent(city)}&utf8=&format=json`, {
        headers: { 'User-Agent': 'NOMAD-App/1.0 (aditi@example.com)' }, timeout: 5000
      });
      const searchResults = searchRes.data?.query?.search || [];
      places = [];
      let idCounter = 1;
      
      for (const result of searchResults.slice(0, 6)) {
        if (result.title.toLowerCase() === city.toLowerCase() || result.title.includes('List of')) continue;
        
        const wikiData = await getWikipediaImage(result.title);
        
        places.push({
          id: idCounter++,
          name: result.title,
          category: 'Attraction',
          description: wikiData?.description || result.snippet.replace(/<\/?[^>]+(>|$)/g, "").slice(0, 100) + '...',
          image: wikiData?.image || 'https://images.unsplash.com/photo-1518998053901-5348d3961a04?w=600&q=80',
          rating: (4.0 + Math.random()).toFixed(1),
          timings: 'Varies',
          entry: 'Standard'
        });
      }
      
      if (places.length === 0) throw new Error("No landmarks found");
    } catch (e) {
      places = [
        { id: 1, name: `${capCity} Museum`, category: 'Museum', description: `Explore the rich history and heritage of ${capCity}.`, image: 'https://images.unsplash.com/photo-1518998053901-5348d3961a04?w=600&q=80', rating: 4.5, timings: '10:00 AM - 5:00 PM', entry: 'Standard' }
      ];
    }
  } else {
    // Attempt to fetch wiki images for curated places if they somehow use unsplash
    for (let p of places) {
      if (p.image && p.image.includes('unsplash.com')) {
         const wiki = await getWikipediaImage(p.name);
         if (wiki && wiki.image) p.image = wiki.image;
      }
    }
  }

  res.json({ success: true, places, source: 'Curated' });
});

// GET /api/foods/:city — fetches curated famous local foods with best places to eat
app.get('/api/foods/:city', async (req, res) => {
  const city = req.params.city.toLowerCase();
  const capCity = city.charAt(0).toUpperCase() + city.slice(1);
  
  // Curated food data — images fetched live from Wikipedia (see below)
  const curatedFoods = {
    hyderabad: [
      { id: 'f1', name: 'Hyderabadi Biryani', type: 'Local Famous', description: 'World-famous slow-cooked basmati rice with marinated meat, spices, and saffron.', image: null, must_try_at: 'Paradise, Pista House, Shah Ghouse', price_range: 'Moderate', reviews: [], avg_rating: 4.8 },
      { id: 'f2', name: 'Haleem', type: 'Specialty', description: 'A rich, savory stew of pounded meat, lentils, and wheat, slow-cooked for hours.', image: null, must_try_at: 'Pista House, Cafe 555', price_range: 'Moderate', reviews: [], avg_rating: 4.9 },
      { id: 'f3', name: 'Double Ka Meetha', type: 'Dessert', description: 'Traditional bread pudding dessert made with fried bread slices soaked in hot milk with saffron.', image: null, must_try_at: 'Karachi Bakery, Nimrah Cafe', price_range: 'Low', reviews: [], avg_rating: 4.6 },
      { id: 'f4', name: 'Irani Chai', type: 'Street Food', description: 'Iconic thick milky tea served alongside buttery Osmania biscuits.', image: null, must_try_at: 'Nimrah Cafe, Niloufer Cafe', price_range: 'Low', reviews: [], avg_rating: 4.7 },
      { id: 'f5', name: 'Qubani Ka Meetha', type: 'Dessert', description: 'Traditional Hyderabadi dessert of stewed apricots topped with fresh cream.', image: null, must_try_at: 'Hotel Shadab, Paradise', price_range: 'Low', reviews: [], avg_rating: 4.5 },
      { id: 'f6', name: 'Lukhmi', type: 'Street Food', description: 'Flaky pastry pockets stuffed with spiced minced meat — the Hyderabadi samosa.', image: null, must_try_at: 'Old City, Charminar area', price_range: 'Low', reviews: [], avg_rating: 4.6 }
    ],
    mumbai: [
      { id: 'f1', name: 'Vada Pav', type: 'Street Food', description: 'The lifeline of Mumbai - deep fried potato dumpling inside a bread bun.', image: null, must_try_at: 'Ashok Vada Pav, Aaram Vada Pav', price_range: 'Low', reviews: [], avg_rating: 4.8 },
      { id: 'f2', name: 'Pav Bhaji', type: 'Local Famous', description: 'Spicy mash of vegetables served hot with butter-soaked bread.', image: null, must_try_at: 'Sardar Pav Bhaji, Cannon Pav Bhaji', price_range: 'Moderate', reviews: [], avg_rating: 4.7 },
      { id: 'f3', name: 'Pani Puri', type: 'Street Food', description: 'Crispy hollow puris filled with tangy tamarind water and spiced potato.', image: null, must_try_at: 'Elco Market, Juhu Beach stalls', price_range: 'Low', reviews: [], avg_rating: 4.8 },
      { id: 'f4', name: 'Bombay Sandwich', type: 'Street Food', description: 'Toasted sandwich layered with chutney, cucumber, tomato, and masala potatoes.', image: null, must_try_at: 'Churchgate stalls, Dadar market', price_range: 'Low', reviews: [], avg_rating: 4.6 }
    ],
    bangalore: [
      { id: 'f1', name: 'Masala Dosa', type: 'Local Delicacy', description: 'Crispy rice crepe stuffed with spiced potato filling, served with chutneys.', image: null, must_try_at: 'CTR, Vidyarthi Bhavan, MTR', price_range: 'Moderate', reviews: [], avg_rating: 4.8 },
      { id: 'f2', name: 'Filter Coffee', type: 'Beverage', description: 'Strong, frothy traditional South Indian coffee brewed in a metal tumbler.', image: null, must_try_at: 'MTR, Brahmin\'s Coffee Bar, Koshy\'s', price_range: 'Low', reviews: [], avg_rating: 4.9 },
      { id: 'f3', name: 'Akki Roti', type: 'Local Delicacy', description: 'Rice flour flatbread with vegetables and spices — a Karnataka staple.', image: null, must_try_at: 'Brahmin\'s Coffee Bar, Vidyarthi Bhavan', price_range: 'Low', reviews: [], avg_rating: 4.6 },
      { id: 'f4', name: 'Bisi Bele Bath', type: 'Local Famous', description: 'Hot lentil rice dish cooked with tamarind, vegetables, and aromatic spices.', image: null, must_try_at: 'MTR, Mavalli Tiffin Rooms', price_range: 'Low', reviews: [], avg_rating: 4.7 }
    ],
    delhi: [
      { id: 'f1', name: 'Butter Chicken', type: 'Local Famous', description: 'Iconic creamy tomato-based chicken curry born in Delhi\'s kitchens.', image: null, must_try_at: 'Moti Mahal, Kake Da Hotel', price_range: 'Moderate', reviews: [], avg_rating: 4.9 },
      { id: 'f2', name: 'Chole Bhature', type: 'Street Food', description: 'Fluffy fried bread with spicy chickpea curry — the ultimate Delhi breakfast.', image: null, must_try_at: 'Sitaram Diwan Chand, Kwality', price_range: 'Low', reviews: [], avg_rating: 4.8 },
      { id: 'f3', name: 'Paranthe Wali Gali', type: 'Street Food', description: 'Famous Chandni Chowk stuffed parathas with unusual fillings like rabri and dry fruits.', image: null, must_try_at: 'Paranthe Wali Gali, Chandni Chowk', price_range: 'Low', reviews: [], avg_rating: 4.7 },
      { id: 'f4', name: 'Kebabs', type: 'Local Famous', description: 'Smoky seekh and galouti kebabs from Old Delhi\'s legendary grill houses.', image: null, must_try_at: 'Karim\'s, Al Jawahar, Qureshi Kabab', price_range: 'Moderate', reviews: [], avg_rating: 4.8 },
      { id: 'f5', name: 'Chole Kulche', type: 'Street Food', description: 'Soft kulcha bread with tangy chole — a Delhi street-food classic.', image: null, must_try_at: 'Chache Di Hatti, Nagpal Chole Bhature', price_range: 'Low', reviews: [], avg_rating: 4.6 },
      { id: 'f6', name: 'Dahi Bhalla', type: 'Street Food', description: 'Lentil dumplings in creamy yogurt with chutneys and chaat masala.', image: null, must_try_at: 'Natraj Dahi Bhalle Wala, Bikanervala', price_range: 'Low', reviews: [], avg_rating: 4.5 }
    ],
    chennai: [
      { id: 'f1', name: 'Idli Sambhar', type: 'Local Delicacy', description: 'Soft steamed rice cakes served with lentil vegetable stew and chutneys.', image: null, must_try_at: 'Saravana Bhavan, Murugan Idli Shop', price_range: 'Low', reviews: [], avg_rating: 4.8 },
      { id: 'f2', name: 'Chettinad Chicken Curry', type: 'Local Famous', description: 'Fiery aromatic curry with distinctive Chettinad spices and kalpasi.', image: null, must_try_at: 'Anjappar, Ponnusamy Hotel', price_range: 'Moderate', reviews: [], avg_rating: 4.9 },
      { id: 'f3', name: 'Kothu Parotta', type: 'Street Food', description: 'Flaky bread shredded and stir-fried with egg, onions, and spices.', image: null, must_try_at: 'Burma Bazaar, street stalls', price_range: 'Low', reviews: [], avg_rating: 4.7 }
    ],
    kolkata: [
      { id: 'f1', name: 'Kathi Roll', type: 'Street Food', description: 'Paratha wrapped around spiced egg and meat filling — invented in Kolkata.', image: null, must_try_at: 'Nizam\'s, Hot Kathi Rolls', price_range: 'Low', reviews: [], avg_rating: 4.8 },
      { id: 'f2', name: 'Rosogolla', type: 'Dessert', description: 'Spongy cottage cheese balls soaked in light sugar syrup — a Bengal original.', image: null, must_try_at: 'K.C. Das, Balaram Mullick', price_range: 'Low', reviews: [], avg_rating: 4.9 },
      { id: 'f3', name: 'Hilsa Fish Curry', type: 'Local Famous', description: 'Hilsa fish cooked in mustard paste — the pride of Bengali cuisine.', image: null, must_try_at: '6 Ballygunge Place, Bhojohori Manna', price_range: 'Moderate', reviews: [], avg_rating: 4.8 }
    ]
  };

  let foods = curatedFoods[city] || [
    { id: 'f1', name: `${capCity} Signature Dish`, type: 'Local Delicacy', description: `A must-try when visiting ${capCity}.`, image: null, must_try_at: 'Downtown Kitchen', price_range: 'Varies', reviews: [], avg_rating: 4.5 }
  ];

  // Fetch real Wikipedia images for each food item concurrently
  const imagePromises = foods.map(f => getFoodImage(f.name));
  const images = await Promise.allSettled(imagePromises);
  foods.forEach((f, i) => {
    const result = images[i];
    if (result.status === 'fulfilled' && result.value) {
      f.image = result.value;
    } else {
      // Absolute fallback: unsplash with food name
      f.image = unsplashSearch(f.name + ' food dish');
    }
  });

  // Attach reviews and order links
  for (let f of foods) {
    try {
      const dbReviews = await FoodReview.find({ city, restaurant_name: f.name }).sort({ createdAt: -1 });
      f.reviews = dbReviews.map((r) => ({
        user: r.user_name,
        text: r.review_text,
        stars: r.stars,
        created_at: r.createdAt,
      }));
      f.avg_rating = dbReviews.length > 0
        ? (dbReviews.reduce((s, r) => s + r.stars, 0) / dbReviews.length).toFixed(1)
        : f.avg_rating;
    } catch (e) {
      console.error(e);
    }
    const encodedName = encodeURIComponent(f.name + ' ' + capCity);
    f.order_links = {
      zomato: `https://www.zomato.com/search?q=${encodedName}`,
      swiggy: `https://www.swiggy.com/search?query=${encodedName}`
    };
  }

  res.json({ success: true, foods, source: 'Curated' });
});

// GET /api/reviews/:city/:restaurant — fetch reviews for a restaurant
app.get('/api/reviews/:city/:restaurant', async (req, res) => {
  try {
    const rows = await FoodReview.find({
      city: req.params.city.toLowerCase(),
      restaurant_name: decodeURIComponent(req.params.restaurant),
    })
      .sort({ createdAt: -1 })
      .limit(20);
    res.json({ success: true, reviews: toApiDocs(rows) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch reviews' });
  }
});

// POST /api/reviews — submit a user review
app.post('/api/reviews', async (req, res) => {
  const { city, restaurant_name, user_name, stars, review_text } = req.body;
  if (!city || !restaurant_name || !user_name || !review_text || !stars) {
    return res.status(400).json({ success: false, message: 'All fields are required' });
  }
  if (stars < 1 || stars > 5) {
    return res.status(400).json({ success: false, message: 'Stars must be 1-5' });
  }
  try {
    await FoodReview.create({
      city: city.toLowerCase(),
      restaurant_name,
      user_name,
      stars: parseInt(stars, 10),
      review_text,
    });
    res.json({ success: true, message: 'Review submitted successfully' });
  } catch (err) {
    console.error('Review submit error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit review' });
  }
});

// GET /api/community/posts?city=hyderabad — fetch community posts
app.get('/api/community/posts', async (req, res) => {
  const city = req.query.city || 'hyderabad';
  try {
    const rows = await CommunityPost.find({ city: city.toLowerCase() })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ success: true, posts: toApiDocs(rows) });
  } catch (err) {
    console.error('Community fetch error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch community posts' });
  }
});

// POST /api/community/posts — create a community post
app.post('/api/community/posts', async (req, res) => {
  const { city, author_name, content } = req.body;
  if (!city || !author_name || !content) {
    return res.status(400).json({ success: false, message: 'city, author_name and content are required' });
  }
  if (content.length > 500) {
    return res.status(400).json({ success: false, message: 'Post too long (max 500 characters)' });
  }
  try {
    await CommunityPost.create({
      city: city.toLowerCase(),
      author_name,
      content,
    });
    res.json({ success: true, message: 'Post created successfully' });
  } catch (err) {
    console.error('Community post error:', err);
    res.status(500).json({ success: false, message: 'Failed to create post' });
  }
});

// City coordinates for map centering
const CITY_COORDS = {
  hyderabad: { lat: 17.385, lon: 78.4867 }, mumbai: { lat: 19.076, lon: 72.8777 },
  delhi: { lat: 28.6139, lon: 77.209 }, bangalore: { lat: 12.9716, lon: 77.5946 },
  chennai: { lat: 13.0827, lon: 80.2707 }, kolkata: { lat: 22.5726, lon: 88.3639 },
  pune: { lat: 18.5204, lon: 73.8567 }, jaipur: { lat: 26.9124, lon: 75.7873 },
  ahmedabad: { lat: 23.0225, lon: 72.5714 }, lucknow: { lat: 26.8467, lon: 80.9462 },
  kochi: { lat: 9.9312, lon: 76.2673 }, dehradun: { lat: 30.3165, lon: 78.0322 },
  goa: { lat: 15.2993, lon: 74.124 }, visakhapatnam: { lat: 17.6868, lon: 83.2185 },
};

// Popular landmarks per city for fare estimator
const CITY_LANDMARKS = {
  hyderabad: [
    { name: 'Charminar', lat: 17.3616, lon: 78.4747 },
    { name: 'HITEC City', lat: 17.4435, lon: 78.3772 },
    { name: 'Secunderabad Station', lat: 17.4344, lon: 78.5013 },
    { name: 'Rajiv Gandhi Intl Airport', lat: 17.2403, lon: 78.4294 },
    { name: 'Gachibowli', lat: 17.4401, lon: 78.3489 },
    { name: 'Banjara Hills', lat: 17.4156, lon: 78.4347 },
    { name: 'Jubilee Hills', lat: 17.4325, lon: 78.4076 },
    { name: 'Golconda Fort', lat: 17.3833, lon: 78.4011 },
    { name: 'Tank Bund', lat: 17.4239, lon: 78.4738 },
    { name: 'LB Nagar', lat: 17.3457, lon: 78.5522 },
    { name: 'Ameerpet', lat: 17.4375, lon: 78.4483 },
    { name: 'Kukatpally', lat: 17.4849, lon: 78.3883 },
    { name: 'Madhapur', lat: 17.4486, lon: 78.3908 },
    { name: 'Begumpet', lat: 17.4434, lon: 78.4677 },
    { name: 'Mehdipatnam', lat: 17.3950, lon: 78.4422 },
    { name: 'Dilsukhnagar', lat: 17.3688, lon: 78.5247 },
    { name: 'Uppal', lat: 17.4017, lon: 78.5589 },
    { name: 'Shamshabad', lat: 17.2543, lon: 78.4286 },
    { name: 'Kondapur', lat: 17.4600, lon: 78.3548 },
    { name: 'Miyapur', lat: 17.4969, lon: 78.3548 },
  ],
  mumbai: [
    { name: 'CST (Chhatrapati Shivaji Terminus)', lat: 18.9398, lon: 72.8354 },
    { name: 'Bandra', lat: 19.0544, lon: 72.8404 },
    { name: 'Andheri', lat: 19.1136, lon: 72.8697 },
    { name: 'Mumbai Airport', lat: 19.0896, lon: 72.8656 },
    { name: 'Colaba', lat: 18.9067, lon: 72.8147 },
    { name: 'Dadar', lat: 19.0178, lon: 72.8478 },
    { name: 'Powai', lat: 19.1176, lon: 72.9060 },
    { name: 'Juhu Beach', lat: 19.0987, lon: 72.8267 },
    { name: 'Lower Parel', lat: 18.9932, lon: 72.8313 },
    { name: 'Churchgate', lat: 18.9329, lon: 72.8268 },
  ],
  bangalore: [
    { name: 'MG Road', lat: 12.9756, lon: 77.6068 },
    { name: 'Koramangala', lat: 12.9352, lon: 77.6245 },
    { name: 'Whitefield', lat: 12.9698, lon: 77.7500 },
    { name: 'Electronic City', lat: 12.8452, lon: 77.6602 },
    { name: 'Kempegowda Airport', lat: 13.1986, lon: 77.7066 },
    { name: 'Indiranagar', lat: 12.9719, lon: 77.6412 },
    { name: 'Jayanagar', lat: 12.9308, lon: 77.5838 },
    { name: 'Majestic', lat: 12.9767, lon: 77.5713 },
    { name: 'HSR Layout', lat: 12.9116, lon: 77.6389 },
    { name: 'Marathahalli', lat: 12.9591, lon: 77.7009 },
  ],
  delhi: [
    { name: 'Connaught Place', lat: 28.6315, lon: 77.2167 },
    { name: 'India Gate', lat: 28.6129, lon: 77.2295 },
    { name: 'IGI Airport', lat: 28.5562, lon: 77.1000 },
    { name: 'New Delhi Station', lat: 28.6424, lon: 77.2195 },
    { name: 'Chandni Chowk', lat: 28.6506, lon: 77.2300 },
    { name: 'Hauz Khas', lat: 28.5494, lon: 77.2001 },
    { name: 'Saket', lat: 28.5244, lon: 77.2066 },
    { name: 'Dwarka', lat: 28.5921, lon: 77.0460 },
    { name: 'Noida Sector 18', lat: 28.5707, lon: 77.3219 },
    { name: 'Gurugram Cyber Hub', lat: 28.4949, lon: 77.0887 },
  ],
  chennai: [
    { name: 'Chennai Central', lat: 13.0827, lon: 80.2707 },
    { name: 'T. Nagar', lat: 13.0418, lon: 80.2341 },
    { name: 'Anna Nagar', lat: 13.0850, lon: 80.2101 },
    { name: 'Chennai Airport', lat: 12.9941, lon: 80.1709 },
    { name: 'Marina Beach', lat: 13.0500, lon: 80.2824 },
    { name: 'Adyar', lat: 13.0067, lon: 80.2544 },
    { name: 'Velachery', lat: 12.9815, lon: 80.2180 },
    { name: 'Tambaram', lat: 12.9249, lon: 80.1000 },
  ],
};

// Haversine distance in km
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Indian city fare rates (max estimates)
const FARE_RATES = {
  bus:       { base: 10,  perKm: 1.5,  minFare: 10,  icon: '🚌', label: 'City Bus' },
  auto:      { base: 25,  perKm: 12,   minFare: 30,  icon: '🛺', label: 'Auto Rickshaw' },
  cab:       { base: 50,  perKm: 14,   minFare: 80,  icon: '🚕', label: 'Cab (Sedan)' },
  bikeTaxi:  { base: 15,  perKm: 5,    minFare: 20,  icon: '🏍️', label: 'Bike Taxi' },
};

// Local transport recommendations by city
const LOCAL_ROUTES = {
  hyderabad: [
    { from: 'Secunderabad Station', to: 'Charminar', mode: 'Metro + Auto', tip: 'Take Blue Line to Charminar metro, then auto for 5 min', time: '35 min', cost: '₹40-60' },
    { from: 'HITEC City', to: 'Golconda Fort', mode: 'Bus / Cab', tip: 'TSRTC Bus 127 or book an Uber. Avoid peak hours.', time: '45 min', cost: '₹30-250' },
    { from: 'Gachibowli', to: 'Tank Bund', mode: 'Metro', tip: 'Take Green Line from Raidurg to Ameerpet, switch to Blue Line', time: '40 min', cost: '₹35' },
    { from: 'Airport (RGIA)', to: 'Banjara Hills', mode: 'Cab / Bus', tip: 'Pushpak airport bus to Lakdi ka Pul. Uber costs ~₹500', time: '45-70 min', cost: '₹200-600' },
    { from: 'LB Nagar', to: 'Hussain Sagar', mode: 'Metro', tip: 'Direct Blue Line metro to Lakdi ka Pul, walk to the lake', time: '30 min', cost: '₹30' },
  ],
  delhi: [
    { from: 'New Delhi Station', to: 'India Gate', mode: 'Metro / Auto', tip: 'Yellow Line to Central Secretariat, then walk or auto', time: '20 min', cost: '₹30-80' },
    { from: 'Chandni Chowk', to: 'Red Fort', mode: 'Walk / Metro', tip: '5-minute walk from Chandni Chowk metro to Lahori Gate', time: '10 min', cost: 'Free-₹30' },
    { from: 'Connaught Place', to: 'Hauz Khas', mode: 'Metro', tip: 'Yellow Line to Green Park, short auto to Hauz Khas Village', time: '25 min', cost: '₹40-60' },
    { from: 'IGI Airport', to: 'Saket', mode: 'Metro / Cab', tip: 'Airport Express to New Delhi, then Yellow Line to Saket', time: '50-70 min', cost: '₹100-500' },
    { from: 'Dwarka', to: 'Akshardham', mode: 'Metro', tip: 'Blue Line to Rajiv Chowk, switch to Violet Line to Akshardham', time: '55 min', cost: '₹50' },
  ],
};

// GET /api/transport/:city — transport info, local routes, transit stops
app.get('/api/transport/:city', async (req, res) => {
  const city = req.params.city.toLowerCase();
  const capCity = city.charAt(0).toUpperCase() + city.slice(1);
  const coords = CITY_COORDS[city] || { lat: 20.5937, lon: 78.9629 };
  const routes = LOCAL_ROUTES[city] || [
    { from: 'City Center', to: 'Airport', mode: 'Cab / Bus', tip: 'Use Uber or local bus service', time: '40-60 min', cost: 'Varies' },
    { from: 'Railway Station', to: 'Old City', mode: 'Auto / Metro', tip: 'Auto-rickshaws are cheapest for short distances', time: '20-30 min', cost: '₹30-80' },
  ];

  let transitStops = [];
  try {
    const query = `[out:json];area[name="${capCity}"]->.searchArea;node["public_transport"~"station|stop_position"](area.searchArea);out 15;`;
    const response = await axios.post('https://overpass-api.de/api/interpreter', query, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'NOMAD-App/1.0' },
      timeout: 6000
    });
    if (response.data?.elements) {
      transitStops = response.data.elements.filter(e => e.tags?.name).slice(0, 15).map(e => ({
        id: e.id, name: e.tags.name, type: e.tags.railway ? 'Metro/Rail' : (e.tags.bus ? 'Bus' : 'Transit'),
        lat: e.lat, lon: e.lon
      }));
    }
  } catch (err) {
    console.error('Transport Overpass error:', err.message);
  }

  const encodedCity = encodeURIComponent(capCity);
  res.json({
    success: true,
    city: capCity,
    coords,
    routes,
    transitStops,
    appLinks: {
      uber: `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[formatted_address]=${encodedCity}`,
      rapido: `https://www.rapido.bike/`,
      google_maps: `https://www.google.com/maps/search/transit+near+${encodedCity}`
    },
    mapUrl: `https://www.openstreetmap.org/export/embed.html?bbox=${coords.lon-0.05}%2C${coords.lat-0.04}%2C${coords.lon+0.05}%2C${coords.lat+0.04}&layer=mapnik&marker=${coords.lat}%2C${coords.lon}`
  });
});

// GET /api/transport/:city/locations — popular locations for fare estimator
app.get('/api/transport/:city/locations', (req, res) => {
  const city = req.params.city.toLowerCase();
  const landmarks = CITY_LANDMARKS[city];
  if (landmarks) {
    return res.json({ success: true, locations: landmarks });
  }
  // Fallback: generic locations
  const capCity = city.charAt(0).toUpperCase() + city.slice(1);
  const coords = CITY_COORDS[city] || { lat: 20.5937, lon: 78.9629 };
  const fallback = [
    { name: `${capCity} Central`, lat: coords.lat, lon: coords.lon },
    { name: `${capCity} Airport`, lat: coords.lat + 0.08, lon: coords.lon - 0.05 },
    { name: `${capCity} Railway Station`, lat: coords.lat - 0.02, lon: coords.lon + 0.01 },
    { name: `${capCity} Bus Stand`, lat: coords.lat + 0.01, lon: coords.lon - 0.02 },
    { name: `${capCity} Old City`, lat: coords.lat - 0.03, lon: coords.lon + 0.02 },
  ];
  res.json({ success: true, locations: fallback });
});

// POST /api/transport/estimate-fare — calculate fare estimates
app.post('/api/transport/estimate-fare', (req, res) => {
  const { originLat, originLon, destLat, destLon, originName, destName } = req.body;
  if (!originLat || !originLon || !destLat || !destLon) {
    return res.status(400).json({ success: false, message: 'Origin and destination coordinates are required' });
  }
  const straightDist = haversineDistance(originLat, originLon, destLat, destLon);
  // Road distance is typically 1.3-1.5x straight-line distance
  const roadDist = straightDist * 1.4;
  const avgSpeed = { bus: 18, auto: 22, cab: 28, bikeTaxi: 25 };

  const estimates = Object.entries(FARE_RATES).map(([mode, rate]) => {
    const rawFare = rate.base + (roadDist * rate.perKm);
    const fare = Math.max(rate.minFare, Math.ceil(rawFare / 5) * 5); // Round up to nearest 5
    const timeMin = Math.round((roadDist / avgSpeed[mode]) * 60);
    return {
      mode,
      label: rate.label,
      icon: rate.icon,
      fare,
      distance: Math.round(roadDist * 10) / 10,
      time: timeMin < 60 ? `${timeMin} min` : `${Math.floor(timeMin / 60)}h ${timeMin % 60}m`,
    };
  });

  res.json({
    success: true,
    origin: originName || 'Origin',
    destination: destName || 'Destination',
    distance: Math.round(roadDist * 10) / 10,
    estimates,
  });
});

// GET /api/carpool/posts?city=xxx — fetch carpool offers
app.get('/api/carpool/posts', async (req, res) => {
  const city = req.query.city || 'hyderabad';
  try {
    const rows = await CarpoolPost.find({ city: city.toLowerCase() })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ success: true, posts: toApiDocs(rows) });
  } catch (err) {
    console.error('Carpool fetch error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch carpool posts' });
  }
});

// POST /api/carpool/posts — create a carpool offer
app.post('/api/carpool/posts', async (req, res) => {
  const { city, author_name, origin, destination, travel_date, travel_time, seats, note } = req.body;
  if (!city || !author_name || !origin || !destination || !travel_date || !travel_time || !seats) {
    return res.status(400).json({ success: false, message: 'All fields except note are required' });
  }
  try {
    await CarpoolPost.create({
      city: city.toLowerCase(),
      author_name,
      origin,
      destination,
      travel_date,
      travel_time,
      seats: parseInt(seats, 10) || 1,
      note: note || undefined,
    });
    res.json({ success: true, message: 'Carpool offer posted successfully' });
  } catch (err) {
    console.error('Carpool post error:', err);
    res.status(500).json({ success: false, message: 'Failed to create carpool post' });
  }
});

// GET /api/accommodations/:city — fetch mock accommodations (PGs, Flats)
app.get('/api/accommodations/:city', async (req, res) => {
  const city = req.params.city.toLowerCase();
  const capCity = city.charAt(0).toUpperCase() + city.slice(1);
  const type = req.query.type; // 'pg', 'flat', or 'rental'
  
  // Real apartment/room images from Wikimedia Commons
  const ROOM_PICS = [
    'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/Single_room_with_a_double_bed.jpg/640px-Single_room_with_a_double_bed.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/2/21/Simple_living_room.jpg/640px-Simple_living_room.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4e/Interior_design_living_room.jpg/640px-Interior_design_living_room.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c9/Master_bedroom.jpg/640px-Master_bedroom.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d3/Hicks_in_the_lobby.jpg/640px-Hicks_in_the_lobby.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d9/Bedroom_in_the_Louvre_Museum_-_geograph.org.uk_-_1213702.jpg/640px-Bedroom_in_the_Louvre_Museum_-_geograph.org.uk_-_1213702.jpg'
  ];

  let data = [];
  try {
    const cheerio = await import('cheerio');
    const response = await axios.get(`https://www.nobroker.in/flats-for-rent-in-${city}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 8000
    });
    const $ = cheerio.load(response.data);
    
    let idCounter = 1;
    $('.bg-white').each((i, el) => {
      if (idCounter > 12) return;
      const title = $(el).find('h2').text().trim();
      if (!title) return;
      
      const priceText = $(el).find('#roomType').parent().text().trim() || $(el).find('.font-semi-bold.heading-6').first().text().trim();
      let priceMatch = priceText.match(/[\d,]+/);
      let price = 15000;
      if (priceMatch) {
         price = parseInt(priceMatch[0].replace(/,/g, ''));
         if (price < 1000) price = price * 1000;
      }

      let furnishing = 'Semi-Furnished';
      const textContent = $(el).text().toLowerCase();
      if (textContent.includes('fully furnished')) furnishing = 'Fully-Furnished';
      else if (textContent.includes('unfurnished')) furnishing = 'Unfurnished';

      let accType = 'Flat';
      if (title.toLowerCase().includes('pg') || title.toLowerCase().includes('hostel')) accType = 'PG';
      else if (title.toLowerCase().includes('house') || title.toLowerCase().includes('villa')) accType = 'Rental';

      const imgNode = $(el).find('img').first();
      let image = imgNode.attr('src') || imgNode.attr('data-src');
      if (!image || !image.startsWith('http')) {
        image = ROOM_PICS[idCounter % ROOM_PICS.length];
      }

      data.push({
        id: `acc-${idCounter++}`,
        source: 'NoBroker',
        furnishing,
        name: title,
        type: accType,
        price: price,
        deposit: price * 3,
        amenities: ['Parking', 'Security'],
        rating: (4.0 + Math.random()).toFixed(1),
        image: image,
        address: capCity,
        reviews: [{user: 'User', rating: 4, text: 'Verified listing.'}]
      });
    });
  } catch (err) {
    console.error('NoBroker scrape error:', err.message);
  }

  // Fallback to mock data if scraping fails
  if (data.length === 0) {
    const areas = city === 'delhi'
      ? ['Connaught Place', 'Hauz Khas', 'Saket', 'Dwarka', 'Karol Bagh', 'Lajpat Nagar']
      : ['Gachibowli', 'Madhapur', 'Kondapur', 'Banjara Hills', 'Jubilee Hills', 'Hi-Tech City'];
    data = [
      { id: 'acc-1', source: 'NoBroker', furnishing: 'Semi-Furnished', name: `Cozy Stay PG for Men ${capCity}`, type: 'PG', price: 8000, deposit: 8000, amenities: ['WiFi', 'Food Included', 'AC'], rating: 4.2, image: ROOM_PICS[0], address: `${areas[0]}, ${capCity}`, reviews: [{user: 'Rahul', rating: 4, text: 'Good food and wifi.'}, {user: 'Amit', rating: 5, text: 'Very clean.'}] },
      { id: 'acc-2', source: 'Housing.com', furnishing: 'Fully-Furnished', name: `Elite Women's PG`, type: 'PG', price: 12000, deposit: 12000, amenities: ['WiFi', 'Washing Machine', 'AC', 'Security'], rating: 4.7, image: ROOM_PICS[1], address: `${areas[1]}, ${capCity}`, reviews: [{user: 'Priya', rating: 5, text: 'Safe and secure.'}] },
      { id: 'acc-3', source: 'MagicBricks', furnishing: 'Fully-Furnished', name: `2BHK Fully Furnished Flat`, type: 'Flat', price: 25000, deposit: 50000, amenities: ['Gym', 'Pool', 'Parking'], rating: 4.8, image: ROOM_PICS[2], address: `${areas[2]}, ${capCity}`, reviews: [{user: 'Sandeep', rating: 5, text: 'Great society.'}] },
      { id: 'acc-4', source: 'NoBroker', furnishing: 'Unfurnished', name: `1BHK Cozy Apartment`, type: 'Flat', price: 15000, deposit: 30000, amenities: ['Parking', 'Balcony'], rating: 4.1, image: ROOM_PICS[3], address: `${areas[3]}, ${capCity}`, reviews: [{user: 'Sneha', rating: 4, text: 'A bit old but location is prime.'}] },
      { id: 'acc-5', source: 'Nestaway', furnishing: 'Fully-Furnished', name: `Luxury Co-living Space`, type: 'PG', price: 18000, deposit: 18000, amenities: ['WiFi', 'Gym', 'Food Included', 'AC', 'Housekeeping'], rating: 4.9, image: ROOM_PICS[4], address: `${areas[4]}, ${capCity}`, reviews: [{user: 'Karan', rating: 5, text: 'Best co-living space!'}] },
      { id: 'acc-6', source: 'Housing.com', furnishing: 'Semi-Furnished', name: `Spacious 3BHK Villa`, type: 'Rental', price: 40000, deposit: 100000, amenities: ['Garden', 'Parking', 'Security'], rating: 4.6, image: ROOM_PICS[5], address: `${areas[5]}, ${capCity}`, reviews: [{user: 'Megha', rating: 4, text: 'Very spacious but slightly overpriced.'}] }
    ];
  }

  if (type && type !== 'all') {
    data = data.filter(d => d.type.toLowerCase() === type.toLowerCase());
  }

  res.json({ success: true, accommodations: data });
});

async function start() {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`🚀 NOMAD backend running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err.message);
    process.exit(1);
  }
}

start();
