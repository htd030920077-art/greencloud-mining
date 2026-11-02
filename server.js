// ==========================================
// FILE: server.js - GREENCLOUD BACKEND CHUẨN AN TOÀN
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

app.use(express.static(path.join(__dirname, '.')));

// 1. Khởi tạo Firebase Admin
try {
  const serviceAccount = require('./serviceAccountKey.json');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
  console.log('Firebase Admin kết nối thành công!');
} catch (e) {
  console.error('Lỗi nạp serviceAccountKey.json:', e.message);
}
const db = admin.firestore();

// 2. Telegram Bot (Gửi Text thuần để không bao giờ bị lỗi Markdown)
const TELEGRAM_BOT_TOKEN = '9196510643:AAGzXlYNEeCxz_Pchrg7528VBkaB53sXpd4';
const TELEGRAM_CHAT_ID = '7865394196';

function sendTelegram(msg) {
  try {
    const data = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: msg
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
      console.error('Lỗi Telegram req:', e.message);
    });
    req.write(data);
    req.end();
  } catch (err) {
    console.error('Lỗi gọi Telegram:', err.message);
  }
}

const PACKAGES_CONFIG = {
  '76k': { name: 'Gói Khởi Động 76K', cost: 76000, daily: 16720 },
  '104k': { name: 'Gói Tiêu Chuẩn 104K', cost: 104000, daily: 22880 },
  '208k': { name: 'Gói Nâng Cao 208K', cost: 208000, daily: 45760 },
  '416k': { name: 'Gói Chuyên Nghiệp 416K', cost: 416000, daily: 91520 },
  '832k': { name: 'Gói Trang Trại 832K', cost: 832000, daily: 183040 },
  '1500k': { name: 'Gói Cá Voi VIP 1.5M', cost: 1500000, daily: 330000 }
};

// ==========================================
// 3. API ĐĂNG KÝ
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
      const spClean = String(sponsorUid).trim();
      let f1Snap = await db.collection('users').doc(spClean).get();
      if (!f1Snap.exists) {
        const qF1 = await db.collection('users').where('uid', 'in', [spClean, Number(spClean)]).limit(1).get();
        if (!qF1.empty) f1Snap = qF1.docs[0];
      }

      if (f1Snap && f1Snap.exists) {
        validSponsorUid = f1Snap.data().uid || f1Snap.id;
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
      upgrade_balance: 20000,
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
      let spRef = db.collection('users').doc(String(validSponsorUid));
      let spSnap = await spRef.get();
      if (!spSnap.exists) {
        const qSp = await db.collection('users').where('uid', 'in', [String(validSponsorUid), Number(validSponsorUid)]).limit(1).get();
        if (!qSp.empty) spRef = qSp.docs[0].ref;
      }
      await spRef.update({
        ref_f1_count: admin.firestore.FieldValue.increment(1),
        gift_spins: admin.firestore.FieldValue.increment(1)
      }).catch(() => {});
    }

    sendTelegram(`👤 THỢ ĐÀO MỚI ĐĂNG KÝ\n- Họ tên: ${fullName}\n- SĐT: ${phone}\n- ID: ${newUid}\n- Cấp trên: ${validSponsorUid || 'Không có'}`);

    return res.json({ success: true, user: newUser });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// 4. API BÁO RÚT TIỀN
// ==========================================
app.post('/api/withdraw/alert', (req, res) => {
  const { uid, name, amount, bank, acc, holder } = req.body;
  sendTelegram(`📤 YÊU CẦU RÚT TIỀN MỚI\n- Thợ Đào: ${name} (ID: ${uid})\n- Số tiền: ${Number(amount).toLocaleString('vi-VN')} đ\n- Ngân hàng: ${bank}\n- STK: ${acc}\n- Chủ thẻ: ${holder}`);
  return res.json({ success: true });
});

