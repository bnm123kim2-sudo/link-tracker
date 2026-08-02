// ------------------------------------------------------------
// 네이버 API 연동 모듈
// 1) 검색광고 API  -> 키워드별 월간 검색량 + 연관 키워드
// 2) 오픈API(블로그 검색) -> 키워드별 블로그 발행량(총 문서 수)
// 두 값을 합쳐서 경쟁지수(발행량÷검색량)를 계산합니다.
// ------------------------------------------------------------

const crypto = require("crypto");

const AD_API_BASE = "https://api.searchad.naver.com";
const OPEN_API_BASE = "https://naverapihub.apigw.ntruss.com";

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

// 네이버 검색광고 API는 초당 3회 권장이라, 연속 호출 사이에 약간의 딜레이를 줌
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// "< 10" 같은 문자열로 오는 경우가 있어서 숫자로 못 바꾸면 대략치(5)로 취급
function parseCount(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.includes("<")) return 5;
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

// 경쟁지수 구간에 따라 등급을 매김 (선생님 기준: 낮을수록 유리)
// ※ 절대 기준이라 "블루마운틴", "오사카" 같이 오래된 유명 관광지 키워드는
//   발행량이 몇 년치 누적돼서 전부 레드오션으로 나오는 문제가 있음.
//   그래서 이건 보조 지표로만 쓰고, 메인 등급은 아래 relativeGradeFromRank로 매김.
function gradeFromIndex(competitiveIndex) {
  if (competitiveIndex === null) return { grade: "unknown", label: "조회불가" };
  if (competitiveIndex < 1 / 7) return { grade: "ultra", label: "초저경쟁" };
  if (competitiveIndex <= 1 / 3) return { grade: "gold", label: "골드" };
  if (competitiveIndex <= 1.0) return { grade: "good", label: "양호" };
  if (competitiveIndex <= 3.0) return { grade: "normal", label: "보통" };
  return { grade: "red", label: "레드오션" };
}

