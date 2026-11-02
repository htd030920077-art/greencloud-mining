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

// 3. API Đăng Ký Tài Khoản & Gắn Cây Phả Hệ F1, F2 (+1 lượt mở hộp cho cấp trên)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password, fullName, sponsorUid } = req.body;
    if (!phone || !password) return res.status(400).json({ success: false, message: 'Thiếu thông tin!' });

    // Kiểm tra số điện thoại đã đăng ký chưa
    const checkQuery = await db.collection('users').where('phone', '==', phone).get();
    if (!checkQuery.empty) {
      return res.status(400).json({ success: false, message: 'Số điện thoại này đã được đăng ký!' });
    }

    let sponsorF2Uid = null;
    let validSponsorUid = null;

    // Tìm cấp trên F1 và suy ra F2
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
      upgrade_balance: 20000, // Tặng sẵn 20k vào Hũ
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

    // Tự động tăng số lượng F1 và cộng ngay +1 lượt mở hộp cho cấp trên
    if (validSponsorUid) {
      await db.collection('users').doc(validSponsorUid).update({
        ref_f1_count: admin.firestore.FieldValue.increment(1),
        gift_spins: admin.firestore.FieldValue.increment(1)
      });
    }

    sendTelegram(`👤 *Thợ Đào Mới Đăng Ký*\n- Họ tên: *${fullName}*\n- SĐT: \`${phone}\`\n- UID: \`GC-${newUid}\`\n- Người giới thiệu: ${validSponsorUid ? '`GC-' + validSponsorUid + '`' : 'Không có'}`);

    return res.json({ success: true, user: newUser });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 4. Webhook SePay Tự Động Kích Hoạt Gói 12 Ngày & Chia Hoa Hồng (F1: 15% - F2: 5%)
app.post('/api/webhook/sepay', async (req, res) => {
  try {
    const { transferAmount, content, referenceCode } = req.body;
    if (!transferAmount || !content) return res.status(400).send('Dữ liệu thiếu');

    const cleanContent = content.trim().toUpperCase();
    const amountNum = Number(transferAmount);

    // 1. Kiểm tra nạp Gói Đào: Quét mã GCxxxxxxx trong nội dung chuyển khoản
    const matchGC = cleanContent.match(/GC(\d+)/i);
    if (matchGC) {
      const uid = matchGC[1];
      const userRef = db.collection('users').doc(uid);
      const userSnap = await userRef.get();

      if (!userSnap.exists) return res.status(404).send('Không tìm thấy thợ đào');
      const userData = userSnap.data();

      let matchedPkgKey = null;
      for (const [k, p] of Object.entries(PACKAGES_CONFIG)) {
        if (p.cost === amountNum) {
          matchedPkgKey = k;
          break;
        }
      }

      if (!matchedPkgKey) return res.status(200).send('Số tiền không khớp gói nào');
      const pkgInfo = PACKAGES_CONFIG[matchedPkgKey];

      await db.runTransaction(async (transaction) => {
        // Cập nhật số lượng và thêm vào danh sách máy đào 12 ngày
        const newInstance = { pkgId: matchedPkgKey, activatedAt: Date.now() };
        transaction.update(userRef, {
          [`owned_packages.${matchedPkgKey}`]: admin.firestore.FieldValue.increment(1),
          active_instances: admin.firestore.FieldValue.arrayUnion(newInstance),
          has_paid_package: true,
          last_active_at: Date.now()
        });

        // Chia hoa hồng F1 (15%)
        if (userData.sponsor_uid) {
          const f1Ref = db.collection('users').doc(userData.sponsor_uid);
          const f1Snap = await transaction.get(f1Ref);
          if (f1Snap.exists) {
            const f1Commission = amountNum * 0.15;
            transaction.update(f1Ref, {
              balance: admin.firestore.FieldValue.increment(f1Commission),
              ref_f1_paid_count: admin.firestore.FieldValue.increment(1)
            });

            sendTelegram(`💰 *Hoa Hồng F1 (+15%) Tự Động*\n- Nhận: \`GC-${userData.sponsor_uid}\`\n- Từ cấp dưới: \`GC-${uid}\`\n- Cộng: *+${f1Commission.toLocaleString('vi-VN')} đ*`);
          }
        }

        // Chia hoa hồng F2 (5%)
        if (userData.sponsor_f2_uid) {
          const f2Ref = db.collection('users').doc(userData.sponsor_f2_uid);
          const f2Snap = await transaction.get(f2Ref);
          if (f2Snap.exists) {
            const f2Commission = amountNum * 0.05;
            transaction.update(f2Ref, {
              balance: admin.firestore.FieldValue.increment(f2Commission)
            });

            sendTelegram(`💎 *Hoa Hồng F2 (+5%) Tự Động*\n- Nhận: \`GC-${userData.sponsor_f2_uid}\`\n- Từ nhánh F2: \`GC-${uid}\`\n- Cộng: *+${f2Commission.toLocaleString('vi-VN')} đ*`);
          }
        }

        // Lưu bản ghi vào collection deposits
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

      sendTelegram(`🎉 *Kích Hoạt Gói 12 Ngày Thành Công*\n- Thợ đào: \`GC-${uid}\`\n- Gói: *${pkgInfo.name}*\n- Số tiền: ${amountNum.toLocaleString('vi-VN')} đ`);
      return res.json({ success: true, message: 'Đã kích hoạt gói 12 ngày và chia hoa hồng F1 (15%), F2 (5%)' });
    }

    // 2. Kiểm tra nạp Hũ Nâng Cấp: Quét mã NCxxxxxxx trong nội dung chuyển khoản
    const matchNC = cleanContent.match(/NC(\d+)/i);
    if (matchNC) {
      const uid = matchNC[1];
      const userRef = db.collection('users').doc(uid);

      await userRef.update({
        upgrade_balance: admin.firestore.FieldValue.increment(amountNum)
      });

      sendTelegram(`💠 *Nạp Hũ Nâng Cấp Thành Công*\n- Thợ đào: \`GC-${uid}\`\n- Đã nạp: *+${amountNum.toLocaleString('vi-VN')} đ*`);
      return res.json({ success: true, message: 'Đã nạp tiền Hũ thành công' });
    }

    return res.status(200).send('Bỏ qua nội dung không khớp cú pháp GC/NC');
  } catch (error) {
    console.error('Lỗi Webhook:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Cổng chạy server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server GreenCloud Backend đang chạy tại port ${PORT}`);
});
