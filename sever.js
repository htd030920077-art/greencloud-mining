// ==========================================
// FILE: server.js - GREENCLOUD MINING FULL BACKEND
// Cài đặt: npm install express firebase-admin cors
// ==========================================
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const https = require('https');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Phục vụ giao diện tĩnh (index.html, admin.html)
app.use(express.static(path.join(__dirname, '.')));

// 1. Khởi tạo Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// 2. Cấu hình Telegram Bot (Chuẩn HTTPS Node.js, không sợ lỗi fetch)
const TELEGRAM_BOT_TOKEN = '9196510643:AAGzXlYNEeCxz_Pchrg7528VBkaB53sXpd4';
const TELEGRAM_CHAT_ID = '7865394196';

function sendTelegram(msg) {
  try {
    const data = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: msg,
      parse_mode: 'Markdown'
    });

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      res.on('data', () => {});
    });

    req.on('error', (e) => {
      console.error('Lỗi gửi Telegram:', e.message);
    });

    req.write(data);
    req.end();
  } catch (err) {
    console.error('Lỗi gọi Telegram:', err);
  }
}

// Danh mục Gói Đào 12 Ngày
const PACKAGES_CONFIG = {
  '76k': { name: 'Gói Khởi Động 76K', cost: 76000, daily: 16720 },
  '104k': { name: 'Gói Tiêu Chuẩn 104K', cost: 104000, daily: 22880 },
  '208k': { name: 'Gói Nâng Cao 208K', cost: 208000, daily: 45760 },
  '416k': { name: 'Gói Chuyên Nghiệp 416K', cost: 416000, daily: 91520 },
  '832k': { name: 'Gói Trang Trại 832K', cost: 832000, daily: 183040 },
  '1500k': { name: 'Gói Cá Voi VIP 1.5M', cost: 1500000, daily: 330000 }
};

// ==========================================
// 3. API ĐĂNG KÝ TÀI KHOẢN MỚI
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password, fullName, sponsorUid } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'Thiếu số điện thoại hoặc mật khẩu!' });
    }

    const checkQuery = await db.collection('users').where('phone', '==', phone).get();
    if (!checkQuery.empty) {
      return res.status(400).json({ success: false, message: 'Số điện thoại này đã được đăng ký!' });
    }

    let sponsorF2Uid = null;
    let validSponsorUid = null;

    if (sponsorUid) {
      const f1Snap = await db.collection('users').doc(sponsorUid).get();
      if (f1Snap.exists) {
        validSponsorUid = sponsorUid;
        sponsorF2Uid = f1Snap.data().sponsor_uid || null;
      }
    }

    const newUid = Math.floor(1000000 + Math.random() * 9000000).toString();
    const nowTime = Date.now();

    const newUser = {
      uid: newUid,
      phone,
      password,
      full_name: fullName || phone,
      balance: 0,
      upgrade_balance: 20000, // Tặng sẵn 20k vào hũ
      sponsor_uid: validSponsorUid,
      sponsor_f2_uid: sponsorF2Uid,
      owned_packages: { free: 1 },
      active_instances: [{ pkgId: 'free', activatedAt: nowTime }],
      ref_f1_count: 0,
      ref_f1_paid_count: 0,
      gift_spins: 0,
      pin: '123456',
      created_at: nowTime
    };

    await db.collection('users').doc(newUid).set(newUser);

    if (validSponsorUid) {
      await db.collection('users').doc(validSponsorUid).update({
        ref_f1_count: admin.firestore.FieldValue.increment(1),
        gift_spins: admin.firestore.FieldValue.increment(1)
      }).catch(() => {});
    }

    sendTelegram(`👤 *THỢ ĐÀO MỚI ĐĂNG KÝ*\n- Họ tên: *${fullName}*\n- SĐT: \`${phone}\`\n- ID Nick: \`${newUid}\`\n- Cấp trên: ${validSponsorUid ? '`' + validSponsorUid + '`' : 'Không có'}`);

    return res.json({ success: true, user: newUser });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// 4. API BÁO ĐƠN RÚT TIỀN VỀ TELEGRAM
// ==========================================
app.post('/api/withdraw/alert', (req, res) => {
  const { uid, name, amount, bank, acc, holder } = req.body;
  sendTelegram(`📤 *YÊU CẦU RÚT TIỀN MỚI*\n- Thợ Đào: *${name}* (\`ID: ${uid}\`)\n- Số tiền rút: *${Number(amount).toLocaleString('vi-VN')} đ*\n- Ngân hàng: *${bank}*\n- Số tài khoản: \`${acc}\`\n- Tên chủ thẻ: *${holder}*\n- Trạng thái: *Chờ duyệt trên Admin*`);
  return res.json({ success: true });
});

