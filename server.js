import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 🔐 KEY PAYOS (lát nữa set trên Render)
const CLIENT_ID = process.env.CLIENT_ID;
const API_KEY = process.env.API_KEY;
const CHECKSUM_KEY = process.env.CHECKSUM_KEY;

// 👉 TEST
app.get("/", (req, res) => {
  res.send("NAP PAYOS OK");
});

// 👉 TẠO LINK NẠP
app.post("/create", async (req, res) => {
  try {
    const { player, amount } = req.body;

    const orderCode = Number(Date.now());
    const orderId = "HL" + orderCode;

    const description = `${player}_${orderId}`;

    const data = {
      orderCode,
      amount,
      description,
      returnUrl: "https://google.com",
      cancelUrl: "https://google.com"
    };

    const raw = `amount=${amount}&cancelUrl=${data.cancelUrl}&description=${description}&orderCode=${orderCode}&returnUrl=${data.returnUrl}`;

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

    res.json({
      orderId,
      payUrl: result.data.checkoutUrl
    });

  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// 👉 WEBHOOK (khi thanh toán xong)
app.post("/webhook", (req, res) => {
  const body = req.body;

  const description = body?.data?.description;

  if (description) {
    const player = description.split("_")[0];

    console.log("NAP THANH CONG:", player);

    // 👉 sau nối Minecraft ở đây
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log("Server running:", PORT);
});
