require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Cấu hình môi trường & tài khoản
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '9196510643:AAGzXlYNEeCxz_Pchrg7528VBkaB53sXpd4';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7865394196';
const MB_ACCOUNT = process.env.MB_BANK_ACCOUNT || '0829594887';
const MB_NAME = process.env.MB_BANK_NAME || 'DANG HIEU THANG';

// Danh mục 7 gói đầu tư điện toán đám mây
const PACKAGES_CONFIG = {
  free: { id: 'free', name: 'Gói Miễn Phí (Free)', cost: 0, dailyReturn: 400 },
  '76k': { id: '76k', name: 'Gói Khởi Động 76K', cost: 76000, dailyReturn: 16720 },
  '104k': { id: '104k', name: 'Gói Tiêu Chuẩn 104K', cost: 104000, dailyReturn: 22880 },
  '208k': { id: '208k', name: 'Gói Nâng Cao 208K', cost: 208000, dailyReturn: 45760 },
  '416k': { id: '416k', name: 'Gói Chuyên Nghiệp 416K', cost: 416000, dailyReturn: 91520 },
  '832k': { id: '832k', name: 'Gói Trang Trại 832K', cost: 832000, dailyReturn: 183040 },
  '1500k': { id: '1500k', name: 'Gói Cá Voi VIP 1.5M', cost: 1500000, dailyReturn: 330000 }
};

// Hàm gửi tin nhắn thông báo về Telegram Bot
async function sendTelegram(text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'Markdown'
      })
    });
  } catch (err) {
    console.error('Lỗi gửi Telegram Bot:', err.message);
  }
}

// -------------------------------------------------------------
// KHỞI TẠO CƠ SỞ DỮ LIỆU SQLITE (greencloud.db)
// -------------------------------------------------------------
const db = new sqlite3.Database(path.join(__dirname, 'greencloud.db'), (err) => {
  if (err) console.error('Lỗi kết nối CSDL SQLite:', err.message);
  else console.log('✓ Đã kết nối cơ sở dữ liệu SQLite: greencloud.db');
});

db.serialize(() => {
  // 1. Bảng thành viên (users) - Khóa 1 SĐT = 1 tài khoản duy nhất
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE,
      phone TEXT UNIQUE,
      password TEXT,
      full_name TEXT,
      pin TEXT DEFAULT '123456',
      balance REAL DEFAULT 0,
      upgrade_balance REAL DEFAULT 20000,
      sponsor_uid TEXT,
      overclock INTEGER DEFAULT 0,
      gift_spins INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      bank_name TEXT,
      bank_account TEXT,
      bank_holder TEXT,
      last_active_at INTEGER,
      last_daily_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. Bảng quản lý máy đào sở hữu (user_packages)
  db.run(`
    CREATE TABLE IF NOT EXISTS user_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uid TEXT,
      package_id TEXT,
      quantity INTEGER DEFAULT 0,
      UNIQUE(user_uid, package_id)
    )
  `);

  // 3. Bảng lịch sử nạp tiền (deposits)
  db.run(`
    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uid TEXT,
      type TEXT, -- 'package' hoặc 'upgrade'
      amount REAL,
      code TEXT,
      package_name TEXT,
      sepay_ref TEXT,
      status TEXT DEFAULT 'success',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 4. Bảng quản lý lệnh rút tiền (withdrawals)
  db.run(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT UNIQUE,
      user_uid TEXT,
      amount REAL,
      bank TEXT,
      account_num TEXT,
      account_name TEXT,
      status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'refunded'
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Hàm hỗ trợ tính toán sản lượng đào mỗi giây
function calculateRatePerSec(packages, overclockPercent = 0) {
  let daily = 0;
  for (const [pkgId, qty] of Object.entries(packages)) {
    if (PACKAGES_CONFIG[pkgId] && qty > 0) {
      daily += PACKAGES_CONFIG[pkgId].dailyReturn * qty;
    }
  }
  daily *= (1 + (overclockPercent || 0) / 100);
  return daily / 86400;
}

// -------------------------------------------------------------
// NHÓM 1: AUTHENTICATION (1 SĐT = 1 TÀI KHOẢN DUY NHẤT)
// -------------------------------------------------------------

// Đăng ký tài khoản mới
app.post('/api/auth/register', (req, res) => {
  const { phone, password, full_name, sponsor_uid } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ success: false, message: 'Vui lòng cung cấp số điện thoại và mật khẩu!' });
  }

  const cleanPhone = phone.trim();

  // Kiểm tra số điện thoại đã tồn tại chưa
  db.get('SELECT id FROM users WHERE phone = ?', [cleanPhone], (err, row) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (row) {
      return res.status(400).json({ success: false, message: 'Số điện thoại này đã được đăng ký tài khoản!' });
    }

    const randUid = Math.floor(1000000000 + Math.random() * 9000000000).toString();
    const now = Date.now();

    db.run(
      `INSERT INTO users (uid, phone, password, full_name, sponsor_uid, upgrade_balance, last_active_at)
       VALUES (?, ?, ?, ?, ?, 20000, ?)`,
      [randUid, cleanPhone, password, full_name || cleanPhone, sponsor_uid || null, now],
      function (err) {
        if (err) return res.status(500).json({ success: false, message: err.message });

        // Tự động cấp 01 Gói Miễn Phí (Free 400 đ/ngày)
        db.run(
          `INSERT INTO user_packages (user_uid, package_id, quantity) VALUES (?, 'free', 1)`,
          [randUid]
        );

        sendTelegram(`👤 *Thợ Đào Mới Đăng Ký*\n- SĐT: \`${cleanPhone}\`\n- UID: \`GC-${randUid}\`\n- Người mời: ${sponsor_uid || 'Hệ thống Gốc'}\n- Quà tặng: 20.000 đ vào Hũ + 01 Gói Miễn Phí`);

        return res.json({
          success: true,
          message: 'Đăng ký thành công!',
          user: {
            uid: randUid,
            phone: cleanPhone,
            full_name: full_name || cleanPhone,
            balance: 0,
            upgrade_balance: 20000
          }
        });
      }
    );
  });
});

