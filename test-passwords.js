import mysql from 'mysql2/promise';

async function testPasswords() {
  const passwords = [
    '',
    'aditi786',
    'Aditi786',
    'aaradhya1503',
    'Aaradhya1503',
    'root',
    'password',
    '1234',
    '123456',
    'admin'
  ];

  for (const pwd of passwords) {
    try {
      const conn = await mysql.createConnection({
        host: '127.0.0.1',
        user: 'root',
        password: pwd
      });
      console.log(`✅ Success with password: "${pwd}"`);
      await conn.end();
      return;
    } catch (err) {
      console.log(`❌ Failed with password: "${pwd}" - ${err.message}`);
    }
  }
}

testPasswords();