// 이번 분석 배치 안에서의 상대 순위 기준 등급.
// rank는 0부터 시작(0이 가장 유리), total은 경쟁지수 계산 가능한 키워드 총 개수.
// 카테고리(국내 소도시 투어 vs 해외 유명 관광지)마다 절대 지수 분포가 완전히 달라서
// "이번에 뽑은 후보들 중 상대적으로 어디쯤인지"가 실전에서 더 쓸모 있음.
function relativeGradeFromRank(rank, total) {
  if (rank === null || total === 0) return { grade: "unknown", label: "조회불가" };
  const percentile = total <= 1 ? 0 : rank / (total - 1);
  if (percentile <= 0.2) return { grade: "ultra", label: "초저경쟁" };
  if (percentile <= 0.4) return { grade: "gold", label: "골드" };
  if (percentile <= 0.6) return { grade: "good", label: "양호" };
  if (percentile <= 0.8) return { grade: "normal", label: "보통" };
  return { grade: "red", label: "레드오션" };
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------- 네이버 검색광고 API: 키워드 목록(최대 5개)의 검색량+연관어 조회 ----------
async function fetchSearchVolumes(keywords, retriesLeft = 3) {
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

  if (res.status === 429 && retriesLeft > 0) {
    // 초당 3회 권장 제한에 걸렸을 때: 잠깐 기다렸다가 재시도 (1.5초 → 3초 → 6초)
    const waitMs = 1500 * 2 ** (3 - retriesLeft);
    await sleep(waitMs);
    return fetchSearchVolumes(keywords, retriesLeft - 1);
  }

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

  const url = `${OPEN_API_BASE}/search/v1/blog?query=${encodeURIComponent(keyword)}&display=1`;
  const res = await fetch(url, {
    headers: {
      "X-NCP-APIGW-API-KEY-ID": CLIENT_ID,
      "X-NCP-APIGW-API-KEY": CLIENT_SECRET,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`네이버 블로그 검색 API 오류 (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return typeof data.total === "number" ? data.total : 0;
}

// 숙소/투어 후기 블로그에서 흔히 쓰는 롱테일 접미사 기본값.
// "더풀러턴호텔시드니"처럼 브랜드명이 좁은 시드 키워드는 검색광고 연관키워드 API가
// (같은 업종의 다른 브랜드 호텔들만 추천하고) 이런 접미사 조합은 잘 안 뽑아주기 때문에
// 시드 키워드 뒤에 자동으로 붙여서 함께 분석함.
const DEFAULT_LONGTAIL_SUFFIXES = [
  "가격", "위치", "주차", "조식", "수영장", "와이파이",
  "후기", "예약", "할인", "가는법", "전망", "체크인",
];

function buildLongtailCandidates(seedKeyword, suffixes) {
  const base = seedKeyword.trim();
  return suffixes.map((suf) => `${base} ${suf}`);
}

// ---------- 시드 키워드로 연관 키워드 후보 뽑기 ----------
// 1) 시드 키워드 자체
// 2) 시드 + 롱테일 접미사 자동 조합 (브랜드성 키워드 대응)
// 3) 검색광고 API의 연관키워드 추천 (볼륨 큰 순)
// 이 셋을 합쳐서 중복 제거 후 반환. 접미사 조합은 항상 포함시켜 롱테일이 누락되지 않게 함.
async function fetchRelatedCandidates(seedKeyword, limit = 15, options = {}) {
  const { includeLongtail = true, longtailSuffixes = DEFAULT_LONGTAIL_SUFFIXES } = options;

  const list = await fetchSearchVolumes([seedKeyword]);
  await sleep(400);

  const apiCandidates = list
    .map((item) => ({
      keyword: item.relKeyword,
      searchVolume: parseCount(item.monthlyPcQcCnt) + parseCount(item.monthlyMobileQcCnt),
    }))
    .filter((c) => c.keyword && c.searchVolume > 0)
    .sort((a, b) => b.searchVolume - a.searchVolume)
    .slice(0, limit)
    .map((c) => c.keyword);

  const longtailCandidates = includeLongtail
    ? buildLongtailCandidates(seedKeyword, longtailSuffixes)
    : [];

  const seen = new Set();
  const merged = [];
  const pushUnique = (k) => {
    const norm = k.replace(/\s+/g, "");
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      merged.push(k);
    }
  };

  pushUnique(seedKeyword);
  for (const k of longtailCandidates) pushUnique(k);
  for (const k of apiCandidates) pushUnique(k);

  return merged;
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
    // 검색광고 API 초당 3회 권장 제한을 지키기 위한 최소 간격
    await sleep(400);
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

    // absoluteGrade: 기존 절대 기준 (참고용 보조 지표로만 사용)
    const { grade: absoluteGrade, label: absoluteGradeLabel } = gradeFromIndex(competitiveIndex);

    results.push({
      keyword,
      searchVolume,
      postCount,
      competitiveIndex,
      isGoldenZone,
      absoluteGrade,
      absoluteGradeLabel,
    });
  }

  // 경쟁지수 낮은 순(유리한 순) 정렬. 계산 불가한 항목은 맨 뒤로.
  results.sort((a, b) => {
    if (a.competitiveIndex === null && b.competitiveIndex === null) return 0;
    if (a.competitiveIndex === null) return 1;
    if (b.competitiveIndex === null) return -1;
    return a.competitiveIndex - b.competitiveIndex;
  });

  // 상대 등급(이번 배치 안에서의 순위 기준) 부여.
  // 정렬 후 순서대로 매기되, competitiveIndex가 null인 항목(조회불가)은 순위 계산에서 제외.
  const validCount = results.filter((r) => r.competitiveIndex !== null).length;
  let rankCursor = 0;
  for (const r of results) {
    if (r.competitiveIndex === null) {
      r.rank = null;
      r.totalRanked = validCount;
      r.grade = "unknown";
      r.gradeLabel = "조회불가";
      continue;
    }
    const { grade, label: gradeLabel } = relativeGradeFromRank(rankCursor, validCount);
    r.rank = rankCursor + 1; // 1위부터 표시
    r.totalRanked = validCount;
    r.grade = grade; // 메인으로 노출할 등급 = 상대 등급
    r.gradeLabel = gradeLabel;
    rankCursor += 1;
  }

  return results;
}

// ---------- 디버깅용: 서명 요청 내역 + 응답 전체를 그대로 확인 ----------
async function debugSignatureTest(testKeyword) {
  const API_KEY = getEnv("NAVER_AD_API_KEY");
  const SECRET_KEY = getEnv("NAVER_AD_SECRET_KEY");
  const CUSTOMER_ID = getEnv("NAVER_AD_CUSTOMER_ID");

  const uri = "/keywordstool";
  const method = "GET";
  const timestamp = Date.now().toString();
  const message = `${timestamp}.${method}.${uri}`;
  const signature = generateSignature(timestamp, method, uri, SECRET_KEY);

  const url = `${AD_API_BASE}${uri}?hintKeywords=${encodeURIComponent(testKeyword)}&showDetail=1`;

  const res = await fetch(url, {
    headers: {
      "X-Timestamp": timestamp,
      "X-API-KEY": API_KEY,
      "X-Customer": CUSTOMER_ID,
      "X-Signature": signature,
    },
  });

  const bodyText = await res.text();

  return {
    serverTimeISO: new Date().toISOString(),
    requestedUrl: url,
    message, // 타임스탬프+메서드+uri 조합, 비밀값 아님
    signaturePreview: `${signature.slice(0, 6)}...${signature.slice(-6)}`,
    customerIdUsed: CUSTOMER_ID,
    apiKeyPreview: `${API_KEY.slice(0, 6)}...${API_KEY.slice(-6)}`,
    upstreamStatus: res.status,
    upstreamBody: bodyText,
  };
}

// ---------- 디버깅용: 블로그 검색 API 요청/응답 전체 확인 ----------
async function debugBlogTest(testKeyword) {
  const CLIENT_ID = getEnv("NAVER_CLIENT_ID");
  const CLIENT_SECRET = getEnv("NAVER_CLIENT_SECRET");

  const url = `${OPEN_API_BASE}/search/v1/blog?query=${encodeURIComponent(testKeyword)}&display=1`;
  const res = await fetch(url, {
    headers: {
      "X-NCP-APIGW-API-KEY-ID": CLIENT_ID,
      "X-NCP-APIGW-API-KEY": CLIENT_SECRET,
    },
  });

  const bodyText = await res.text();

  return {
    requestedUrl: url,
    clientIdPreview: `${CLIENT_ID.slice(0, 3)}...${CLIENT_ID.slice(-3)}`,
    upstreamStatus: res.status,
    upstreamBody: bodyText,
  };
}

module.exports = {
  analyzeKeywords,
  fetchRelatedCandidates,
  debugSignatureTest,
  debugBlogTest,
  DEFAULT_LONGTAIL_SUFFIXES,
};
