// ------------------------------------------------------------
// CPA 링크 트래커 - Supabase 연동 버전
// 기능: 내 CPA 링크를 짧은 코드로 등록하고, 클릭이 발생할 때마다
//       시각/횟수를 Supabase(외부 DB)에 기록한 뒤 실제 링크로 리다이렉트합니다.
// 재배포해도 데이터가 사라지지 않습니다 (파일이 아니라 DB에 저장하기 때문).
//
// ⚠️ 이 도구는 "클릭"만 기록합니다.
//    실제 구매(전환)/수익은 마이리얼트립 파트너스 페이지에서 직접 확인하세요.
// ------------------------------------------------------------

const express = require("express");
const path = require("path");
const multer = require("multer");
const readXlsxFile = require("read-excel-file/node");
const { nanoid } = require("nanoid");
const db = require("./db");
const {
  analyzeKeywords,
  fetchRelatedCandidates,
  debugSignatureTest,
  debugBlogTest,
  DEFAULT_LONGTAIL_SUFFIXES,
} = require("./naverKeywordApi");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;

// 링크 미리보기(썸네일/제목) 만들려고 자동으로 들어오는 봇들.
// 사람이 실제로 클릭한 게 아니라서 클릭수에서 제외합니다.
const BOT_UA_PATTERNS = [
  "kakaotalk",
  "naver",
  "facebookexternalhit",
  "twitterbot",
  "slackbot",
  "telegrambot",
  "discordbot",
  "whatsapp",
  "bot",
  "crawler",
  "spider",
  "preview",
  "headlesschrome",
];

function isBotRequest(userAgent) {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return BOT_UA_PATTERNS.some((pattern) => ua.includes(pattern));
}

app.use(express.json());

// ---------- 관리 화면 비밀번호 보호 ----------
// /r/:code (블로그 독자가 클릭하는 리다이렉트)는 보호하지 않고,
// 관리 화면(정적 파일 + API)만 비밀번호를 요구합니다.
function requireAdminAuth(req, res, next) {
  // /r/코드 링크는 블로그 독자가 클릭하는 공개 링크라 비밀번호 없이 통과시킴
  if (req.path.startsWith("/r/")) {
    return next();
  }

  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

  if (!ADMIN_PASSWORD) {
    console.warn("⚠️ ADMIN_PASSWORD 환경변수가 없어서 관리 화면이 보호되지 않고 있어요.");
    return next();
  }

  const authHeader = req.headers.authorization || "";
  const [scheme, encoded] = authHeader.split(" ");

  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const [, password] = decoded.split(":"); // 아이디는 아무거나 입력해도 됨, 비밀번호만 확인
    if (password === ADMIN_PASSWORD) {
      return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="link-tracker admin"');
  return res.status(401).send("비밀번호가 필요해요.");
}

app.use(requireAdminAuth);
app.use(express.static(path.join(__dirname, "public")));

// ---------- 정산 엑셀 업로드: 1단계 - 헤더/미리보기 확인 ----------
app.post("/api/sales/preview", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "엑셀 파일을 첨부해주세요." });
  }

  try {
    const sheets = await readXlsxFile(req.file.buffer);
    const rows = sheets[0].data; // 첫 번째 시트만 사용
    if (!rows || rows.length < 2) {
      return res.status(400).json({ error: "엑셀에 데이터가 없어요 (헤더 + 최소 1줄 필요)." });
    }

    const headers = rows[0].map((h) => String(h ?? ""));
    const dataRows = rows.slice(1);

    res.json({
      headers,
      sampleRows: dataRows.slice(0, 5),
      totalRows: dataRows.length,
      // 다음 단계(확정)에서 다시 쓸 수 있도록 전체 원본 행을 그대로 클라이언트에 돌려줌
      allRows: dataRows,
    });
  } catch (err) {
    console.error("엑셀 파싱 실패:", err.message);
    res.status(400).json({ error: "엑셀 파일을 읽지 못했어요. .xlsx 형식인지 확인해주세요." });
  }
});

