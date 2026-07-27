// ------------------------------------------------------------
// CPA 링크 트래커 - 최소 버전
// 기능: 내 CPA 링크를 짧은 코드로 등록하고, 클릭이 발생할 때마다
//       시각/횟수를 기록한 뒤 실제 링크로 리다이렉트합니다.
//
// ⚠️ 이 도구는 "클릭"만 기록합니다.
//    실제 구매(전환)/수익은 마이리얼트립 파트너스 페이지에서 직접 확인하세요.
// ------------------------------------------------------------

const express = require("express");
const path = require("path");
const { nanoid } = require("nanoid");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- 링크 목록 조회 ----------
app.get("/api/links", (req, res) => {
  const data = db.load();
  const list = data.links
    .map((l) => ({
      code: l.code,
      label: l.label,
      targetUrl: l.targetUrl,
      createdAt: l.createdAt,
      clickCount: l.clicks.length,
      lastClickedAt: l.clicks.length ? l.clicks[l.clicks.length - 1] : null,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

// ---------- 새 링크 등록 ----------
app.post("/api/links", (req, res) => {
  const { targetUrl, label } = req.body;

  if (!targetUrl || !/^https?:\/\//.test(targetUrl)) {
    return res.status(400).json({ error: "올바른 URL을 입력해주세요 (http:// 또는 https://로 시작)" });
  }

  const data = db.load();
  const code = nanoid(7);
  data.links.push({
    code,
    label: label || "(라벨 없음)",
    targetUrl,
    createdAt: new Date().toISOString(),
    clicks: [],
  });
  db.save(data);

  res.json({ code, shortUrl: `${req.protocol}://${req.get("host")}/r/${code}` });
});

// ---------- 링크 삭제 ----------
app.delete("/api/links/:code", (req, res) => {
  const data = db.load();
  data.links = data.links.filter((l) => l.code !== req.params.code);
  db.save(data);
  res.json({ ok: true });
});

// ---------- 핵심: 클릭 발생 시 기록 후 실제 링크로 리다이렉트 ----------
app.get("/r/:code", (req, res) => {
  const data = db.load();
  const link = data.links.find((l) => l.code === req.params.code);

  if (!link) {
    return res.status(404).send("존재하지 않는 링크입니다.");
  }

  link.clicks.push(new Date().toISOString());
  db.save(data);

  res.redirect(302, link.targetUrl);
});

app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: http://localhost:${PORT}`);
});
