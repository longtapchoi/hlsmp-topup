import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 🔐 KEY PAYOS
const CLIENT_ID = process.env.CLIENT_ID;
const API_KEY = process.env.API_KEY;
const CHECKSUM_KEY = process.env.CHECKSUM_KEY;

// 🌉 MINI APP BRIDGE
// Ví dụ:
// MINI_APP_URL=https://link-mini-app-cua-ban
// MINI_APP_SERVER_ID=hlsmp-main
const MINI_APP_URL = (process.env.MINI_APP_URL || "").replace(/\/+$/, "");
const MINI_APP_SERVER_ID = process.env.MINI_APP_SERVER_ID || "hlsmp-main";

// chống trùng cơ bản khi process còn sống
const processedOrders = new Set();

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

    const orderCode = Number(Date.now());
    const orderId = "HL" + orderCode;
    const description = `${player}_${orderId}`;

    const data = {
      orderCode,
      amount: Number(amount),
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

    const parts = description.split("_");
    const player = parts[0];
    const orderId = parts.slice(1).join("_") || ("HL" + orderCode);

    if (!isSuccess) {
      console.log("WEBHOOK CHUA THANH CONG:", { description, code, desc });
      return res.sendStatus(200);
    }

    if (processedOrders.has(orderId)) {
      console.log("BO QUA DON TRUNG:", orderId);
      return res.sendStatus(200);
    }

    processedOrders.add(orderId);

    console.log("NAP THANH CONG:", player, amount, orderId);

    if (!MINI_APP_URL) {
      console.log("CHUA CAU HINH MINI_APP_URL, BO QUA GUI /topup");
      return res.sendStatus(200);
    }

    const bridgeResponse = await fetch(`${MINI_APP_URL}/topup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        serverId: MINI_APP_SERVER_ID,
        player,
        amount,
        orderId
      })
    });

    const bridgeText = await bridgeResponse.text();
    console.log("GUI /topup:", bridgeResponse.status, bridgeText);

    res.sendStatus(200);
  } catch (err) {
    console.error("LOI WEBHOOK:", err);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log("Server running:", PORT);
});