// ---------- 정산 엑셀 업로드: 2단계 - 컬럼 매핑 확정 후 저장+매칭 ----------
app.post("/api/sales/confirm", async (req, res) => {
  const { rows, productCol, amountCol, dateCol } = req.body;

  if (!Array.isArray(rows) || productCol === undefined || amountCol === undefined) {
    return res.status(400).json({ error: "상품명/금액 컬럼을 선택해주세요." });
  }

  try {
    const parsedRows = rows
      .map((row) => ({
        productName: row[productCol],
        amount: Number(row[amountCol]),
        saleDate: dateCol !== undefined && dateCol !== "" ? row[dateCol] : null,
      }))
      .filter((r) => r.productName && !Number.isNaN(r.amount));

    const result = await db.importSales(parsedRows);
    res.json(result);
  } catch (err) {
    console.error("매출 저장 실패:", err.message);
    res.status(500).json({ error: "매출 데이터 저장에 실패했어요." });
  }
});

// ---------- 링크별 매출 요약 + 미매칭 목록 ----------
app.get("/api/sales/summary", async (req, res) => {
  try {
    const summary = await db.getSalesSummary();
    res.json(summary);
  } catch (err) {
    console.error("매출 요약 조회 실패:", err.message);
    res.status(500).json({ error: "매출 요약을 불러오지 못했어요." });
  }
});

// ---------- 미매칭 판매건을 특정 링크에 수동 연결 ----------
app.post("/api/sales/:saleId/assign", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "연결할 링크 코드가 필요해요." });

  try {
    await db.assignSaleToLink(req.params.saleId, code);
    res.json({ ok: true });
  } catch (err) {
    console.error("수동 매칭 실패:", err.message);
    res.status(500).json({ error: "매칭에 실패했어요." });
  }
});

// ---------- 환경변수 진단(디버그): 값 전체는 안 보여주고 길이/앞뒤 일부만 확인 ----------
app.get("/api/keywords/debug-env", (req, res) => {
  const names = [
    "NAVER_AD_API_KEY",
    "NAVER_AD_SECRET_KEY",
    "NAVER_AD_CUSTOMER_ID",
    "NAVER_CLIENT_ID",
    "NAVER_CLIENT_SECRET",
  ];

  const result = {};
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) {
      result[name] = { set: false };
      continue;
    }
    result[name] = {
      set: true,
      length: raw.length,
      trimmedLength: raw.trim().length,
      hasWhitespace: raw.length !== raw.trim().length,
      preview: `${raw.slice(0, 3)}...${raw.slice(-3)}`,
    };
  }

  res.json(result);
});

// ---------- 디버깅용: 서명 요청 세부내역 + 서버 응답 전체 확인 ----------
app.get("/api/keywords/debug-signature", async (req, res) => {
  try {
    const result = await debugSignatureTest("테스트");
    res.json(result);
  } catch (err) {
    if (err.missingEnv) {
      return res.status(500).json({ error: `${err.missingEnv} 환경변수가 없어요.` });
    }
    res.status(500).json({ error: err.message });
  }
});

// ---------- 디버깅용: 블로그 검색 API 요청/응답 전체 확인 ----------
app.get("/api/keywords/debug-blog", async (req, res) => {
  try {
    const result = await debugBlogTest("테스트");
    res.json(result);
  } catch (err) {
    if (err.missingEnv) {
      return res.status(500).json({ error: `${err.missingEnv} 환경변수가 없어요.` });
    }
    res.status(500).json({ error: err.message });
  }
});

// ---------- 메인/서브 키워드 자동 분석 ----------
// seedKeyword 하나만 주면 연관 키워드까지 뽑아서 검색량/발행량/경쟁지수를 계산.
// keywords 배열을 직접 주면 그 목록만 계산 (연관어 추천 없이).
app.get("/api/keywords/longtail-suffixes", (req, res) => {
  res.json({ suffixes: DEFAULT_LONGTAIL_SUFFIXES });
});

app.post("/api/keywords/analyze", async (req, res) => {
  const { seedKeyword, keywords, includeLongtail, longtailSuffixes } = req.body;

  try {
    let candidateList;
    if (Array.isArray(keywords) && keywords.length > 0) {
      candidateList = keywords;
    } else if (seedKeyword && seedKeyword.trim()) {
      const options = {};
      if (includeLongtail === false) options.includeLongtail = false;
      if (Array.isArray(longtailSuffixes) && longtailSuffixes.length > 0) {
        options.longtailSuffixes = longtailSuffixes;
      }
      candidateList = await fetchRelatedCandidates(seedKeyword.trim(), 15, options);
    } else {
      return res.status(400).json({ error: "seedKeyword 또는 keywords 배열 중 하나는 필요해요." });
    }

    const results = await analyzeKeywords(candidateList);
    res.json({ results });
  } catch (err) {
    console.error("키워드 분석 실패:", err.message);
    if (err.missingEnv) {
      return res.status(500).json({
        error: `${err.missingEnv} 환경변수가 없어요. Render 환경변수에 네이버 API 키 5개를 먼저 등록해주세요.`,
      });
    }
    res.status(500).json({ error: err.message || "키워드 분석에 실패했어요." });
  }
});

