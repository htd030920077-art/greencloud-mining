// ==========================================
// FILE: server.js
// Cài đặt thư viện: npm install express firebase-admin cors dotenv
// ==========================================
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Khởi tạo Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 2. Cấu hình Telegram Bot & Danh mục Gói Đào
const TELEGRAM_BOT_TOKEN = '9196510643:AAGzXlYNEeCxz_Pchrg7528VBkaB53sXpd4';
const TELEGRAM_CHAT_ID = '7865394196';

const PACKAGES_CONFIG = {
  '76k': { name: 'Gói Khởi Động 76K', cost: 76000, daily: 16720 },
  '104k': { name: 'Gói Tiêu Chuẩn 104K', cost: 104000, daily: 22880 },
  '208k': { name: 'Gói Nâng Cao 208K', cost: 208000, daily: 45760 },
  '416k': { name: 'Gói Chuyên Nghiệp 416K', cost: 416000, daily: 91520 },
  '832k': { name: 'Gói Trang Trại 832K', cost: 832000, daily: 183040 },
  '1500k': { name: 'Gói Cá Voi VIP 1.5M', cost: 1500000, daily: 330000 }
};

async function sendTelegram(msg) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' })
    });
  } catch (e) {
    console.error('Lỗi gửi Telegram:', e.message);
  }
}

// 3. API Đăng Ký Tài Khoản
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password, fullName, sponsorUid } = req.body;
    if (!phone || !password) return res.status(400).json({ success: false, message: 'Thiếu thông tin!' });

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
    const now = Date.now();

    const newUser = {
      uid: newUid,
      phone,
      password,
      full_name: fullName || phone,
      balance: 0,
      sponsor_uid: validSponsorUid,
      sponsor_f2_uid: sponsorF2Uid,
      owned_packages: { free: 1 },
      active_instances: [{ pkgId: 'free', activatedAt: now }],
      ref_f1_count: 0,
      ref_f1_paid_count: 0,
      gift_spins: 0,
      created_at: now
    };

    await db.collection('users').doc(newUid).set(newUser);

    if (validSponsorUid) {
      await db.collection('users').doc(validSponsorUid).update({
        ref_f1_count: admin.firestore.FieldValue.increment(1),
        gift_spins: admin.firestore.FieldValue.increment(1)
      });
    }

    sendTelegram(`👤 *Thợ Đào Mới Đăng Ký*\n- Họ tên: *${fullName}*\n- SĐT: \`${phone}\`\n- UID (Nội dung CK): \`${newUid}\`\n- Cấp trên: ${validSponsorUid ? '`' + validSponsorUid + '`' : 'Không có'}`);

    return res.json({ success: true, user: newUser });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 4. Webhook SePay: Nhận diện trực tiếp qua ID Nick (UID thuần số)
app.post('/api/webhook/sepay', async (req, res) => {
  try {
    const { transferAmount, content } = req.body;
    if (!transferAmount || !content) return res.status(400).send('Dữ liệu thiếu');

    const cleanContent = content.trim().toUpperCase();
    const amountNum = Number(transferAmount);

    // Tìm chuỗi ID gồm 6-9 chữ số bất kỳ trong nội dung chuyển khoản
    const matchUid = cleanContent.match(/(\d{6,9})/);
    if (!matchUid) {
      return res.status(200).send('Không tìm thấy ID người chơi trong nội dung CK');
    }

    const uid = matchUid[1];
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).send('Không tìm thấy thợ đào mang ID này');
    }
    const userData = userSnap.data();

    // Đối chiếu số tiền với các gói khai thác
    let matchedPkgKey = null;
    for (const [k, p] of Object.entries(PACKAGES_CONFIG)) {
      if (p.cost === amountNum) {
        matchedPkgKey = k;
        break;
      }
    }

    if (!matchedPkgKey) {
      // Nếu nạp số tiền khác ngoài các gói, cộng thẳng tiền vào ví chính của khách
      await userRef.update({
        balance: admin.firestore.FieldValue.increment(amountNum)
      });
      sendTelegram(`💰 *Nạp Tiền Thành Công Vào Ví*\n- Thợ đào: \`ID: ${uid}\`\n- Số tiền: +${amountNum.toLocaleString('vi-VN')} đ`);
      return res.json({ success: true, message: 'Đã cộng tiền vào ví chính' });
    }

    const pkgInfo = PACKAGES_CONFIG[matchedPkgKey];

    await db.runTransaction(async (transaction) => {
      // 1. Kích hoạt gói máy đào 12 ngày cho người nạp
      const newInstance = { pkgId: matchedPkgKey, activatedAt: Date.now() };
      transaction.update(userRef, {
        [`owned_packages.${matchedPkgKey}`]: admin.firestore.FieldValue.increment(1),
        active_instances: admin.firestore.FieldValue.arrayUnion(newInstance),
        has_paid_package: true,
        last_active_at: Date.now()
      });

      // 2. Chia hoa hồng F1 (15%)
      if (userData.sponsor_uid) {
        const f1Ref = db.collection('users').doc(userData.sponsor_uid);
        const f1Snap = await transaction.get(f1Ref);
        if (f1Snap.exists) {
          const f1Commission = amountNum * 0.15;
          transaction.update(f1Ref, {
            balance: admin.firestore.FieldValue.increment(f1Commission),
            ref_f1_paid_count: admin.firestore.FieldValue.increment(1)
          });

          sendTelegram(`💰 *Hoa Hồng F1 (+15%) Tự Động*\n- Nhận: \`ID: ${userData.sponsor_uid}\`\n- Từ F1: \`ID: ${uid}\`\n- Cộng: *+${f1Commission.toLocaleString('vi-VN')} đ*`);
        }
      }

      // 3. Chia hoa hồng F2 (5%)
      if (userData.sponsor_f2_uid) {
        const f2Ref = db.collection('users').doc(userData.sponsor_f2_uid);
        const f2Snap = await transaction.get(f2Ref);
        if (f2Snap.exists) {
          const f2Commission = amountNum * 0.05;
          transaction.update(f2Ref, {
            balance: admin.firestore.FieldValue.increment(f2Commission)
          });

          sendTelegram(`💎 *Hoa Hồng F2 (+5%) Tự Động*\n- Nhận: \`ID: ${userData.sponsor_f2_uid}\`\n- Từ F2: \`ID: ${uid}\`\n- Cộng: *+${f2Commission.toLocaleString('vi-VN')} đ*`);
        }
      }

      // 4. Lưu biên nhận vào collection deposits
      const depRef = db.collection('deposits').doc();
      transaction.set(depRef, {
        uid,
        amount: amountNum,
        package_id: matchedPkgKey,
        package_name: pkgInfo.name,
        code: cleanContent,
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    sendTelegram(`🎉 *Kích Hoạt Gói 12 Ngày Tự Động*\n- Thợ đào: \`ID: ${uid}\`\n- Gói: *${pkgInfo.name}*\n- Số tiền: ${amountNum.toLocaleString('vi-VN')} đ`);
    return res.json({ success: true, message: 'Đã kích hoạt gói 12 ngày và chia hoa hồng F1 (15%), F2 (5%)' });
  } catch (error) {
    console.error('Lỗi Webhook:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server GreenCloud Backend đang chạy tại port ${PORT}`);
});
