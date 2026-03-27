import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 🔐 KEY PAYOS
const CLIENT_ID = process.env.CLIENT_ID;
const API_KEY = process.env.API_KEY;
const CHECKSUM_KEY = process.env.CHECKSUM_KEY;

// 🌉 BRIDGE CONFIG
// BRIDGE_TOKEN: token để BP gọi /poll và /ack
// DEFAULT_SERVER_ID: serverId mặc định nếu bạn chỉ có 1 server
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "hlsmp123";
const DEFAULT_SERVER_ID = process.env.DEFAULT_SERVER_ID || "hlsmp-main";

// chống trùng cơ bản khi process còn sống
const processedOrders = new Set();

// hàng chờ topup theo serverId
// jobsByServer.get(serverId) = [{ player, amount, coin, orderId, createdAt }]
const jobsByServer = new Map();

// quy đổi tiền -> coin
const TOPUP_RATES = {
  10000: 50,
  20000: 100,
  50000: 250,
  100000: 500,
  200000: 1000,
  500000: 2500
};

function amountToCoin(amount) {
  return TOPUP_RATES[Number(amount)] || 0;
}

function extractPlayerAndOrderId(description, orderCode) {
  const text = String(description || "").trim();

  // Trường hợp chuẩn: player_HL123...
  const m1 = text.match(/^([a-zA-Z0-9_]{1,16})_(HL\d+)$/);
  if (m1) {
    return { player: m1[1], orderId: m1[2] };
  }

  // Trường hợp bị nuốt dấu _: playerHL123...
  const m2 = text.match(/^([a-zA-Z0-9_]{1,16}?)(HL\d+)$/);
  if (m2) {
    return { player: m2[1], orderId: m2[2] };
  }

  // Fallback an toàn
  const player = (text.match(/^([a-zA-Z0-9_]{1,16})/) || [null, text])[1] || text;
  const orderId = "HL" + String(orderCode || "");
  return { player, orderId };
}

function pushJob(serverId, job) {
  if (!jobsByServer.has(serverId)) {
    jobsByServer.set(serverId, []);
  }
  jobsByServer.get(serverId).push(job);
}

function peekJob(serverId) {
  const queue = jobsByServer.get(serverId) || [];
  return queue.length > 0 ? queue[0] : null;
}

function ackJob(serverId, orderId) {
  const queue = jobsByServer.get(serverId) || [];
  if (queue.length === 0) return false;

  const first = queue[0];
  if (first.orderId !== orderId) return false;

  queue.shift();
  jobsByServer.set(serverId, queue);
  return true;
}

// 👉 TEST
app.get("/", (req, res) => {
  res.send("NAP PAYOS OK");
});

// 👉 TẠO LINK NẠP
app.post("/create", async (req, res) => {
  try {
    const { player, amount } = req.body;

    if (!player || !amount) {
      return res.status(400).json({ error: "Thiếu player hoặc amount" });
    }

    const amountNum = Number(amount);
    if (!TOPUP_RATES[amountNum]) {
      return res.status(400).json({ error: "Mức nạp không hợp lệ" });
    }

    const orderCode = Number(Date.now());
    const orderId = "HL" + orderCode;
    const description = `${player}_${orderId}`;

    const data = {
      orderCode,
      amount: amountNum,
      description,
      returnUrl: "https://google.com",
      cancelUrl: "https://google.com"
    };

    const raw = `amount=${data.amount}&cancelUrl=${data.cancelUrl}&description=${description}&orderCode=${orderCode}&returnUrl=${data.returnUrl}`;

    const signature = crypto
      .createHmac("sha256", CHECKSUM_KEY)
      .update(raw)
      .digest("hex");

    const response = await fetch("https://api-merchant.payos.vn/v2/payment-requests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-id": CLIENT_ID,
        "x-api-key": API_KEY
      },
      body: JSON.stringify({
        ...data,
        signature
      })
    });

    const result = await response.json();

    res.status(response.status).json({
      orderId,
      payUrl: result?.data?.checkoutUrl,
      payos: result
    });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// 👉 WEBHOOK (khi thanh toán xong)
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    // cấu trúc thực tế của payOS thường nằm trong body.data
    const data = body?.data || body || {};
    const description = data?.description || body?.description || "";
    const amount = Number(data?.amount || body?.amount || 0);
    const orderCode = String(data?.orderCode || body?.orderCode || "");
    const code = body?.code ?? data?.code;
    const desc = body?.desc ?? data?.desc;

    // payOS thành công thường có code = "00"
    const isSuccess = String(code) === "00" || /success/i.test(String(desc || ""));

    if (!description) {
      console.log("WEBHOOK KHONG CO DESCRIPTION");
      return res.sendStatus(200);
    }

    const parsed = extractPlayerAndOrderId(description, orderCode);
    const player = parsed.player;
    const orderId = parsed.orderId;

    if (!isSuccess) {
      console.log("WEBHOOK CHUA THANH CONG:", { description, code, desc });
      return res.sendStatus(200);
    }

    if (processedOrders.has(orderId)) {
      console.log("BO QUA DON TRUNG:", orderId);
      return res.sendStatus(200);
    }

    const coin = amountToCoin(amount);
    if (!coin) {
      console.log("AMOUNT KHONG HOP LE:", amount, orderId);
      return res.sendStatus(200);
    }

    processedOrders.add(orderId);

    const job = {
      player,
      amount,
      coin,
      orderId,
      createdAt: Date.now()
    };

    pushJob(DEFAULT_SERVER_ID, job);

    console.log("NAP THANH CONG:", job);
    console.log("QUEUE", DEFAULT_SERVER_ID, jobsByServer.get(DEFAULT_SERVER_ID)?.length || 0);

    res.sendStatus(200);
  } catch (err) {
    console.error("LOI WEBHOOK:", err);
    res.sendStatus(200);
  }
});

// 👉 BP hỏi có đơn nào chưa nhận không
app.get("/poll", (req, res) => {
  try {
    const serverId = req.query.serverId || DEFAULT_SERVER_ID;
    const token = req.query.token || "";

    if (token !== BRIDGE_TOKEN) {
      return res.status(403).json({ error: "Sai token" });
    }

    const job = peekJob(serverId);

    if (!job) {
      return res.json({ ok: true, job: null });
    }

    return res.json({
      ok: true,
      job
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// 👉 BP báo đã cộng coin xong
app.post("/ack", (req, res) => {
  try {
    const { serverId, token, orderId } = req.body || {};

    if (token !== BRIDGE_TOKEN) {
      return res.status(403).json({ error: "Sai token" });
    }

    if (!serverId || !orderId) {
      return res.status(400).json({ error: "Thiếu serverId hoặc orderId" });
    }

    const ok = ackJob(serverId, orderId);

    return res.json({ ok });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// 👉 xem hàng chờ nhanh để debug
app.get("/queue", (req, res) => {
  const serverId = req.query.serverId || DEFAULT_SERVER_ID;
  const queue = jobsByServer.get(serverId) || [];
  res.json({
    ok: true,
    serverId,
    size: queue.length,
    queue
  });
});

app.listen(PORT, () => {
  console.log("Server running:", PORT);
});