// Đăng nhập tài khoản
app.post('/api/auth/login', (req, res) => {
  const { phone, password } = req.body;
  const cleanPhone = (phone || '').trim();

  db.get('SELECT * FROM users WHERE phone = ? AND password = ?', [cleanPhone, password], (err, user) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!user) return res.status(401).json({ success: false, message: 'Sai số điện thoại hoặc mật khẩu đăng nhập!' });

    // Thu hoạch tiền đào ngầm (giới hạn tối đa 24h để chống gian lận thời gian)
    const now = Date.now();
    db.all('SELECT package_id, quantity FROM user_packages WHERE user_uid = ?', [user.uid], (err, rows) => {
      const pkgs = {};
      rows.forEach(r => pkgs[r.package_id] = r.quantity);

      const ratePerSec = calculateRatePerSec(pkgs, user.overclock);
      const offlineSeconds = Math.min(86400, Math.max(0, (now - (user.last_active_at || now)) / 1000));
      const offlineEarned = ratePerSec * offlineSeconds;

      const newBalance = user.balance + offlineEarned;
      db.run('UPDATE users SET balance = ?, last_active_at = ? WHERE uid = ?', [newBalance, now, user.uid]);

      delete user.password;
      user.balance = newBalance;
      user.packages = pkgs;

      return res.json({ success: true, user, offlineEarned });
    });
  });
});

// -------------------------------------------------------------
// NHÓM 2: VẬN HÀNH ĐÀO 24/7 & NHIỆM VỤ
// -------------------------------------------------------------

// Đồng bộ sản lượng đào từng giây
app.post('/api/user/sync-mining', (req, res) => {
  const { uid } = req.body;
  const now = Date.now();

  db.get('SELECT * FROM users WHERE uid = ?', [uid], (err, user) => {
    if (!user) return res.status(404).json({ success: false });

    db.all('SELECT package_id, quantity FROM user_packages WHERE user_uid = ?', [uid], (err, rows) => {
      const pkgs = {};
      rows.forEach(r => pkgs[r.package_id] = r.quantity);

      const ratePerSec = calculateRatePerSec(pkgs, user.overclock);
      const elapsed = Math.min(86400, Math.max(0, (now - (user.last_active_at || now)) / 1000));
      const earned = ratePerSec * elapsed;

      const newBal = user.balance + earned;
      db.run('UPDATE users SET balance = ?, last_active_at = ? WHERE uid = ?', [newBal, now, uid]);

      res.json({ success: true, balance: newBal, ratePerSec });
    });
  });
});

