require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'secret';

// SQLite 데이터베이스 연결
const db = new Database(path.join(__dirname, 'blog.db'));

// 1. 테이블 생성
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'user'
  );

  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    date TEXT NOT NULL,
    summary TEXT,
    content TEXT NOT NULL,
    imageUrl TEXT,
    views INTEGER DEFAULT 0
  );
`);

// 컬럼 마이그레이션
try { db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user';`); } catch (e) { }
try { db.exec(`ALTER TABLE articles ADD COLUMN imageUrl TEXT;`); } catch (e) { }
try { db.exec(`ALTER TABLE articles ADD COLUMN views INTEGER DEFAULT 0;`); } catch (e) { }

// 관리자 계정 초기화
const initAdmin = async () => {
  const adminUser = process.env.ADMIN_USERNAME || 'lsrhjru';
  const adminPass = process.env.ADMIN_PASSWORD || 'lsr37733*';
  const adminName = process.env.ADMIN_NAME || '기상청 자동 봇';

  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(adminUser);
  if (!row) {
    const hashedPassword = await bcrypt.hash(adminPass, 10);
    db.prepare('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)').run(adminUser, hashedPassword, adminName, 'admin');
    console.log('✅ 관리자 계정이 생성되었습니다.');
  }
};
initAdmin();

// 💡 CORS 설정
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Bypass-Tunnel-Reminder, ngrok-skip-browser-warning');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname)));

/* ==================================================
   🌤️ 기본 날씨 기사 자동 생성 로직 (서버 타이머용)
================================================== */
async function generateWeatherArticle() {
  try {
    const res = await fetch(
      'https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.9780&current_weather=true&hourly=relativehumidity_2m'
    );
    if (!res.ok) return;

    const data = await res.json();
    const temp = Math.round(data.current_weather.temperature);
    const windSpeed = data.current_weather.windspeed;
    const weatherCode = data.current_weather.weathercode;
    const humidity = data.hourly?.relativehumidity_2m?.[0] || 60;

    const getWeatherDesc = (code) => {
      if (code === 0) return '맑음';
      if (code >= 1 && code <= 3) return '구름 조금 및 다소 흐림';
      if (code >= 45 && code <= 48) return '짙은 안개';
      if (code >= 51 && code <= 67) return '비/이슬비';
      if (code >= 71 && code <= 77) return '눈';
      if (code >= 80 && code <= 82) return '소나기';
      if (code >= 95) return '천둥번개를 동반한 뇌우';
      return '대체로 흐림';
    };

    const weatherDesc = getWeatherDesc(weatherCode);
    const todayStr = new Date().toISOString().split('T')[0];
    const timeStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

    const title = `[기상청 속보] 오늘 수도권 날씨 기온 ${temp}°C, ${weatherDesc} 예보`;
    const summary = `현재 수도권 기온은 ${temp}°C이며 ${weatherDesc} 날씨를 보이고 있습니다. 습도는 ${humidity}%입니다.`;
    const content = `
[기상청 실시간 예보 리포트 - ${todayStr} ${timeStr} 기준]

오늘 서울 및 수도권 지역은 ${weatherDesc} 날씨가 이어지겠습니다.

• 현재 기온: ${temp}°C
• 현재 습도: ${humidity}%
• 풍속: 초속 ${windSpeed}m/s

야외 활동 시 기온과 습도 변화에 유의하시기 바라며, 외출 시 최신 기상 정보를 지속적으로 확인해 주시기 바랍니다.

- 기상청 실시간 자동 뉴스 제공
    `.trim();

    const existing = db.prepare('SELECT * FROM articles WHERE title = ?').get(title);
    if (!existing) {
      db.prepare(
        'INSERT INTO articles (category, title, author, date, summary, content, imageUrl, views) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
      ).run('날씨', title, '기상청 자동 봇', todayStr, summary, content, null);

      console.log(`🌤️ [자동 뉴스 발송] ${title}`);
    }
  } catch (err) {
    console.error('자동 날씨 기사 생성 중 오류 발생:', err);
  }
}

// JWT 검증 미들웨어
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ message: '인증 토큰이 없습니다.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: '유효하지 않거나 만료된 토큰입니다.' });
    req.user = user;
    next();
  });
};

// --- API 라우트 ---