// ---------- 링크 목록 조회 ----------
app.get("/api/links", async (req, res) => {
  try {
    const list = await db.listLinks();
    const { revenueByCode } = await db.getSalesSummary();
    const withRevenue = list.map((l) => ({ ...l, revenue: revenueByCode[l.code] || 0 }));
    res.json(withRevenue);
  } catch (err) {
    console.error("링크 목록 조회 실패:", err.message);
    res.status(500).json({ error: "목록을 불러오지 못했어요. Supabase 연결 설정을 확인해주세요." });
  }
});

// ---------- 새 링크 등록 ----------
app.post("/api/links", async (req, res) => {
  const { targetUrl, label } = req.body;

  if (!targetUrl || !/^https?:\/\//.test(targetUrl)) {
    return res.status(400).json({ error: "올바른 URL을 입력해주세요 (http:// 또는 https://로 시작)" });
  }

  try {
    const code = nanoid(7);
    await db.createLink({ code, label: label || "(라벨 없음)", targetUrl });
    res.json({ code, shortUrl: `${req.protocol}://${req.get("host")}/r/${code}` });
  } catch (err) {
    console.error("링크 생성 실패:", err.message);
    res.status(500).json({ error: "링크 생성에 실패했어요. Supabase 연결 설정을 확인해주세요." });
  }
});

// ---------- 여러 링크 한 번에 등록 (한 줄에 "URL, 라벨" 형식) ----------
app.post("/api/links/bulk", async (req, res) => {
  const { items } = req.body; // [{ targetUrl, label }, ...]

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "등록할 항목이 없어요." });
  }

  const results = [];

  for (const item of items) {
    const targetUrl = (item.targetUrl || "").trim();
    const label = (item.label || "").trim();

    if (!targetUrl || !/^https?:\/\//.test(targetUrl)) {
      results.push({ ok: false, input: item, error: "올바르지 않은 URL" });
      continue;
    }

    try {
      const code = nanoid(7);
      await db.createLink({ code, label: label || "(라벨 없음)", targetUrl });
      results.push({
        ok: true,
        label,
        code,
        shortUrl: `${req.protocol}://${req.get("host")}/r/${code}`,
      });
    } catch (err) {
      results.push({ ok: false, input: item, error: err.message });
    }
  }

  res.json({
    total: items.length,
    success: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
});

// ---------- 링크 삭제 ----------
app.delete("/api/links/:code", async (req, res) => {
  try {
    await db.deleteLink(req.params.code);
    res.json({ ok: true });
  } catch (err) {
    console.error("링크 삭제 실패:", err.message);
    res.status(500).json({ error: "삭제에 실패했어요." });
  }
});

// ---------- 핵심: 클릭 발생 시 기록 후 실제 링크로 리다이렉트 ----------
app.get("/r/:code", async (req, res) => {
  const ua = req.get("user-agent") || "(없음)";

  try {
    const link = await db.getLinkByCode(req.params.code);

    if (!link) {
      console.log(`[클릭 실패-존재안함] code=${req.params.code} time=${new Date().toISOString()} ua=${ua}`);
      return res.status(404).send("존재하지 않는 링크입니다.");
    }

    if (isBotRequest(ua)) {
      console.log(`[봇-제외] code=${link.code} label=${link.label} time=${new Date().toISOString()} ua=${ua}`);
      return res.redirect(302, link.targetUrl);
    }

    console.log(`[클릭] code=${link.code} label=${link.label} time=${new Date().toISOString()} ua=${ua}`);
    await db.recordClick(link.code);

    res.redirect(302, link.targetUrl);
  } catch (err) {
    console.error("리다이렉트 처리 실패:", err.message);
    res.status(500).send("일시적인 오류가 발생했어요. 잠시 후 다시 시도해주세요.");
  }
});

app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: http://localhost:${PORT}`);
});