// ==========================================
// 5. WEBHOOK SEPAY (TỰ ĐỘNG KÍCH HOẠT & CHIA HOA HỒNG)
// ==========================================
app.post('/api/webhook/sepay', async (req, res) => {
  console.log('--- [SEPAY WEBHOOK RECEIVED] ---', JSON.stringify(req.body));
  try {
    const body = req.body || {};

    // 1. Chuẩn hóa số tiền nhận
    const rawAmount = body.transferAmount || body.amountIn || body.amount || 0;
    const amountNum = Math.round(Number(String(rawAmount).replace(/[^0-9]/g, '')) || 0);

    // 2. Chuẩn hóa nội dung
    const rawContent = body.content || body.description || body.code || '';
    const cleanContent = rawContent.toString().trim();

    if (amountNum <= 0) {
      console.log('Bỏ qua: Số tiền không hợp lệ:', amountNum);
      return res.status(200).json({ success: false, message: 'Số tiền <= 0' });
    }

    // 3. Tách lấy ID người chơi (xử lý sạch kể cả khi dính dấu gạch ngang như 6138215-...)
    let uid = null;
    const matchHead = cleanContent.match(/^(\d{6,9})/);
    if (matchHead) {
      uid = matchHead[1];
    } else {
      const matchAny = cleanContent.match(/(\d{6,9})/);
      if (matchAny) uid = matchAny[1];
    }

    if (!uid) {
      console.log('Không tìm thấy ID người chơi trong nội dung:', cleanContent);
      return res.status(200).json({ success: false, message: 'Không tìm thấy ID' });
    }

    // 4. Tìm kiếm người dùng trong Firestore
    let userRef = db.collection('users').doc(uid);
    let userSnap = await userRef.get();

    if (!userSnap.exists) {
      const querySnap = await db.collection('users').where('uid', '==', uid).limit(1).get();
      if (!querySnap.empty) {
        userRef = querySnap.docs[0].ref;
        userSnap = querySnap.docs[0];
      } else {
        console.log('Không tìm thấy User Firestore với UID:', uid);
        return res.status(200).json({ success: false, message: 'Tài khoản không tồn tại' });
      }
    }

    const userData = userSnap.data();

    // 5. Đối chiếu số tiền với các gói đào
    let matchedPkgKey = null;
    for (const [k, p] of Object.entries(PACKAGES_CONFIG)) {
      if (p.cost === amountNum) {
        matchedPkgKey = k;
        break;
      }
    }

    // Nếu không khớp gói -> Cộng tiền thẳng vào ví chính
    if (!matchedPkgKey) {
      await userRef.update({
        balance: admin.firestore.FieldValue.increment(amountNum)
      });
      sendTelegram(`💰 *NẠP TIỀN VÀO VÍ THÀNH CÔNG*\n- Thợ đào: \`ID: ${uid}\`\n- Số tiền: *+${amountNum.toLocaleString('vi-VN')} đ*\n- Nội dung: \`${cleanContent}\``);
      return res.status(200).json({ success: true, message: 'Đã cộng vào ví chính' });
    }

    const pkgInfo = PACKAGES_CONFIG[matchedPkgKey];

    // 6. Kích hoạt dàn máy đào 12 ngày & Chia hoa hồng F1 (15%), F2 (5%)
    await db.runTransaction(async (transaction) => {
      const newInstance = { pkgId: matchedPkgKey, activatedAt: Date.now() };

      // Kích hoạt dàn máy cho người nạp
      transaction.update(userRef, {
        [`owned_packages.${matchedPkgKey}`]: admin.firestore.FieldValue.increment(1),
        active_instances: admin.firestore.FieldValue.arrayUnion(newInstance),
        has_paid_package: true,
        last_active_at: Date.now()
      });

      // Trả hoa hồng F1 (15%)
      if (userData.sponsor_uid) {
        const f1Ref = db.collection('users').doc(userData.sponsor_uid);
        const f1Snap = await transaction.get(f1Ref);
        if (f1Snap.exists) {
          const f1Comm = amountNum * 0.15;
          transaction.update(f1Ref, {
            balance: admin.firestore.FieldValue.increment(f1Comm),
            ref_f1_paid_count: admin.firestore.FieldValue.increment(1)
          });
          sendTelegram(`💰 *HOA HỒNG F1 (+15%) TỰ ĐỘNG*\n- Cấp trên: \`ID: ${userData.sponsor_uid}\`\n- Nhận từ F1: \`ID: ${uid}\`\n- Số tiền: *+${f1Comm.toLocaleString('vi-VN')} đ*`);
        }
      }

      // Trả hoa hồng F2 (5%)
      if (userData.sponsor_f2_uid) {
        const f2Ref = db.collection('users').doc(userData.sponsor_f2_uid);
        const f2Snap = await transaction.get(f2Ref);
        if (f2Snap.exists) {
          const f2Comm = amountNum * 0.05;
          transaction.update(f2Ref, {
            balance: admin.firestore.FieldValue.increment(f2Comm)
          });
          sendTelegram(`💎 *HOA HỒNG F2 (+5%) TỰ ĐỘNG*\n- Cấp trên F2: \`ID: ${userData.sponsor_f2_uid}\`\n- Nhận từ F2: \`ID: ${uid}\`\n- Số tiền: *+${f2Comm.toLocaleString('vi-VN')} đ*`);
        }
      }

      // Lưu lịch sử vào deposits
      const depRef = db.collection('deposits').doc();
      transaction.set(depRef, {
        uid: uid,
        amount: amountNum,
        package_id: matchedPkgKey,
        package_name: pkgInfo.name,
        code: cleanContent,
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    sendTelegram(`🎉 *KÍCH HOẠT GÓI ĐÀO (12 NGÀY) TỰ ĐỘNG*\n- Thợ đào: \`ID: ${uid}\`\n- Gói kích hoạt: *${pkgInfo.name}*\n- Số tiền: *${amountNum.toLocaleString('vi-VN')} đ*\n- Nội dung: \`${cleanContent}\``);

    return res.status(200).json({ success: true, message: 'Đã kích hoạt gói 12 ngày thành công' });

  } catch (error) {
    console.error('Lỗi xử lý SePay Webhook:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 6. KHỞI CHẠY SERVER & TỰ GIỮ THỨC TRÊN RENDER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GreenCloud Backend đang chạy tại port ${PORT}`);
  sendTelegram("🚀 *Hệ Thống Backend GreenCloud Đã Khởi Động Live Trên Render!*");
});

// Cơ chế tự Ping mỗi 10 phút để server Render không bị ngủ
setInterval(() => {
  https.get('https://greencloud-mining-liver.onrender.com', (res) => {
    // Ping giữ máy chủ online
  }).on('error', () => {});
}, 10 * 60 * 1000);