// 📍 사용자 지역 맞춤 날씨 기사 자동 등록 API 라우트
app.post('/api/articles/auto-weather', async (req, res) => {
  const { latitude, longitude } = req.body;

  const lat = latitude || 37.5665;
  const lon = longitude || 126.9780;

  try {
    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=relativehumidity_2m`
    );
    if (!weatherRes.ok) return res.status(400).json({ message: '날씨 정보를 가져올 수 없습니다.' });

    const data = await weatherRes.json();
    const temp = Math.round(data.current_weather.temperature);
    const weatherCode = data.current_weather.weathercode;
    const humidity = data.hourly?.relativehumidity_2m?.[0] || 60;
    const windSpeed = data.current_weather.windspeed;

    let regionName = '해당 지역';
    try {
      const geoRes = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=ko`);
      if (geoRes.ok) {
        const geoData = await geoRes.json();
        regionName = geoData.principalSubdivision || geoData.city || geoData.locality || '해당 지역';
      }
    } catch (e) {
      console.log('도시명 변환 실패, 기본 이름 사용');
    }

    const getWeatherDesc = (code) => {
      if (code === 0) return '맑음';
      if (code >= 1 && code <= 3) return '구름 조금 및 흐림';
      if (code >= 45 && code <= 48) return '짙은 안개';
      if (code >= 51 && code <= 67) return '비/이슬비';
      if (code >= 71 && code <= 77) return '눈';
      if (code >= 80 && code <= 82) return '소나기';
      if (code >= 95) return '천둥번개 뇌우';
      return '대체로 흐림';
    };

    const weatherDesc = getWeatherDesc(weatherCode);
    const todayStr = new Date().toISOString().split('T')[0];
    const timeStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

    const title = `[기상청 속보] ${regionName} 실시간 날씨 기온 ${temp}°C (${weatherDesc})`;
    const summary = `현재 ${regionName} 지역 기온은 ${temp}°C이며 ${weatherDesc} 날씨를 보이고 있습니다.`;
    const content = `
[기상청 지역별 실시간 예보 - ${regionName} (${todayStr} ${timeStr} 기준)]

현재 ${regionName} 지역의 날씨 정보를 알려드립니다.

• 현재 기온: ${temp}°C
• 기상 상태: ${weatherDesc}
• 현재 습도: ${humidity}%
• 풍속: 초속 ${windSpeed}m/s

${regionName} 주민 여러분께서는 외출 시 기온 변화 및 기상 상황을 참고하시기 바랍니다.

- 기상청 지역 맞춤 자동 기사 시스템
    `.trim();

    const existing = db.prepare('SELECT * FROM articles WHERE title = ?').get(title);
    if (!existing) {
      db.prepare(
        'INSERT INTO articles (category, title, author, date, summary, content, imageUrl, views) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
      ).run('날씨', title, '기상청 자동 봇', todayStr, summary, content, null);

      console.log(`🌤️ [지역 기사 자동 생성 완료] ${title}`);
      return res.status(201).json({ message: '지역 맞춤 기사가 등록되었습니다.', title });
    }

    res.json({ message: '이미 최신 기사가 등록되어 있습니다.' });
  } catch (err) {
    console.error('지역 날씨 기사 자동 생성 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 로그인
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return res.status(401).json({ message: '아이디 또는 비밀번호가 올바르지 않습니다.' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: '아이디 또는 비밀번호가 올바르지 않습니다.' });

    const userRole = user.role || 'user';
    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name, role: userRole },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({ token, user: { username: user.username, name: user.name, role: userRole } });
  } catch (error) {
    res.status(500).json({ message: '서버 에러가 발생했습니다.' });
  }
});

// 게시글 목록 조회
app.get('/api/articles', (req, res) => {
  try {
    const articles = db.prepare('SELECT * FROM articles ORDER BY id DESC').all();
    res.json(articles);
  } catch (error) {
    res.status(500).json({ message: '게시글 목록을 불러오지 못했습니다.' });
  }
});

// 게시글 상세 조회
app.get('/api/articles/:id', (req, res) => {
  try {
    db.prepare('UPDATE articles SET views = views + 1 WHERE id = ?').run(req.params.id);
    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
    if (!article) return res.status(404).json({ message: '게시글을 찾을 수 없습니다.' });
    res.json(article);
  } catch (error) {
    res.status(500).json({ message: '게시글을 불러오지 못했습니다.' });
  }
});

// 게시글 작성
app.post('/api/articles', authenticateToken, (req, res) => {
  const { category, title, content, summary, imageUrl } = req.body;

  const safeCategory = category || '기타';
  const safeTitle = title || '제목 없음';
  const safeContent = content || '';
  const safeAuthor = req.user?.name || req.user?.username || '관리자';
  const safeDate = new Date().toISOString().split('T')[0];
  const safeSummary = summary || safeContent.substring(0, 100) || '';
  const safeImageUrl = imageUrl || null;

  try {
    const result = db.prepare(
      'INSERT INTO articles (category, title, author, date, summary, content, imageUrl, views) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
    ).run(safeCategory, safeTitle, safeAuthor, safeDate, safeSummary, safeContent, safeImageUrl);

    res.status(201).json({ id: result.lastInsertRowid, message: '게시글이 성공적으로 저장되었습니다.' });
  } catch (error) {
    res.status(500).json({ message: '게시글 저장 실패' });
  }
});

// 게시글 수정
app.put('/api/articles/:id', authenticateToken, (req, res) => {
  const { category, title, content, summary, imageUrl } = req.body;

  try {
    const result = db.prepare(
      'UPDATE articles SET category = ?, title = ?, content = ?, summary = ?, imageUrl = ? WHERE id = ?'
    ).run(category, title, content, summary, imageUrl, req.params.id);

    if (result.changes === 0) return res.status(404).json({ message: '게시글을 찾을 수 없습니다.' });
    res.json({ message: '게시글이 수정되었습니다.' });
  } catch (error) {
    res.status(500).json({ message: '게시글 수정 실패' });
  }
});

// 게시글 삭제
app.delete('/api/articles/:id', authenticateToken, (req, res) => {
  try {
    const result = db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ message: '게시글을 찾을 수 없습니다.' });
    res.json({ message: '게시글이 삭제되었습니다.' });
  } catch (error) {
    res.status(500).json({ message: '게시글 삭제 실패' });
  }
});

// 🚀 서버 실행 시 기본 날씨 기사 작성 후 3시간마다 주기적 등록
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 서버가 포트 ${PORT}에서 실행 중입니다.`);

  generateWeatherArticle();
  setInterval(generateWeatherArticle, 3 * 60 * 60 * 1000);
});