// ==========================================
// 5. WEBHOOK SEPAY (LUÔN TRẢ VỀ HTTP 200)
// ==========================================
app.post('/api/webhook/sepay', async (req, res) => {
  console.log('--- [SEPAY WEBHOOK NHẬN ĐƯỢC] ---', JSON.stringify(req.body));
  
  // Trả về 200 ngay để SePay ghi nhận thành công, xử lý ngầm bên dưới
  res.status(200).json({ success: true, message: 'Đã nhận webhook' });

  try {
    const body = req.body || {};
    const rawAmount = body.transferAmount || body.amountIn || body.amount || 0;
    const amountNum = Math.round(Number(String(rawAmount).replace(/[^0-9]/g, '')) || 0);

    const rawContent = body.content || body.description || body.code || '';
    const cleanContent = rawContent.toString().trim().toUpperCase();

    if (amountNum <= 0) {
      console.log('Bỏ qua: Số tiền không hợp lệ.');
      return;
    }

    // Bóc tách ID người chơi: Hỗ trợ GCxxxx, chuỗi số đầu, hoặc tìm chuỗi số từ 6-9 ký tự
    let uid = null;
    const matchGC = cleanContent.match(/GC\s*(\d{6,9})/i);
    if (matchGC) {
      uid = matchGC[1];
    } else {
      const matchAny = cleanContent.match(/(\d{6,9})/);
      if (matchAny) {
        uid = matchAny[1];
      }
    }

    if (!uid) {
      console.log('Không tìm thấy ID người chơi hợp lệ từ nội dung:', cleanContent);
      sendTelegram(`⚠️ SEPAY: Nhận ${amountNum.toLocaleString('vi-VN')} đ nhưng KHÔNG tìm thấy ID thợ đào trong nội dung: "${cleanContent}"`);
      return;
    }

    console.log(`Bắt đầu xử lý cho UID: ${uid} - Số tiền: ${amountNum}`);

    // Tìm kiếm trong Firestore
    let userRef = db.collection('users').doc(String(uid));
    let userSnap = await userRef.get();

    if (!userSnap.exists) {
      let qSnap = await db.collection('users').where('uid', '==', String(uid)).limit(1).get();
      if (qSnap.empty) {
        qSnap = await db.collection('users').where('uid', '==', Number(uid)).limit(1).get();
      }

      if (!qSnap.empty) {
        userRef = qSnap.docs[0].ref;
        userSnap = qSnap.docs[0];
      } else {
        console.log('Không tìm thấy User trong Firestore:', uid);
        sendTelegram(`⚠️ SEPAY: Nhận ${amountNum.toLocaleString('vi-VN')} đ nhưng ID ${uid} chưa tồn tại trên hệ thống.`);
        return;
      }
    }

    const userData = userSnap.data();

    // Đối chiếu gói đào
    let matchedPkgKey = null;
    for (const [k, p] of Object.entries(PACKAGES_CONFIG)) {
      if (Number(p.cost) === amountNum) {
        matchedPkgKey = k;
        break;
      }
    }

    // Nạp số tiền lẻ -> Cộng thẳng ví chính
    if (!matchedPkgKey) {
      await userRef.update({
        balance: admin.firestore.FieldValue.increment(amountNum)
      });
      sendTelegram(`💰 NẠP TIỀN VÀO VÍ THÀNH CÔNG\n- Thợ đào ID: ${uid}\n- Số tiền: +${amountNum.toLocaleString('vi-VN')} đ\n- Nội dung: ${cleanContent}`);
      return;
    }

    const pkgInfo = PACKAGES_CONFIG[matchedPkgKey];
    const now = Date.now();

    // Kích hoạt gói máy đào 12 ngày
    const newInstance = { pkgId: matchedPkgKey, activatedAt: now };
    await userRef.update({
      [`owned_packages.${matchedPkgKey}`]: admin.firestore.FieldValue.increment(1),
      active_instances: admin.firestore.FieldValue.arrayUnion(newInstance),
      has_paid_package: true,
      last_active_at: now
    });

    // Chia hoa hồng F1 (15%) và F2 (5%)
    let f1Uid = userData.sponsor_uid || userData.sponsor || null;
    if (f1Uid) {
      f1Uid = String(f1Uid).trim();
      let f1Ref = db.collection('users').doc(f1Uid);
      let f1Snap = await f1Ref.get();

      if (!f1Snap.exists) {
        const qF1 = await db.collection('users').where('uid', 'in', [f1Uid, Number(f1Uid)]).limit(1).get();
        if (!qF1.empty) {
          f1Ref = qF1.docs[0].ref;
          f1Snap = qF1.docs[0];
        }
      }

      if (f1Snap && f1Snap.exists) {
        const f1Comm = Math.round(amountNum * 0.15);
        await f1Ref.update({
          balance: admin.firestore.FieldValue.increment(f1Comm),
          ref_f1_paid_count: admin.firestore.FieldValue.increment(1)
        });
        sendTelegram(`💰 HOA HỒNG F1 (+15%) TỰ ĐỘNG\n- Cấp trên F1 ID: ${f1Uid}\n- Từ F1 ID: ${uid}\n- Số tiền: +${f1Comm.toLocaleString('vi-VN')} đ`);

        const f1Data = f1Snap.data();
        let f2Uid = userData.sponsor_f2_uid || f1Data.sponsor_uid || null;

        if (f2Uid) {
          f2Uid = String(f2Uid).trim();
          let f2Ref = db.collection('users').doc(f2Uid);
          let f2Snap = await f2Ref.get();

          if (!f2Snap.exists) {
            const qF2 = await db.collection('users').where('uid', 'in', [f2Uid, Number(f2Uid)]).limit(1).get();
            if (!qF2.empty) {
              f2Ref = qF2.docs[0].ref;
              f2Snap = qF2.docs[0];
            }
          }

          if (f2Snap && f2Snap.exists) {
            const f2Comm = Math.round(amountNum * 0.05);
            await f2Ref.update({
              balance: admin.firestore.FieldValue.increment(f2Comm)
            });
            sendTelegram(`💎 HOA HỒNG F2 (+5%) TỰ ĐỘNG\n- Cấp trên F2 ID: ${f2Uid}\n- Từ F2 ID: ${uid}\n- Số tiền: +${f2Comm.toLocaleString('vi-VN')} đ`);
          }
        }
      }
    }

    // Ghi nhận lịch sử nạp
    await db.collection('deposits').add({
      uid: String(uid),
      amount: amountNum,
      package_id: matchedPkgKey,
      package_name: pkgInfo.name,
      code: cleanContent,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    sendTelegram(`🎉 KÍCH HOẠT GÓI ĐÀO (12 NGÀY) TỰ ĐỘNG\n- Thợ đào ID: ${uid}\n- Gói: ${pkgInfo.name}\n- Số tiền: ${amountNum.toLocaleString('vi-VN')} đ\n- Nội dung: ${cleanContent}`);

  } catch (error) {
    console.error('Lỗi ngầm Webhook:', error);
  }
});

// ==========================================
// 6. KHỞI CHẠY SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server Backend GreenCloud đang chạy trên cổng ${PORT}`);
  sendTelegram("🚀 Hệ Thống Backend GreenCloud Đã Khởi Động Live Trên Render!");
});

setInterval(() => {
  https.get('https://greencloud-mining-server.onrender.com', () => {}).on('error', () => {});
}, 10 * 60 * 1000);
