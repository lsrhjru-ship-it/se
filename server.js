require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

const PORT = process.env.PORT || 10000; // Render 기본 포트 대응
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

// 컬럼 마이그레이션 (이미 존재 시 무시)
try { db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user';`); } catch (e) { }
try { db.exec(`ALTER TABLE articles ADD COLUMN imageUrl TEXT;`); } catch (e) { }
try { db.exec(`ALTER TABLE articles ADD COLUMN views INTEGER DEFAULT 0;`); } catch (e) { }

// 관리자 계정 초기화
const initAdmin = async () => {
  const adminUser = process.env.ADMIN_USERNAME || 'lsrhjru';
  const adminPass = process.env.ADMIN_PASSWORD || 'lsr37733*';
  const adminName = process.env.ADMIN_NAME || '관리자';

  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(adminUser);
  if (!row) {
    const hashedPassword = await bcrypt.hash(adminPass, 10);
    db.prepare('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)').run(adminUser, hashedPassword, adminName, 'admin');
    console.log('✅ 관리자 계정이 생성되었습니다.');
  }
};
initAdmin();

// 💡 CORS 설정 (모든 Custom Header 및 Preflight 요청 완벽 허용)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Bypass-Tunnel-Reminder, ngrok-skip-browser-warning');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // OPTIONS 예비 요청(preflight) 즉시 200 OK 응답 처리
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(cors());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname)));

// JWT 검증 미들웨어
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ message: '인증 토큰이 없습니다. 다시 로그인해 주세요.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: '유효하지 않거나 만료된 토큰입니다.' });
    req.user = user;
    next();
  });
};

// --- API 라우트 ---

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

// 게시글 상세 조회 (조회수 +1)
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
    console.error('게시글 저장 오류:', error);
    res.status(500).json({ message: '게시글 저장에 실패했습니다. (DB 오류)' });
  }
});

// 게시글 수정
app.put('/api/articles/:id', authenticateToken, (req, res) => {
  const { category, title, content, summary, imageUrl } = req.body;

  const safeCategory = category || '기타';
  const safeTitle = title || '제목 없음';
  const safeContent = content || '';
  const safeSummary = summary || safeContent.substring(0, 100) || '';
  const safeImageUrl = imageUrl !== undefined ? imageUrl : null;

  try {
    const result = db.prepare(
      'UPDATE articles SET category = ?, title = ?, content = ?, summary = ?, imageUrl = ? WHERE id = ?'
    ).run(safeCategory, safeTitle, safeContent, safeSummary, safeImageUrl, req.params.id);

    if (result.changes === 0) return res.status(404).json({ message: '게시글을 찾을 수 없습니다.' });
    res.json({ message: '게시글이 수정되었습니다.' });
  } catch (error) {
    console.error('게시글 수정 오류:', error);
    res.status(500).json({ message: '게시글 수정에 실패했습니다.' });
  }
});

// 게시글 삭제
app.delete('/api/articles/:id', authenticateToken, (req, res) => {
  try {
    const result = db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ message: '게시글을 찾을 수 없습니다.' });
    res.json({ message: '게시글이 삭제되었습니다.' });
  } catch (error) {
    res.status(500).json({ message: '게시글 삭제에 실패했습니다.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 서버가 포트 ${PORT}에서 실행 중입니다.`);
});