// Điểm danh nhận thưởng (chống bug nhận nhiều lần trong ngày)
app.post('/api/user/claim-daily', (req, res) => {
  const { uid } = req.body;
  const todayStr = new Date().toISOString().split('T')[0];

  db.get('SELECT last_daily_date, balance FROM users WHERE uid = ?', [uid], (err, user) => {
    if (!user) return res.status(404).json({ success: false, message: 'Thợ đào không tồn tại' });
    if (user.last_daily_date === todayStr) {
      return res.status(400).json({ success: false, message: 'Hôm nay bạn đã nhận thưởng điểm danh rồi!' });
    }

    const newBal = user.balance + 500;
    db.run('UPDATE users SET balance = ?, last_daily_date = ? WHERE uid = ?', [newBal, todayStr, uid], (err) => {
      res.json({ success: true, balance: newBal, message: 'Nhận thành công +500 đ điểm danh!' });
    });
  });
});

// Rút tiền từ Hũ Nâng Cấp sang Ví Chính (Bắt buộc sở hữu gói >= 76K)
app.post('/api/user/transfer-upgrade', (req, res) => {
  const { uid, amount } = req.body;
  const numAmount = parseFloat(amount);

  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ success: false, message: 'Số tiền chuyển không hợp lệ!' });
  }

  db.all('SELECT package_id, quantity FROM user_packages WHERE user_uid = ?', [uid], (err, rows) => {
    const hasPaidPkg = rows.some(r => r.package_id !== 'free' && r.quantity > 0);
    if (!hasPaidPkg) {
      return res.status(403).json({
        success: false,
        message: 'Bạn phải kích hoạt ít nhất 1 gói máy đào từ 76.000 đ trở lên để mở khóa quyền rút Hũ!'
      });
    }

    db.get('SELECT balance, upgrade_balance FROM users WHERE uid = ?', [uid], (err, user) => {
      if (user.upgrade_balance < numAmount) {
        return res.status(400).json({ success: false, message: 'Số dư trong Hũ Nâng Cấp không đủ!' });
      }

      const newUpgrade = user.upgrade_balance - numAmount;
      const newMain = user.balance + numAmount;

      db.run('UPDATE users SET balance = ?, upgrade_balance = ? WHERE uid = ?', [newMain, newUpgrade, uid], () => {
        res.json({
          success: true,
          balance: newMain,
          upgrade_balance: newUpgrade,
          message: `Đã rút thành công +${numAmount.toLocaleString('vi-VN')} đ từ Hũ về Ví Chính!`
        });
      });
    });
  });
});

// -------------------------------------------------------------
// NHÓM 3: RÚT TIỀN & AI BOT TỰ ĐỘNG PHÊ DUYỆT / HOÀN TIỀN
// -------------------------------------------------------------
app.post('/api/withdraw/create', (req, res) => {
  const { uid, amount, bank, acc_num, acc_name, pin } = req.body;
  const numAmount = parseFloat(amount);

  if (!acc_num || !acc_name || isNaN(numAmount) || numAmount < 10000) {
    return res.status(400).json({ success: false, message: 'Dữ liệu không hợp lệ. Rút tối thiểu 10.000 đ!' });
  }

  db.get('SELECT * FROM users WHERE uid = ?', [uid], (err, user) => {
    if (!user) return res.status(404).json({ success: false, message: 'Người dùng không tồn tại' });
    if (user.pin !== pin) {
      return res.status(400).json({ success: false, message: 'Sai mã PIN bảo mật 6 số!' });
    }
    if (user.balance < numAmount) {
      return res.status(400).json({ success: false, message: 'Số dư ví chính không đủ để rút!' });
    }

    const orderId = 'WD' + Date.now().toString().slice(-6);
    const newBal = user.balance - numAmount;

    // Trừ tiền tạm thời và đưa vào hàng chờ kiểm tra
    db.run('UPDATE users SET balance = ? WHERE uid = ?', [newBal, uid]);
    db.run(
      `INSERT INTO withdrawals (order_id, user_uid, amount, bank, account_num, account_name, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [orderId, uid, numAmount, bank, acc_num, acc_name],
      function (err) {
        sendTelegram(`⏳ *Yêu Cầu Rút Tiền Mới*\n- Mã đơn: \`${orderId}\`\n- Thợ đào: ${user.phone} (GC-${uid})\n- Số tiền: ${numAmount.toLocaleString('vi-VN')} đ\n- Ngân hàng: ${bank} (\`${acc_num}\` - ${acc_name})\n- Trạng thái: Đang kiểm duyệt...`);

        res.json({
          success: true,
          order_id: orderId,
          balance: newBal,
          message: 'Lệnh rút tiền đã gửi, AI Bot đang kiểm tra điều kiện tài khoản...'
        });

        // AI BOT KIỂM TRA TỰ ĐỘNG SAU 3 GIÂY
        setTimeout(() => {
          db.all('SELECT package_id, quantity FROM user_packages WHERE user_uid = ?', [uid], (err, pkgs) => {
            const hasPaidPkg = pkgs.some(p => p.package_id !== 'free' && p.quantity > 0);

            if (!hasPaidPkg) {
              // CHƯA ĐỦ ĐIỀU KIỆN: Hoàn trả 100% tiền về ví chính
              db.run('UPDATE users SET balance = balance + ? WHERE uid = ?', [numAmount, uid]);
              db.run('UPDATE withdrawals SET status = "refunded", reason = "Chưa kích hoạt gói từ 76K" WHERE order_id = ?', [orderId]);

              sendTelegram(`🤖 *AI Bot Từ Chối & Hoàn Tiền Rút*\n- Mã đơn: \`${orderId}\`\n- Thợ đào: ${user.phone} (GC-${uid})\n- Hoàn lại ví: +${numAmount.toLocaleString('vi-VN')} đ\n- Lý do: Tài khoản chưa kích hoạt gói máy đào trả phí từ 76.000 đ.`);
            } else {
              // ĐỦ ĐIỀU KIỆN: Phê duyệt thành công qua Napas 24/7
              db.run('UPDATE withdrawals SET status = "approved" WHERE order_id = ?', [orderId]);
              sendTelegram(`✅ *AI Bot Phê Duyệt Rút Tiền Thành Công*\n- Mã đơn: \`${orderId}\`\n- Số tiền: ${numAmount.toLocaleString('vi-VN')} đ\n- Chuyển đến: ${bank} (\`${acc_num}\` - ${acc_name})\n- Trạng thái: Napas 24/7 Thành Công`);
            }
          });
        }, 3000);
      }
    );
  });
});

