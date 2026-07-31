// ------------------------------------------------------------
// 네이버 API 연동 모듈
// 1) 검색광고 API  -> 키워드별 월간 검색량 + 연관 키워드
// 2) 오픈API(블로그 검색) -> 키워드별 블로그 발행량(총 문서 수)
// 두 값을 합쳐서 경쟁지수(발행량÷검색량)를 계산합니다.
// ------------------------------------------------------------

const crypto = require("crypto");

const AD_API_BASE = "https://api.searchad.naver.com";
const OPEN_API_BASE = "https://openapi.naver.com";

function getEnv(name) {
  const v = process.env[name];
  if (!v) {
    const err = new Error(`환경변수 ${name} 가 설정되어 있지 않아요.`);
    err.missingEnv = name;
    throw err;
  }
  // Render 환경변수 입력 시 앞뒤로 공백/줄바꿈이 실수로 붙는 경우가 많아서 방어적으로 제거
  return v.trim();
}

function generateSignature(timestamp, method, uri, secretKey) {
  const message = `${timestamp}.${method}.${uri}`;
  return crypto.createHmac("sha256", secretKey).update(message).digest("base64");
}

// "< 10" 같은 문자열로 오는 경우가 있어서 숫자로 못 바꾸면 대략치(5)로 취급
function parseCount(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.includes("<")) return 5;
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------- 네이버 검색광고 API: 키워드 목록(최대 5개)의 검색량+연관어 조회 ----------
async function fetchSearchVolumes(keywords) {
  const API_KEY = getEnv("NAVER_AD_API_KEY");
  const SECRET_KEY = getEnv("NAVER_AD_SECRET_KEY");
  const CUSTOMER_ID = getEnv("NAVER_AD_CUSTOMER_ID");

  const uri = "/keywordstool";
  const method = "GET";
  const timestamp = Date.now().toString();
  const signature = generateSignature(timestamp, method, uri, SECRET_KEY);

  const hintKeywords = keywords.map((k) => k.replace(/\s+/g, "")).join(",");
  const url = `${AD_API_BASE}${uri}?hintKeywords=${encodeURIComponent(hintKeywords)}&showDetail=1`;

  const res = await fetch(url, {
    headers: {
      "X-Timestamp": timestamp,
      "X-API-KEY": API_KEY,
      "X-Customer": CUSTOMER_ID,
      "X-Signature": signature,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`네이버 검색광고 API 오류 (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.keywordList || [];
}

// ---------- 네이버 오픈API: 블로그 검색 결과 수(발행량) 조회 ----------
async function fetchBlogPostCount(keyword) {
  const CLIENT_ID = getEnv("NAVER_CLIENT_ID");
  const CLIENT_SECRET = getEnv("NAVER_CLIENT_SECRET");

  const url = `${OPEN_API_BASE}/v1/search/blog.json?query=${encodeURIComponent(keyword)}&display=1`;
  const res = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": CLIENT_ID,
      "X-Naver-Client-Secret": CLIENT_SECRET,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`네이버 블로그 검색 API 오류 (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return typeof data.total === "number" ? data.total : 0;
}

// ---------- 시드 키워드로 연관 키워드 후보 뽑기 ----------
async function fetchRelatedCandidates(seedKeyword, limit = 25) {
  const list = await fetchSearchVolumes([seedKeyword]);

  const candidates = list
    .map((item) => ({
      keyword: item.relKeyword,
      searchVolume: parseCount(item.monthlyPcQcCnt) + parseCount(item.monthlyMobileQcCnt),
    }))
    .filter((c) => c.keyword && c.searchVolume > 0)
    .sort((a, b) => b.searchVolume - a.searchVolume)
    .slice(0, limit)
    .map((c) => c.keyword);

  const seedNorm = seedKeyword.replace(/\s+/g, "");
  if (!candidates.some((k) => k.replace(/\s+/g, "") === seedNorm)) {
    candidates.unshift(seedKeyword);
  }

  return candidates;
}

// ---------- 후보 키워드 목록 -> 검색량+발행량+경쟁지수 한번에 계산 ----------
async function analyzeKeywords(keywords) {
  const normalized = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))];
  if (normalized.length === 0) return [];

  // 1) 검색량: 검색광고 API는 한 번에 최대 5개까지만 조회 가능해서 배치 처리
  const volumeMap = new Map();
  for (const batch of chunk(normalized, 5)) {
    const list = await fetchSearchVolumes(batch);
    for (const target of batch) {
      const targetNorm = target.replace(/\s+/g, "");
      const match = list.find((item) => (item.relKeyword || "").replace(/\s+/g, "") === targetNorm);
      if (match) {
        volumeMap.set(target, parseCount(match.monthlyPcQcCnt) + parseCount(match.monthlyMobileQcCnt));
      } else {
        volumeMap.set(target, 0);
      }
    }
  }

  // 2) 발행량: 오픈API는 키워드별로 개별 호출 (배치 기능 없음)
  const results = [];
  for (const keyword of normalized) {
    const searchVolume = volumeMap.get(keyword) || 0;
    let postCount = null;
    try {
      postCount = await fetchBlogPostCount(keyword);
    } catch (err) {
      postCount = null;
    }

    let competitiveIndex = null;
    let isGoldenZone = false;
    if (searchVolume > 0 && postCount !== null) {
      competitiveIndex = postCount / searchVolume;
      isGoldenZone = competitiveIndex >= 1 / 7 && competitiveIndex <= 1 / 3;
    }

    results.push({ keyword, searchVolume, postCount, competitiveIndex, isGoldenZone });
  }

  // 경쟁지수 낮은 순(유리한 순) 정렬. 계산 불가한 항목은 맨 뒤로.
  results.sort((a, b) => {
    if (a.competitiveIndex === null && b.competitiveIndex === null) return 0;
    if (a.competitiveIndex === null) return 1;
    if (b.competitiveIndex === null) return -1;
    return a.competitiveIndex - b.competitiveIndex;
  });

  return results;
}

module.exports = { analyzeKeywords, fetchRelatedCandidates };
