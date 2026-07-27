// Supabase(외부 DB)에 데이터를 저장/조회합니다.
// Render가 재배포/재시작되어도 여기 데이터는 절대 사라지지 않습니다.
//
// 필요한 환경변수 (Render 대시보드 Environment에 등록해야 함):
//   SUPABASE_URL          - Supabase 프로젝트 URL
//   SUPABASE_SECRET_KEY   - Supabase Secret key (구 service_role 키)

const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ SUPABASE_URL / SUPABASE_SECRET_KEY 환경변수가 설정되지 않았어요. Render Environment 탭에서 등록해주세요.");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ---------- 링크 목록 조회 (클릭수 포함) ----------
async function listLinks() {
  const { data: links, error: linksError } = await supabase
    .from("links")
    .select("*")
    .order("created_at", { ascending: false });

  if (linksError) throw linksError;

  const { data: clicks, error: clicksError } = await supabase
    .from("clicks")
    .select("link_code, clicked_at");

  if (clicksError) throw clicksError;

  return links.map((l) => {
    const linkClicks = clicks.filter((c) => c.link_code === l.code);
    const lastClick = linkClicks
      .map((c) => c.clicked_at)
      .sort()
      .pop();
    return {
      code: l.code,
      label: l.label,
      targetUrl: l.target_url,
      createdAt: l.created_at,
      clickCount: linkClicks.length,
      lastClickedAt: lastClick || null,
    };
  });
}

// ---------- 특정 코드로 링크 하나 조회 ----------
async function getLinkByCode(code) {
  const { data, error } = await supabase
    .from("links")
    .select("*")
    .eq("code", code)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { code: data.code, label: data.label, targetUrl: data.target_url };
}

// ---------- 새 링크 등록 ----------
async function createLink({ code, label, targetUrl }) {
  const { error } = await supabase
    .from("links")
    .insert({ code, label, target_url: targetUrl });

  if (error) throw error;
}

// ---------- 링크 삭제 ----------
async function deleteLink(code) {
  const { error } = await supabase.from("links").delete().eq("code", code);
  if (error) throw error;
}

// ---------- 클릭 기록 추가 ----------
async function recordClick(code) {
  const { error } = await supabase.from("clicks").insert({ link_code: code });
  if (error) throw error;
}

module.exports = { listLinks, getLinkByCode, createLink, deleteLink, recordClick };

// ================================================================
// 정산 엑셀(매출) 관련 기능
// ================================================================

// 한글/영문/숫자만 남기고 소문자화해서 비교하기 쉽게 정규화
function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// 상품명과 링크 라벨을 단어 단위로 겹치는 정도로 점수 매겨서 가장 비슷한 링크 찾기
// (완벽한 매칭은 아니고, "이 정도면 같은 상품일 확률이 높다"는 근사치예요)
function findBestMatchingLink(productName, links) {
  const productWords = new Set(normalize(productName).split(" ").filter((w) => w.length >= 2));
  if (productWords.size === 0) return null;

  let bestLink = null;
  let bestScore = 0;

  for (const link of links) {
    const labelWords = new Set(normalize(link.label).split(" ").filter((w) => w.length >= 2));
    if (labelWords.size === 0) continue;

    let overlap = 0;
    for (const w of productWords) {
      if (labelWords.has(w)) overlap++;
    }
    const score = overlap / Math.max(productWords.size, labelWords.size);

    if (score > bestScore) {
      bestScore = score;
      bestLink = link;
    }
  }

  // 겹치는 단어 비율이 너무 낮으면(전혀 다른 상품일 가능성) 매칭하지 않음
  const MATCH_THRESHOLD = 0.3;
  return bestScore >= MATCH_THRESHOLD ? bestLink : null;
}

// 파싱된 엑셀 행(rows)을 받아서 links와 매칭 후 sales 테이블에 저장
async function importSales(rows) {
  const { data: existingLinks, error: linksError } = await supabase.from("links").select("code, label");
  if (linksError) throw linksError;

  const toInsert = rows.map((row) => {
    const match = findBestMatchingLink(row.productName, existingLinks || []);
    return {
      product_name: row.productName,
      amount: row.amount,
      sale_date: row.saleDate || null,
      matched_link_code: match ? match.code : null,
    };
  });

  const { error } = await supabase.from("sales").insert(toInsert);
  if (error) throw error;

  return {
    total: toInsert.length,
    matched: toInsert.filter((r) => r.matched_link_code).length,
    unmatched: toInsert.filter((r) => !r.matched_link_code).length,
  };
}

// 링크별 매출 합계 + 매칭 안 된 판매건 목록
async function getSalesSummary() {
  const { data: sales, error } = await supabase.from("sales").select("*").order("imported_at", { ascending: false });
  if (error) throw error;

  const revenueByCode = {};
  const unmatched = [];

  for (const s of sales) {
    if (s.matched_link_code) {
      revenueByCode[s.matched_link_code] = (revenueByCode[s.matched_link_code] || 0) + Number(s.amount);
    } else {
      unmatched.push({
        id: s.id,
        productName: s.product_name,
        amount: s.amount,
        saleDate: s.sale_date,
      });
    }
  }

  return { revenueByCode, unmatched };
}

// 매칭 안 된 판매건을 수동으로 특정 링크에 연결
async function assignSaleToLink(saleId, code) {
  const { error } = await supabase.from("sales").update({ matched_link_code: code }).eq("id", saleId);
  if (error) throw error;
}

module.exports.importSales = importSales;
module.exports.getSalesSummary = getSalesSummary;
module.exports.assignSaleToLink = assignSaleToLink;