// -------------------------------------------------------------
// NHÓM 4: WEBHOOK SEPAY (NẠP TIỀN MB BANK 0829594887 & HOA HỒNG)
// -------------------------------------------------------------
app.post('/api/webhook/sepay', (req, res) => {
  const { transferAmount, content, referenceCode } = req.body;
  if (!content || !transferAmount) return res.status(400).send('Dữ liệu không hợp lệ');

  const cleanContent = content.trim().toUpperCase();

  // 1. Nhận diện nạp Gói Đào (Mã bắt đầu bằng GC...)
  if (cleanContent.startsWith('GC')) {
    const uid = cleanContent.replace('GC', '').replace(/[^0-9]/g, '');

    db.get('SELECT * FROM users WHERE uid = ?', [uid], (err, user) => {
      if (!user) return res.status(404).send('Không tìm thấy thợ đào');

      // Tìm gói máy đào khớp đúng số tiền chuyển
      let matchedPkgKey = null;
      for (const [k, p] of Object.entries(PACKAGES_CONFIG)) {
        if (p.cost === transferAmount) {
          matchedPkgKey = k;
          break;
        }
      }

      if (matchedPkgKey) {
        db.run(
          `INSERT INTO user_packages (user_uid, package_id, quantity)
           VALUES (?, ?, 1)
           ON CONFLICT(user_uid, package_id) DO UPDATE SET quantity = quantity + 1`,
          [uid, matchedPkgKey]
        );

        db.run(
          `INSERT INTO deposits (user_uid, type, amount, code, package_name, sepay_ref)
           VALUES (?, 'package', ?, ?, ?, ?)`,
          [uid, transferAmount, cleanContent, PACKAGES_CONFIG[matchedPkgKey].name, referenceCode]
        );

        // Tính hoa hồng F1 (7%) và F2 (3%)
        if (user.sponsor_uid) {
          const f1Comm = transferAmount * 0.07;
          db.run('UPDATE users SET balance = balance + ? WHERE uid = ?', [f1Comm, user.sponsor_uid]);

          db.get('SELECT sponsor_uid FROM users WHERE uid = ?', [user.sponsor_uid], (err, f1User) => {
            if (f1User && f1User.sponsor_uid) {
              const f2Comm = transferAmount * 0.03;
              db.run('UPDATE users SET balance = balance + ? WHERE uid = ?', [f2Comm, f1User.sponsor_uid]);
            }
          });
        }

        sendTelegram(`🎉 *Nạp Gói Đào Tự Động Thành Công*\n- Thợ đào: ${user.phone} (GC-${uid})\n- Kích hoạt gói: *${PACKAGES_CONFIG[matchedPkgKey].name}*\n- Số tiền: +${transferAmount.toLocaleString('vi-VN')} đ\n- Tài khoản nhận: MB Bank \`${MB_ACCOUNT}\` (${MB_NAME})\n- Mã GD: \`${referenceCode}\``);
      }
      return res.json({ success: true });
    });
  }
  // 2. Nhận diện nạp Hũ Nâng Cấp (Mã bắt đầu bằng NC...)
  else if (cleanContent.startsWith('NC')) {
    const uid = cleanContent.replace('NC', '').replace(/[^0-9]/g, '');

    db.get('SELECT * FROM users WHERE uid = ?', [uid], (err, user) => {
      if (!user) return res.status(404).send('Không tìm thấy thợ đào');

      db.run('UPDATE users SET upgrade_balance = upgrade_balance + ? WHERE uid = ?', [transferAmount, uid]);
      db.run(
        `INSERT INTO deposits (user_uid, type, amount, code, package_name, sepay_ref)
         VALUES (?, 'upgrade', ?, ?, 'Nạp Hũ Nâng Cấp', ?)`,
        [uid, transferAmount, cleanContent, referenceCode]
      );

      sendTelegram(`💠 *Nạp Hũ Nâng Cấp Tự Động Thành Công*\n- Thợ đào: ${user.phone} (GC-${uid})\n- Cộng vào Hũ: +${transferAmount.toLocaleString('vi-VN')} đ\n- Tài khoản nhận: MB Bank \`${MB_ACCOUNT}\` (${MB_NAME})`);

      return res.json({ success: true });
    });
  } else {
    return res.status(200).send('Cú pháp chuyển khoản không thuộc hệ thống');
  }
});

