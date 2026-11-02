// ==========================================
// FILE: server.js - GREENCLOUD FULL BACKEND
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

// 2. Cấu hình Telegram Bot (Chuẩn HTTPS Node.js gốc)
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

// Cấu hình danh mục gói đào 12 ngày
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

    sendTelegram(`👤 *THỢ ĐÀO MỚI ĐĂNG KÝ*\n- Họ tên: *${fullName}*\n- SĐT: \`${phone}\`\n- ID Nick: \`${newUid}\`\n- Cấp trên: ${validSponsorUid ? '`' + validSponsorUid + '`' : 'Không có'}`);

    return res.json({ success: true, user: newUser });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// 4. API THÔNG BÁO LỆNH RÚT TIỀN VỀ TELEGRAM
// ==========================================
app.post('/api/withdraw/alert', (req, res) => {
  const { uid, name, amount, bank, acc, holder } = req.body;
  sendTelegram(`📤 *YÊU CẦU RÚT TIỀN MỚI*\n- Thợ Đào: *${name}* (\`ID: ${uid}\`)\n- Số tiền rút: *${Number(amount).toLocaleString('vi-VN')} đ*\n- Ngân hàng: *${bank}*\n- Số tài khoản: \`${acc}\`\n- Tên chủ thẻ: *${holder}*\n- Trạng thái: *Chờ duyệt trên Admin*`);
  return res.json({ success: true });
});

// ==========================================
// 5. WEBHOOK SEPAY (TỰ BÓC TÁCH ID NICK, KÍCH HOẠT GÓI 12 NGÀY & CHIA HOA HỒNG)
// ==========================================
app.post('/api/webhook/sepay', async (req, res) => {
  console.log('--- [SEPAY WEBHOOK RECEIVED] ---', JSON.stringify(req.body));
  try {
    const body = req.body || {};

    // 1. Chuẩn hóa số tiền nhận
    const rawAmount = body.transferAmount || body.amountIn || body.amount || 0;
    const amountNum = Math.round(Number(String(rawAmount).replace(/[^0-9]/g, '')) || 0);

    // 2. Chuẩn hóa nội dung chuyển khoản
    const rawContent = body.content || body.description || body.code || '';
    const cleanContent = rawContent.toString().trim().toUpperCase();

    if (amountNum <= 0) {
      console.log('Bỏ qua: Số tiền không hợp lệ:', amountNum);
      return res.status(200).json({ success: false, message: 'Số tiền <= 0' });
    }

    // 3. Bóc tách ID người chơi:
    // Hỗ trợ cả GC6138215 lẫn số thuần đứng đầu như 6138215- ...[span_0](start_span)[span_0](end_span)
    let uid = null;
    const matchGC = cleanContent.match(/GC\s*(\d{6,9})/i);
    if (matchGC) {
      uid = matchGC[1];
    } else {
      const matchHead = cleanContent.match(/^(\d{6,9})/);
      if (matchHead) {
        uid = matchHead[1];
      } else {
        const matchAny = cleanContent.match(/(\d{6,9})/);
        if (matchAny) uid = matchAny[1];
      }
    }

    if (!uid) {
      console.log('Không tìm thấy ID người chơi trong nội dung:', cleanContent);
      return res.status(200).json({ success: false, message: 'Không tìm thấy ID' });
    }

    console.log(`Bắt đầu xử lý nạp cho UID: ${uid} với số tiền: ${amountNum}`);

    // 4. Tìm kiếm người dùng trong Firestore (hỗ trợ cả DocID, String lẫn Number)
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
        console.log('Không tìm thấy User Firestore với UID:', uid);
        return res.status(200).json({ success: false, message: 'Tài khoản không tồn tại' });
      }
    }

    const userData = userSnap.data();

    // 5. Đối chiếu số tiền với các gói đào
    let matchedPkgKey = null;
    for (const [k, p] of Object.entries(PACKAGES_CONFIG)) {
      if (Number(p.cost) === amountNum) {
        matchedPkgKey = k;
        break;
      }
    }

    // Nếu không khớp gói nào -> Cộng tiền thẳng vào Ví chính
    if (!matchedPkgKey) {
      await userRef.update({
        balance: admin.firestore.FieldValue.increment(amountNum)
      });
      sendTelegram(`💰 *NẠP TIỀN VÀO VÍ THÀNH CÔNG*\n- Thợ đào: \`ID: ${uid}\`\n- Số tiền: *+${amountNum.toLocaleString('vi-VN')} đ*\n- Nội dung: \`${cleanContent}\``);
      return res.status(200).json({ success: true, message: 'Đã cộng vào ví chính' });
    }

    const pkgInfo = PACKAGES_CONFIG[matchedPkgKey];
    const now = Date.now();

    // 6. Kích hoạt dàn máy đào 12 ngày cho người nạp
    const newInstance = { pkgId: matchedPkgKey, activatedAt: now };

    await userRef.update({
      [`owned_packages.${matchedPkgKey}`]: admin.firestore.FieldValue.increment(1),
      active_instances: admin.firestore.FieldValue.arrayUnion(newInstance),
      has_paid_package: true,
      last_active_at: now
    });

    // 7. Xử lý chia hoa hồng F1 (15%) và F2 (5%) an toàn
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
        sendTelegram(`💰 *HOA HỒNG F1 (+15%) TỰ ĐỘNG*\n- Cấp trên F1: \`ID: ${f1Uid}\`\n- Nhận từ F1: \`ID: ${uid}\`\n- Số tiền: *+${f1Comm.toLocaleString('vi-VN')} đ*`);

        // Tìm cấp trên F2
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
            sendTelegram(`💎 *HOA HỒNG F2 (+5%) TỰ ĐỘNG*\n- Cấp trên F2: \`ID: ${f2Uid}\`\n- Nhận từ F2: \`ID: ${uid}\`\n- Số tiền: *+${f2Comm.toLocaleString('vi-VN')} đ*`);
          }
        }
      } else {
        console.log('Không tìm thấy cấp trên F1 mang ID:', f1Uid);
      }
    }

    // 8. Lưu lịch sử nạp vào collection deposits
    await db.collection('deposits').add({
      uid: String(uid),
      amount: amountNum,
      package_id: matchedPkgKey,
      package_name: pkgInfo.name,
      code: cleanContent,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    sendTelegram(`🎉 *KÍCH HOẠT GÓI ĐÀO (12 NGÀY) TỰ ĐỘNG*\n- Thợ đào: \`ID: ${uid}\`\n- Gói kích hoạt: *${pkgInfo.name}*\n- Số tiền: *${amountNum.toLocaleString('vi-VN')} đ*\n- Nội dung CK: \`${cleanContent}\``);

    return res.status(200).json({ success: true, message: 'Đã kích hoạt gói 12 ngày và chia hoa hồng thành công' });

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
  console.log(`Server Backend GreenCloud đang chạy trên cổng ${PORT}`);
  sendTelegram("🚀 *Hệ Thống Backend GreenCloud Đã Khởi Động Live Trên Render!*");
});

// Tự động ping mỗi 10 phút để server Render không bao giờ ngủ
setInterval(() => {
  https.get('https://greencloud-mining-liver.onrender.com', (res) => {
    // Ping giữ máy chủ online
  }).on('error', () => {});
}, 10 * 60 * 1000);
