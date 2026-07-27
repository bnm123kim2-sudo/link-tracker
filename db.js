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