// -------------------------------------------------------------
// NHÓM 5: API KẾT NỐI VỚI BẢNG QUẢN TRỊ (ADMIN PANEL)
// -------------------------------------------------------------

// Lấy danh sách toàn bộ thành viên
app.get('/api/admin/members', (req, res) => {
  db.all('SELECT * FROM users ORDER BY id DESC', [], (err, rows) => {
    res.json({ success: true, data: rows });
  });
});

// Lấy toàn bộ cây phả hệ cấp dưới F1 & F2 của một thành viên
app.get('/api/admin/downlines/:uid', (req, res) => {
  const { uid } = req.params;
  db.all('SELECT * FROM users WHERE sponsor_uid = ?', [uid], (err, f1List) => {
    const f1Uids = f1List.map(u => u.uid);

    if (f1Uids.length === 0) {
      return res.json({ success: true, f1: [], f2: [] });
    }

    const placeholders = f1Uids.map(() => '?').join(',');
    db.all(`SELECT * FROM users WHERE sponsor_uid IN (${placeholders})`, f1Uids, (err, f2List) => {
      res.json({ success: true, f1: f1List, f2: f2List });
    });
  });
});

// Admin can thiệp duyệt hoặc từ chối lệnh rút tiền
app.post('/api/admin/withdraw/action', (req, res) => {
  const { order_id, action } = req.body;
  const newStatus = action === 'approve' ? 'approved' : 'refunded';

  db.get('SELECT * FROM withdrawals WHERE order_id = ?', [order_id], (err, order) => {
    if (!order) return res.status(404).json({ success: false, message: 'Đơn rút không tồn tại' });

    if (action === 'reject') {
      db.run('UPDATE users SET balance = balance + ? WHERE uid = ?', [order.amount, order.user_uid]);
    }

    db.run('UPDATE withdrawals SET status = ? WHERE order_id = ?', [newStatus, order_id], () => {
      sendTelegram(`👮 *Quản Trị Viên Can Thiệp Lệnh Rút*\n- Đơn rút: \`${order_id}\`\n- Thao tác: *${action === 'approve' ? 'Đã Duyệt & Chuyển Khoản' : 'Từ Chối & Hoàn Tiền'}*\n- Số tiền: ${order.amount.toLocaleString('vi-VN')} đ`);
      res.json({ success: true });
    });
  });
});

// Khởi chạy máy chủ
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 GreenCloud Mining Server đang chạy tại Port: ${PORT}`);
  console.log(`🏦 MB Bank nhận nạp: ${MB_ACCOUNT} - ${MB_NAME}`);
  console.log(`🤖 Telegram Bot Token: ${TELEGRAM_BOT_TOKEN.slice(0, 15)}...`);
  console.log(`🔗 Webhook SePay đón nạp: http://localhost:${PORT}/api/webhook/sepay`);
  console.log(`=======================================================`);
});
